import { createServer, setGlobalProxyFromEnv } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const UPSTREAM = 'https://didatickettest.wysiwysi.com/api/distribution/v1';
const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const MAX_BODY_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function envelope(status, code, message) {
  return { success: false, error: { code, status, message } };
}

function redact(value, apiKey) {
  if (typeof value === 'string') return apiKey ? value.split(apiKey).join('[redacted]') : value;
  if (Array.isArray(value)) return value.map((item) => redact(item, apiKey));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /^(authorization|api[_-]?key|access[_-]?token|secret|password)$/i.test(key)
        ? '[redacted]' : redact(item, apiKey),
    ]));
  }
  return value;
}

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

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function stringField(value, name, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new HttpError(400, 'INVALID_BODY', `${name} 必须填写有效文本`);
  }
}

function validateLines(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 20) {
    throw new HttpError(400, 'INVALID_BODY', '请选择 1 至 20 个套餐');
  }
  for (const line of lines) {
    if (!isObject(line)) throw new HttpError(400, 'INVALID_BODY', '套餐信息格式不正确');
    stringField(line.package_code, 'package_code', 128);
    stringField(line.start_time, 'start_time', 19);
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(line.start_time)) {
      throw new HttpError(400, 'INVALID_BODY', '出行时间须为 yyyy-MM-dd HH:mm:ss');
    }
    if (!Array.isArray(line.sku_list) || !line.sku_list.length || line.sku_list.length > 20) {
      throw new HttpError(400, 'INVALID_BODY', '请选择有效的预订人数');
    }
    for (const sku of line.sku_list) {
      if (!isObject(sku)) throw new HttpError(400, 'INVALID_BODY', 'SKU 信息格式不正确');
      stringField(sku.sku_code, 'sku_code', 128);
      if (!Number.isInteger(sku.count) || sku.count < 1 || sku.count > 99) {
        throw new HttpError(400, 'INVALID_BODY', '每个人群数量须为 1 至 99');
      }
      for (const field of ['price', 'acceptable_price']) {
        if (sku[field] !== undefined && (typeof sku[field] !== 'string' || !/^\d+(?:\.\d{1,4})?$/.test(sku[field]))) {
          throw new HttpError(400, 'INVALID_BODY', '价格格式不正确');
        }
      }
    }
    for (const field of ['booking_extra_info', 'unit_extra_info']) {
      if (line[field] !== undefined && (!Array.isArray(line[field]) || line[field].length > 100 || line[field].some((item) => !isObject(item)))) {
        throw new HttpError(400, 'INVALID_BODY', '附加预订信息格式不正确');
      }
    }
  }
}

function validateOrder(body) {
  if (!isObject(body)) throw new HttpError(400, 'INVALID_BODY', '订单信息须为 JSON 对象');
  stringField(body.agent_order_code, 'agent_order_code', 64);
  if (!isObject(body.contact_info)) throw new HttpError(400, 'INVALID_BODY', '请填写预订联系人');
  for (const field of ['first_name', 'family_name', 'mobile']) stringField(body.contact_info[field], field);
  if (!/^\d{1,4}-[1-9]\d{4,17}$/.test(body.contact_info.mobile)) {
    throw new HttpError(400, 'INVALID_BODY', '手机号须包含国家区号，例如 86-13800000000');
  }
  for (const field of ['title', 'email', 'country']) {
    if (body.contact_info[field] !== undefined && body.contact_info[field] !== '') stringField(body.contact_info[field], field);
  }
  if (body.timestamp !== undefined && (!Number.isSafeInteger(body.timestamp) || body.timestamp < 0)) {
    throw new HttpError(400, 'INVALID_BODY', 'timestamp 须为 Unix 秒数');
  }
  validateLines(body.items);
}

