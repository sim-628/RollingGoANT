import { createServer, setGlobalProxyFromEnv } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { UPSTREAM, MAX_BODY_BYTES, HttpError, envelope, redact, validateLines, validateOrder, moneyUnits, checkFinalQuote, routeFor, buildQuery, parseUpstream } from './gateway-core.mjs';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'");
}

function sendJson(res, status, body, apiKey) {
  const data = JSON.stringify(redact(body, apiKey));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

async function readJson(req, maxBytes) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'CONTENT_TYPE', '请使用 application/json 请求');
  }
  if (Number(req.headers['content-length'] || 0) > maxBytes) {
    req.resume();
    throw new HttpError(413, 'BODY_TOO_LARGE', '请求内容过大');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'BODY_TOO_LARGE', '请求内容过大');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'INVALID_JSON', '请求内容不是有效 JSON'); }
}

async function serveStatic(req, res, pathname, staticDir) {
  if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持此请求方式');
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some((segment) => segment.startsWith('.'))) {
    throw new HttpError(404, 'NOT_FOUND', '页面不存在');
  }
  const base = await realpath(staticDir).catch(() => null);
  if (!base) throw new HttpError(503, 'BUILD_MISSING', '网站尚未构建，请运行 npm run build');
  let file = resolve(base, `.${decoded}`);
  if (file !== base && !file.startsWith(base + sep)) throw new HttpError(404, 'NOT_FOUND', '页面不存在');
  let info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    if (extname(decoded)) throw new HttpError(404, 'NOT_FOUND', '文件不存在');
    file = resolve(base, 'index.html');
    info = await stat(file).catch(() => null);
  }
  const actual = await realpath(file).catch(() => null);
  if (!info?.isFile() || !actual?.startsWith(base + sep)) throw new HttpError(404, 'NOT_FOUND', '页面不存在');
  const content = await readFile(actual);
  res.writeHead(200, {
    'Content-Type': MIME[extname(actual)] || 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': extname(actual) === '.html' ? 'no-cache' : decoded.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
  });
  res.end(req.method === 'HEAD' ? undefined : content);
}

