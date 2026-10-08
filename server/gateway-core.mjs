const UPSTREAM = 'https://didatickettest.wysiwysi.com/api/distribution/v1';
const MAX_BODY_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

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
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [apiKey ? key.split(apiKey).join('[redacted]') : key,
      /^(authorization|api[_-]?key|access[_-]?token|secret|password)$/i.test(key)
        ? '[redacted]' : redact(item, apiKey),
    ]));
  }
  return value;
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
    if (value !== null && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || (name === 'limit' && Number(value) > 50))) {
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
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || new Date(startMs).toISOString().slice(0, 19) !== start.replace(' ', 'T') || new Date(endMs).toISOString().slice(0, 19) !== end.replace(' ', 'T') || endMs < startMs || endMs - startMs > 90 * 86_400_000) {
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
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  try {
    const data = JSON.parse(text);
    if (!isObject(data) || typeof data.success !== 'boolean') throw new Error();
    return data;
  } catch { throw new HttpError(502, 'UPSTREAM_RESPONSE', '供应商暂时未返回有效数据，请稍后重试'); }
}


export { UPSTREAM, MAX_BODY_BYTES, HttpError, envelope, redact, isObject, validateLines, validateOrder, moneyUnits, checkFinalQuote, routeFor, buildQuery, parseUpstream };
