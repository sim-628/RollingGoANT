import {
  UPSTREAM, MAX_BODY_BYTES, HttpError, envelope, redact, validateLines,
  validateOrder, moneyUnits, checkFinalQuote, routeFor, buildQuery, parseUpstream,
} from './gateway-core.mjs';

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
};

async function readJson(request, maxBytes) {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'CONTENT_TYPE', '请使用 application/json 请求');
  }
  if (Number(request.headers.get('content-length') || 0) > maxBytes) {
    await request.body?.cancel();
    throw new HttpError(413, 'BODY_TOO_LARGE', '请求内容过大');
  }
  const reader = request.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, 'BODY_TOO_LARGE', '请求内容过大');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new HttpError(400, 'INVALID_JSON', '请求内容不是有效 JSON'); }
}

/** Web-standard transport, with the same supplier contract as the Node gateway. */
export function createWorkerGateway(options = {}) {
  const apiKey = options.env?.DIDA_API_KEY || '';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const rateMax = options.rateLimit ?? 180;
  const rateWindow = options.rateWindowMs ?? 60_000;
  const rateBuckets = new Map();
  const cache = new Map();
  const maxBodyBytes = options.maxBodyBytes || MAX_BODY_BYTES;
  const timeoutMs = options.timeoutMs || 15_000;

  function json(status, body, extras = {}) {
    return new Response(JSON.stringify(redact(body, apiKey)), {
      status,
      headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extras },
    });
  }

  function rateCheck(request) {
    // Cloudflare supplies this header. Never trust caller-controlled forwarded IPs.
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const time = now();
    if (rateBuckets.size > 2000) for (const [key, bucket] of rateBuckets) if (bucket.expires <= time) rateBuckets.delete(key);
    for (const [key, limit] of [[ip, rateMax], ...(request.method === 'POST' ? [[`${ip}:write`, 20]] : [])]) {
      let bucket = rateBuckets.get(key);
      if (!bucket || bucket.expires <= time) { bucket = { count: 0, expires: time + rateWindow }; rateBuckets.set(key, bucket); }
      if (++bucket.count > limit) throw new HttpError(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试');
    }
  }

  async function upstream(path, method, query = '', body) {
    try {
      const response = await fetchImpl(`${UPSTREAM}${path}${query ? `?${query}` : ''}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'Accept-Language': 'zh-CN', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // Workers supports manual/follow only. Manual keeps credentials on the
        // fixed supplier origin, and every redirect is explicitly refused.
        redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new HttpError(502, 'UPSTREAM_REDIRECT', '供应商返回了不受支持的跳转，请稍后重试');
      }
      return { status: response.status, data: await parseUpstream(response) };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // Operational diagnostics contain no request body, headers or credential.
      console.error(JSON.stringify({ event: 'supplier_transport_failure', path,
        kind: String(error?.name || 'Error'), detail: redact(String(error?.message || 'Unknown failure'), apiKey) }));
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new HttpError(timeout ? 504 : 502, timeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE', timeout ? '供应商响应超时，请稍后重试' : '暂时无法连接供应商，请稍后重试');
    }
  }

  return async function fetch(request) {
    try {
      const url = new URL(request.url);
      let decoded;
      try { decoded = decodeURIComponent(url.pathname); }
      catch { throw new HttpError(400, 'INVALID_PATH', '请求路径格式不正确'); }
      if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(s => s === '..' || s.startsWith('.'))) throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return json(200, { success: true, data: { service: 'rollinggo-ant', configured: Boolean(apiKey), order_mode: 'validate' } });
      }
      rateCheck(request);
      const route = routeFor(url.pathname);
      if (!route) throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      if (request.method !== route.method) return json(405, envelope(405, 'METHOD_NOT_ALLOWED', '不支持此请求方式'), { Allow: route.method });
      if (request.method === 'POST') {
        const origin = request.headers.get('origin');
        if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
          throw new HttpError(403, 'ORIGIN_BLOCKED', '请求来源不受支持');
        }
        if (url.search) throw new HttpError(400, 'INVALID_QUERY', '此接口不接受查询参数');
      }
      const query = request.method === 'GET' ? buildQuery(route, url.searchParams) : '';
      if (!apiKey) throw new HttpError(503, 'API_NOT_CONFIGURED', '商品服务尚未连接，请联系管理员配置 Dida API');
      if (request.method === 'GET') {
        const cacheKey = `${route.path}?${query}`;
        const cached = cache.get(cacheKey);
        if (cached && cached.expires > now()) return json(cached.status, cached.data);
        const result = await upstream(route.path, 'GET', query);
        if (result.status === 200 && result.data.success && route.ttl) {
          if (cache.size >= 500) cache.delete(cache.keys().next().value);
          cache.set(cacheKey, { ...result, expires: now() + route.ttl });
        }
        return json(result.status, result.data);
      }
      const body = await readJson(request, maxBodyBytes);
      if (route.path === '/availability-check') validateLines(body); else validateOrder(body);
      const expectedCurrency = !Array.isArray(body) ? body.expected_currency : undefined;
      const expectedTotal = !Array.isArray(body) ? body.expected_total : undefined;
      if (expectedCurrency !== undefined && (typeof expectedCurrency !== 'string' || !/^[A-Z]{3}$/.test(expectedCurrency))) throw new HttpError(400, 'INVALID_BODY', '确认报价的货币格式不正确');
      if (expectedTotal !== undefined && moneyUnits(expectedTotal) === null) throw new HttpError(400, 'INVALID_BODY', '确认报价的总额格式不正确');
      const supplierBody = Array.isArray(body) ? body : { ...body };
      if (!Array.isArray(supplierBody)) { delete supplierBody.expected_currency; delete supplierBody.expected_total; }
      if (route.path !== '/orders') {
        const result = await upstream(route.path, 'POST', '', supplierBody);
        return json(result.status, result.data);
      }
      // Hard boundary: /api/orders may only call the supplier validation endpoint.
      const validation = await upstream('/orders/validate', 'POST', '', supplierBody);
      if (validation.status !== 200 || !validation.data.success || validation.data.data?.valid !== true) {
        return json(validation.status === 200 ? 422 : validation.status, validation.data.success ? envelope(422, 'ORDER_NOT_VALID', '预订信息尚未通过验证，请检查后重试') : validation.data);
      }
      const quote = validation.data.data.quote;
      if (checkFinalQuote(quote, supplierBody.items).changed || (expectedCurrency && expectedCurrency !== quote.currency) || (expectedTotal !== undefined && moneyUnits(expectedTotal) !== moneyUnits(quote.total_amount))) {
        return json(409, { success: false, error: { code: 'PRICE_CHANGED', status: 409, message: '价格已更新，请核对新的报价后再次确认预订', quote } });
      }
      return json(200, { success: true, data: { mode: 'validated', draft_id: `ANT-${crypto.randomUUID()}`, quote, message: '预订信息已确认。此演示未创建订单或发起支付。' } });
    } catch (error) {
      const known = error instanceof HttpError;
      const status = known ? error.status : 500;
      return json(status, envelope(status, known ? error.code : 'INTERNAL_ERROR', known ? error.message : '服务暂时不可用，请稍后重试'), status === 429 ? { 'Retry-After': String(Math.ceil(rateWindow / 1000)) } : {});
    }
  };
}

// Retain isolate limits even if the platform recreates its env wrapper per call.
// A secret rotation discards the old gateway and its cache immediately.
let gatewayState;
export default {
  async fetch(request, env = {}) {
    if (!gatewayState || gatewayState.key !== env.DIDA_API_KEY) {
      gatewayState = { key: env.DIDA_API_KEY, fetch: createWorkerGateway({ env }) };
    }
    return gatewayState.fetch(request);
  },
};