// Four decimal places are represented as integers so price comparisons never
// rely on floating-point rounding. Values come from the supplier's string API.
function moneyUnits(value) {
  if (typeof value !== 'string' || !/^\d{1,18}(?:\.\d{1,4})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
}

function checkFinalQuote(quote, items) {
  const invalid = () => { throw new HttpError(502, 'INVALID_QUOTE', '供应商报价暂时无法确认，请稍后重试'); };
  if (!isObject(quote) || typeof quote.currency !== 'string' || !/^[A-Z]{3}$/.test(quote.currency) || moneyUnits(quote.total_amount) === null || !Array.isArray(quote.items) || !quote.items.length || quote.items.length > 20) invalid();
  const expected = new Map();
  const actual = new Map();
  let expectedTotal = 0n;
  let actualTotal = 0n;
  function add(map, key, count, amount) {
    const prev = map.get(key) || { count: 0, amount: 0n };
    map.set(key, { count: prev.count + count, amount: prev.amount + amount });
  }
  for (const item of items) {
    for (const sku of item.sku_list) {
      const price = moneyUnits(sku.acceptable_price);
      if (price === null) throw new HttpError(400, 'PRICE_CONFIRMATION_REQUIRED', '请先确认当前商品价格再提交预订');
      const amount = price * BigInt(sku.count);
      expectedTotal += amount;
      add(expected, JSON.stringify([item.package_code, item.start_time, sku.sku_code]), sku.count, amount);
    }
  }
  for (const item of quote.items) {
    if (!isObject(item) || typeof item.package_code !== 'string' || typeof item.start_time !== 'string' || !Array.isArray(item.sku_list) || !item.sku_list.length || item.sku_list.length > 20 || (item.currency !== undefined && item.currency !== quote.currency)) invalid();
    let itemTotal = 0n;
    for (const sku of item.sku_list) {
      if (!isObject(sku) || typeof sku.sku_code !== 'string' || !Number.isSafeInteger(sku.count) || sku.count < 1 || sku.count > 39_600 || moneyUnits(sku.selling_unit_price) === null) invalid();
      const amount = moneyUnits(sku.selling_unit_price) * BigInt(sku.count);
      itemTotal += amount;
      add(actual, JSON.stringify([item.package_code, item.start_time, sku.sku_code]), sku.count, amount);
    }
    if (item.selling_total !== undefined && moneyUnits(item.selling_total) !== itemTotal) invalid();
    actualTotal += itemTotal;
  }
  if (actual.size !== expected.size || actualTotal !== moneyUnits(quote.total_amount)) invalid();
  let changed = expectedTotal !== actualTotal;
  for (const [key, value] of expected) {
    const final = actual.get(key);
    if (!final || final.count !== value.count) invalid();
    if (final.amount !== value.amount) changed = true;
  }
  return { changed };
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

function routeFor(pathname) {
  const routes = {
    '/api/catalog/countries': { method: 'GET', path: '/countries', allowed: [], ttl: 300_000 },
    '/api/catalog/cities': { method: 'GET', path: '/cities', allowed: ['country_codes'], ttl: 300_000 },
    '/api/catalog/categories': { method: 'GET', path: '/categories', allowed: [], ttl: 300_000 },
    '/api/catalog/products': { method: 'GET', path: '/products', allowed: ['category_codes', 'city_codes', 'country_codes', 'keyword', 'limit', 'page', 'product_code'], required: ['page', 'limit'], ttl: 30_000 },
    '/api/catalog/packages/extra-info': { method: 'GET', path: '/packages/extra-info', allowed: ['package_codes'], required: ['package_codes'], ttl: 30_000 },
    '/api/catalog/skus/calendar': { method: 'GET', path: '/skus/calendar', allowed: ['sku_codes', 'start_date', 'end_date'], required: ['sku_codes', 'start_date', 'end_date'], ttl: 0 },
    '/api/availability-check': { method: 'POST', path: '/availability-check' },
    '/api/orders/validate': { method: 'POST', path: '/orders/validate' },
    '/api/orders': { method: 'POST', path: '/orders' },
  };
  if (routes[pathname]) return routes[pathname];
  const match = pathname.match(/^\/api\/catalog\/products\/([A-Za-z0-9_-]{1,128})$/);
  return match ? { method: 'GET', path: `/products/${encodeURIComponent(match[1])}`, allowed: [], ttl: 30_000 } : null;
}

function buildQuery(route, params) {
  const clean = new URLSearchParams();
  for (const [key, value] of params) {
    if (!route.allowed.includes(key)) throw new HttpError(400, 'INVALID_QUERY', `不支持查询参数 ${key}`);
    if (clean.has(key)) throw new HttpError(400, 'INVALID_QUERY', `查询参数 ${key} 不可重复`);
    if (value.length > 500) throw new HttpError(400, 'INVALID_QUERY', '查询参数过长');
    clean.set(key, value);
  }
  for (const name of route.required || []) {
    if (!clean.get(name)) throw new HttpError(400, 'INVALID_QUERY', `缺少查询参数 ${name}`);
  }
  for (const name of ['page', 'limit']) {
    const value = clean.get(name);
    if (value !== null && (!/^\d+$/.test(value) || Number(value) < 1 || (name === 'limit' && Number(value) > 50))) {
      throw new HttpError(400, 'INVALID_QUERY', `${name} 超出允许范围`);
    }
  }
  for (const [key, value] of clean) {
    if (key.endsWith('_codes') && (!/^[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*$/.test(value) || value.split(',').length > (key === 'sku_codes' ? 20 : 50))) {
      throw new HttpError(400, 'INVALID_QUERY', `${key} 格式不正确`);
    }
  }
  if (route.path === '/skus/calendar') {
    const start = clean.get('start_date');
    const end = clean.get('end_date');
    const datePattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    if (!datePattern.test(start) || !datePattern.test(end)) throw new HttpError(400, 'INVALID_QUERY', '日期须为 yyyy-MM-dd HH:mm:ss');
    const startMs = Date.parse(start.replace(' ', 'T') + 'Z');
    const endMs = Date.parse(end.replace(' ', 'T') + 'Z');
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs || endMs - startMs > 90 * 86_400_000) {
      throw new HttpError(400, 'INVALID_QUERY', '日期范围须在 90 天内，结束日期不得早于开始日期');
    }
  }
  clean.sort();
  return clean.toString();
}

async function parseUpstream(response) {
  if (Number(response.headers.get('content-length') || 0) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new HttpError(502, 'UPSTREAM_RESPONSE', '供应商响应过大，请稍后重试');
  }
  const chunks = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new HttpError(502, 'UPSTREAM_RESPONSE', '供应商响应过大，请稍后重试');
      }
      chunks.push(Buffer.from(value));
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const data = JSON.parse(text);
    if (!isObject(data) || typeof data.success !== 'boolean') throw new Error();
    return data;
  } catch { throw new HttpError(502, 'UPSTREAM_RESPONSE', '供应商暂时未返回有效数据，请稍后重试'); }
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
  const staticDir = options.staticDir === false ? false : resolve(options.staticDir || resolve(ROOT, 'dist'));
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