/** Same-origin API gateway. Tests inject fetchImpl rather than contact suppliers. */
export function createAppServer(options = {}) {
  const env = options.env || process.env;
  const apiKey = env.DIDA_API_KEY || '';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const staticDir = options.staticDir === false ? false : resolve(options.staticDir || resolve(ROOT, 'dist/client'));
  const rateMax = options.rateLimit ?? 180;
  const rateWindow = options.rateWindowMs ?? 60_000;
  const now = options.now || Date.now;
  const rateBuckets = new Map();
  const cache = new Map();
  const maxBodyBytes = options.maxBodyBytes || MAX_BODY_BYTES;
  const timeoutMs = options.timeoutMs || 15_000;

  function rateCheck(req) {
    const ip = req.socket.remoteAddress || 'unknown';
    const time = now();
    if (rateBuckets.size > 2000) for (const [key, bucket] of rateBuckets) if (bucket.expires <= time) rateBuckets.delete(key);
    for (const [key, limit] of [[ip, rateMax], ...(req.method === 'POST' ? [[`${ip}:write`, 20]] : [])]) {
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
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: response.status, data: await parseUpstream(response) };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new HttpError(timeout ? 504 : 502, timeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE', timeout ? '供应商响应超时，请稍后重试' : '暂时无法连接供应商，请稍后重试');
    }
  }

  const server = createServer(async (req, res) => {
    securityHeaders(res);
    try {
      // Parse raw segments first: URL normalisation must not hide traversal.
      const rawPath = (req.url || '/').split('?')[0];
      let decodedRaw;
      try { decodedRaw = decodeURIComponent(rawPath); } catch { throw new HttpError(400, 'INVALID_PATH', '请求路径格式不正确'); }
      if (decodedRaw.includes('\0') || decodedRaw.includes('\\') || decodedRaw.split('/').includes('..')) throw new HttpError(404, 'NOT_FOUND', '页面不存在');
      const url = new URL(req.url || '/', 'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        if (!staticDir) throw new HttpError(404, 'NOT_FOUND', '页面不存在');
        await serveStatic(req, res, url.pathname, staticDir);
        return;
      }
      if (url.pathname === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, { success: true, data: { service: 'rollinggo-ant', configured: Boolean(apiKey), order_mode: 'validate' } }, apiKey);
        return;
      }
      rateCheck(req);
      const route = routeFor(url.pathname);
      if (!route) throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      if (req.method !== route.method) { res.setHeader('Allow', route.method); throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持此请求方式'); }
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        let originHost;
        if (origin) { try { originHost = new URL(origin).host; } catch { throw new HttpError(403, 'ORIGIN_BLOCKED', '请求来源不受支持'); } }
        if ((origin && originHost !== req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') {
          throw new HttpError(403, 'ORIGIN_BLOCKED', '请求来源不受支持');
        }
        if (url.search) throw new HttpError(400, 'INVALID_QUERY', '此接口不接受查询参数');
      }
      const query = req.method === 'GET' ? buildQuery(route, url.searchParams) : '';
      if (!apiKey) throw new HttpError(503, 'API_NOT_CONFIGURED', '商品服务尚未连接，请联系管理员配置 Dida API');
      if (req.method === 'GET') {
        const cacheKey = `${route.path}?${query}`;
        const cached = cache.get(cacheKey);
        if (cached && cached.expires > now()) { sendJson(res, cached.status, cached.data, apiKey); return; }
        const result = await upstream(route.path, 'GET', query);
        if (result.status === 200 && result.data.success && route.ttl) {
          if (cache.size >= 500) cache.delete(cache.keys().next().value);
          cache.set(cacheKey, { ...result, expires: now() + route.ttl });
        }
        sendJson(res, result.status, result.data, apiKey);
        return;
      }
      const body = await readJson(req, maxBodyBytes);
      if (route.path === '/availability-check') validateLines(body); else validateOrder(body);
      const expectedCurrency = !Array.isArray(body) ? body.expected_currency : undefined;
      const expectedTotal = !Array.isArray(body) ? body.expected_total : undefined;
      if (expectedCurrency !== undefined && (typeof expectedCurrency !== 'string' || !/^[A-Z]{3}$/.test(expectedCurrency))) {
        throw new HttpError(400, 'INVALID_BODY', '确认报价的货币格式不正确');
      }
      if (expectedTotal !== undefined && moneyUnits(expectedTotal) === null) {
        throw new HttpError(400, 'INVALID_BODY', '确认报价的总额格式不正确');
      }
      // This gateway-only metadata is never part of the supplier order schema.
      const supplierBody = Array.isArray(body) ? body : { ...body };
      if (!Array.isArray(supplierBody)) {
        delete supplierBody.expected_currency;
        delete supplierBody.expected_total;
      }
      if (route.path !== '/orders') {
        const result = await upstream(route.path, 'POST', '', supplierBody);
        sendJson(res, result.status, result.data, apiKey);
        return;
      }
      const validation = await upstream('/orders/validate', 'POST', '', supplierBody);
      if (validation.status !== 200 || !validation.data.success || validation.data.data?.valid !== true) {
        sendJson(res, validation.status === 200 ? 422 : validation.status, validation.data.success
          ? envelope(422, 'ORDER_NOT_VALID', '预订信息尚未通过验证，请检查后重试') : validation.data, apiKey);
        return;
      }
      const quote = validation.data.data.quote;
      if (checkFinalQuote(quote, supplierBody.items).changed || (expectedCurrency && expectedCurrency !== quote.currency)
        || (expectedTotal !== undefined && moneyUnits(expectedTotal) !== moneyUnits(quote.total_amount))) {
        sendJson(res, 409, { success: false, error: {
          code: 'PRICE_CHANGED', status: 409,
          message: '价格已更新，请核对新的报价后再次确认预订', quote,
        } }, apiKey);
        return;
      }
      sendJson(res, 200, { success: true, data: {
        mode: 'validated', draft_id: `ANT-${randomUUID()}`, quote,
        message: '预订信息已确认。此演示未创建订单或发起支付，下一步由 RollingGo 现有收银台接续。',
      } }, apiKey);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const known = error instanceof HttpError;
      const status = known ? error.status : 500;
      if (status === 429) res.setHeader('Retry-After', Math.ceil(rateWindow / 1000));
      sendJson(res, status, envelope(status, known ? error.code : 'INTERNAL_ERROR', known ? error.message : '服务暂时不可用，请稍后重试'), apiKey);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // Node 24.5+ honours the cloud's inherited proxy without bypassing TLS trust.
  setGlobalProxyFromEnv();
  const port = Number(process.env.ANT_API_PORT || process.env.PORT || 3000);
  const host = process.env.ANT_HOST || '0.0.0.0';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');
  const server = createAppServer();
  server.listen(port, host, () => console.log(`RollingGo ANT listening on port ${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
}
