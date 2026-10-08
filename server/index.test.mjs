import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createAppServer } from './index.mjs';

// All supplier responses below are mocked contract examples, never live products.
const testKey = 'unit-test-only-placeholder';
const order = {
  agent_order_code: 'ANT-contract-test',
  contact_info: { first_name: 'Demo', family_name: 'Traveller', mobile: '86-13800000000' },
  items: [{ package_code: 'package_a', start_time: '2099-10-08 09:30:00', sku_list: [{ sku_code: 'adult_a', count: 2, acceptable_price: '79.00' }], booking_extra_info: [], unit_extra_info: [] }],
};
const validation = { success: true, data: { valid: true, quote: { currency: 'USD', total_amount: '158.00', items: [{ package_code: 'package_a', start_time: '2099-10-08 09:30:00', currency: 'USD', selling_total: '158.00', sku_list: [{ sku_code: 'adult_a', count: 2, selling_unit_price: '79.00' }] }] } } };

async function app(t, options = {}) {
  const calls = [];
  const server = createAppServer({
    env: { DIDA_API_KEY: testKey }, staticDir: false,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ success: true, data: [] });
    }, ...options,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, calls };
}

function post(body, extras = {}) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json', ...extras }, body: JSON.stringify(body) };
}

test('missing credentials is an actionable 503 and health discloses presence only', async (t) => {
  const { base, calls } = await app(t, { env: {} });
  const res = await fetch(`${base}/api/catalog/countries`);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'API_NOT_CONFIGURED');
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  assert.deepEqual(health.data, { service: 'rollinggo-ant', configured: false, order_mode: 'validate' });
  assert.equal(calls.length, 0);
});

test('catalogue uses fixed upstream, bearer and Chinese headers, then short server cache', async (t) => {
  const { base, calls } = await app(t);
  const pathname = '/api/catalog/products?country_codes=36&page=1&limit=20';
  await fetch(base + pathname).then((r) => r.json());
  await fetch(base + pathname).then((r) => r.json());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://didatickettest.wysiwysi.com/api/distribution/v1/products?country_codes=36&limit=20&page=1');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${testKey}`);
  assert.equal(calls[0].init.headers['Accept-Language'], 'zh-CN');
  assert.equal(calls[0].init.redirect, 'error');
});

test('route mapping supports all documented read-only frontend endpoints', async (t) => {
  const { base, calls } = await app(t);
  for (const [path, upstream] of [
    ['/api/catalog/countries', '/countries'],
    ['/api/catalog/cities?country_codes=36', '/cities?country_codes=36'],
    ['/api/catalog/categories', '/categories'],
    ['/api/catalog/products/product_a', '/products/product_a'],
    ['/api/catalog/packages/extra-info?package_codes=package_a', '/packages/extra-info?package_codes=package_a'],
    ['/api/catalog/skus/calendar?sku_codes=adult_a&start_date=2099-10-08%2000%3A00%3A00&end_date=2099-10-08%2023%3A59%3A59', '/skus/calendar?end_date=2099-10-08+23%3A59%3A59&sku_codes=adult_a&start_date=2099-10-08+00%3A00%3A00'],
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.equal(calls.at(-1).url, 'https://didatickettest.wysiwysi.com/api/distribution/v1' + upstream);
    await response.json();
  }
});

test('disallowed routes, payment/cancellation, wrong methods and arbitrary destinations never reach upstream', async (t) => {
  const { base, calls } = await app(t);
  for (const path of ['/api/balance', '/api/orders/order_a/pay', '/api/orders/order_a/cancel', '/api/proxy?url=https://example.com', '/api/catalog/products/product_a/anything']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 404, path);
    await res.json();
  }
  assert.equal((await fetch(`${base}/api/orders`)).status, 405);
  assert.equal((await fetch(`${base}/api/catalog/countries`, post({}))).status, 405);
  assert.equal(calls.length, 0);
});

test('query validation enforces catalogue pagination and full calendar timestamps', async (t) => {
  const { base, calls } = await app(t);
  for (const path of [
    '/api/catalog/products?page=1', '/api/catalog/products?page=0&limit=20',
    '/api/catalog/products?page=1&limit=51', '/api/catalog/products?page=1&limit=20&url=https://example.com',
    '/api/catalog/products?page=1&page=2&limit=20',
    '/api/catalog/skus/calendar?sku_codes=adult_a&start_date=2099-10-08&end_date=2099-10-09',
    '/api/catalog/skus/calendar?sku_codes=adult_a&start_date=2099-10-09%2000:00:00&end_date=2099-10-08%2000:00:00',
    '/api/catalog/packages/extra-info',
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 400, path);
    await response.json();
  }
  assert.equal(calls.length, 0);
});

test('availability contract requires a JSON array and forwards unchanged', async (t) => {
  const { base, calls } = await app(t);
  const bad = await fetch(`${base}/api/availability-check`, post({ items: order.items }));
  assert.equal(bad.status, 400);
  const good = await fetch(`${base}/api/availability-check`, post(order.items));
  assert.equal(good.status, 200);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), order.items);
  assert.equal(calls.at(-1).url.endsWith('/availability-check'), true);
});

test('default order submission validates supplier quote without creating any order', async (t) => {
  const calls = [];
  const { base } = await app(t, { fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json(validation); } });
  const response = await fetch(`${base}/api/orders`, post(order));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, true);
  assert.equal(result.data.mode, 'validated');
  assert.match(result.data.draft_id, /^ANT-/);
  assert.deepEqual(result.data.quote, validation.data.quote);
  assert.equal(result.data.order_code, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith('/orders/validate'), true);
  assert.deepEqual(JSON.parse(calls[0].init.body), order);
});

test('demo always validates only even when legacy live and checkout settings exist', async (t) => {
  const calls = [];
  const { base } = await app(t, { env: { DIDA_API_KEY: testKey, DIDA_ORDER_MODE: 'live', ANT_CHECKOUT_URL: 'https://checkout.example/{order_code}' }, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json(validation); } });
  const result = await fetch(`${base}/api/orders`, post({ ...order, expected_currency: 'USD', expected_total: '158.0000' })).then((r) => r.json());
  assert.equal(result.data.mode, 'validated');
  assert.equal(result.data.order_code, undefined);
  assert.equal(result.data.checkout_url, undefined);
  assert.deepEqual(result.data.quote, validation.data.quote);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ['/api/distribution/v1/orders/validate']);
  for (const call of calls) assert.deepEqual(JSON.parse(call.init.body), order);
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  assert.equal(health.data.order_mode, 'validate');
});

test('order confirmation requires a complete internally consistent supplier quote', async (t) => {
  for (const quote of [
    undefined, {}, { ...validation.data.quote, total_amount: undefined },
    { ...validation.data.quote, total_amount: 'NaN' }, { ...validation.data.quote, currency: '' },
    { ...validation.data.quote, currency: 'invalid' }, { ...validation.data.quote, items: [] },
    { ...validation.data.quote, total_amount: '159.00' },
  ]) {
    const calls = [];
    const { base } = await app(t, { env: { DIDA_API_KEY: testKey, DIDA_ORDER_MODE: 'live' }, fetchImpl: async (url) => { calls.push(url); return Response.json({ success: true, data: { valid: true, quote } }); } });
    const response = await fetch(`${base}/api/orders`, post(order));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'INVALID_QUOTE');
    assert.equal(calls.length, 1);
  }
});

test('final validation price changes return the fresh quote and never create an order', async (t) => {
  const changed = structuredClone(validation);
  changed.data.quote.total_amount = '160.00';
  changed.data.quote.items[0].selling_total = '160.00';
  changed.data.quote.items[0].sku_list[0].selling_unit_price = '80.00';
  for (const mode of ['validate', 'live']) {
    const calls = [];
    const { base } = await app(t, { env: { DIDA_API_KEY: testKey, DIDA_ORDER_MODE: mode }, fetchImpl: async (url) => { calls.push(url); return Response.json(changed); } });
    const response = await fetch(`${base}/api/orders`, post(order));
    assert.equal(response.status, 409);
    const result = await response.json();
    assert.equal(result.error.code, 'PRICE_CHANGED');
    assert.deepEqual(result.error.quote, changed.data.quote);
    assert.equal(calls.length, 1);
  }
});

test('same total with changed SKU prices still requires confirmation', async (t) => {
  const payload = structuredClone(order);
  payload.items[0].sku_list = [{ sku_code: 'adult_a', count: 1, acceptable_price: '79.00' }, { sku_code: 'adult_b', count: 1, acceptable_price: '79.00' }];
  const changed = structuredClone(validation);
  changed.data.quote.items[0].sku_list = [{ sku_code: 'adult_a', count: 1, selling_unit_price: '80.00' }, { sku_code: 'adult_b', count: 1, selling_unit_price: '78.00' }];
  const { base } = await app(t, { fetchImpl: async () => Response.json(changed) });
  const response = await fetch(`${base}/api/orders`, post(payload));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'PRICE_CHANGED');
});

test('final quote count or SKU changes cannot be mistaken for only a price update', async (t) => {
  for (const adjustment of [(quote) => { quote.items[0].sku_list[0].sku_code = 'unexpected_sku'; }, (quote) => { quote.items[0].sku_list[0].count = 1; quote.items[0].selling_total = '79.00'; quote.total_amount = '79.00'; }]) {
    const changed = structuredClone(validation);
    adjustment(changed.data.quote);
    const { base } = await app(t, { fetchImpl: async () => Response.json(changed) });
    const response = await fetch(`${base}/api/orders`, post(order));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'INVALID_QUOTE');
  }
});

test('confirmed currency is local metadata and a later currency switch prevents creation', async (t) => {
  const calls = [];
  const { base } = await app(t, { env: { DIDA_API_KEY: testKey, DIDA_ORDER_MODE: 'live' }, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json(validation); } });
  const response = await fetch(`${base}/api/orders`, post({ ...order, expected_currency: 'HKD' }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'PRICE_CHANGED');
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).expected_currency, undefined);
});

test('confirmed total is local metadata and a later total change prevents creation', async (t) => {
  const calls = [];
  const { base } = await app(t, { env: { DIDA_API_KEY: testKey, DIDA_ORDER_MODE: 'live' }, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json(validation); } });
  const response = await fetch(`${base}/api/orders`, post({ ...order, expected_currency: 'USD', expected_total: '157.00' }));
  assert.equal(response.status, 409);
  const result = await response.json();
  assert.equal(result.error.code, 'PRICE_CHANGED');
  assert.deepEqual(result.error.quote, validation.data.quote);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).expected_total, undefined);
  assert.equal(JSON.parse(calls[0].init.body).expected_currency, undefined);
});

test('confirmed unchanged currency and equivalent decimal prices allow a draft', async (t) => {
  const calls = [];
  const payload = structuredClone(order);
  payload.items[0].sku_list[0].acceptable_price = '79.0000';
  payload.expected_currency = 'USD';
  const { base } = await app(t, { fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json(validation); } });
  const response = await fetch(`${base}/api/orders`, post(payload));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.mode, 'validated');
  assert.equal(JSON.parse(calls[0].init.body).expected_currency, undefined);
});

test('submitted orders require explicit acceptable unit prices for final comparison', async (t) => {
  const payload = structuredClone(order);
  delete payload.items[0].sku_list[0].acceptable_price;
  const { base } = await app(t, { fetchImpl: async () => Response.json(validation) });
  const response = await fetch(`${base}/api/orders`, post(payload));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'PRICE_CONFIRMATION_REQUIRED');
});

test('failed validation never confirms a draft', async (t) => {
  const calls = [];
  const fail = { success: false, error: { code: '1211', status: 400, message: 'Price changed' } };
  const { base } = await app(t, { env: { DIDA_API_KEY: testKey, DIDA_ORDER_MODE: 'live' }, fetchImpl: async (url) => { calls.push(url); return Response.json(fail, { status: 400 }); } });
  const response = await fetch(`${base}/api/orders`, post(order));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), fail);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endsWith('/orders/validate'), true);
});

test('nested booking information passes through validation and remains a draft', async (t) => {
  const calls = [];
  const { base } = await app(t, { env: { DIDA_API_KEY: testKey, DIDA_ORDER_MODE: 'live' }, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json(validation); } });
  const payload = { ...order, items: [{ ...order.items[0], booking_extra_info: [{ key: 'contact_way_no', selected: [{ key: 'contact_way_no_whatsapp', content: '86-13800000000' }] }], unit_extra_info: [{ sku_code: 'adult_a', index: 1, extra_info: [] }, { sku_code: 'adult_a', index: 2, extra_info: [] }] }] };
  const response = await fetch(`${base}/api/orders`, post(payload));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.mode, 'validated');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith('/orders/validate'), true);
  assert.deepEqual(JSON.parse(calls[0].init.body), payload);
});

test('supplier success without valid=true is rejected rather than falsely marked confirmed', async (t) => {
  const { base } = await app(t, { fetchImpl: async () => Response.json({ success: true, data: { valid: false } }) });
  const response = await fetch(`${base}/api/orders`, post(order));
  assert.equal(response.status, 422);
  assert.equal((await response.json()).success, false);
});

test('order contact maps to first_name/family_name and invalid contact stays local', async (t) => {
  const { base, calls } = await app(t);
  for (const contact of [{ name_english: 'Demo Traveller', mobile: '86-13800000000' }, { first_name: 'Demo', family_name: 'Traveller', mobile: '+86 13800000000' }]) {
    const response = await fetch(`${base}/api/orders/validate`, post({ ...order, contact_info: contact }));
    assert.equal(response.status, 400);
    await response.json();
  }
  assert.equal(calls.length, 0);
});

test('cross-origin POST, invalid content type, malformed and oversized bodies are blocked', async (t) => {
  const { base, calls } = await app(t, { maxBodyBytes: 1000 });
  const cases = [
    [post(order, { Origin: 'https://unrelated.example' }), 403],
    [post(order, { 'Sec-Fetch-Site': 'cross-site' }), 403],
    [{ method: 'POST', body: JSON.stringify(order) }, 415],
    [{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' }, 400],
    [{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'a'.repeat(2000) }, 413],
  ];
  for (const [init, status] of cases) {
    const response = await fetch(`${base}/api/orders`, init);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    await response.json();
  }
  assert.equal(calls.length, 0);
});

test('upstream errors cannot leak credentials or cache failures', async (t) => {
  let count = 0;
  const { base } = await app(t, { fetchImpl: async () => { count++; return Response.json({ success: false, error: { message: `Echo: ${testKey}`, api_key: testKey, code: 'test' } }, { status: 401 }); } });
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${base}/api/catalog/countries`);
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.equal(body.includes(testKey), false);
    assert.equal(body.includes('[redacted]'), true);
  }
  assert.equal(count, 2);
});

test('network and non-JSON supplier failures return controlled messages', async (t) => {
  for (const fetchImpl of [async () => { throw new Error(`Sensitive ${testKey}`); }, async () => new Response('<html>bad gateway</html>', { status: 502 })]) {
    const { base } = await app(t, { fetchImpl });
    const response = await fetch(`${base}/api/catalog/countries`);
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.equal(body.includes(testKey), false);
    assert.equal(body.includes('<html>'), false);
  }
});

test('supplier timeout during response body and oversized responses are bounded', async (t) => {
  const timeoutBody = async () => new Response(new ReadableStream({ start(controller) { controller.error(new DOMException('timed out', 'TimeoutError')); } }));
  const hugeBody = async () => new Response('{}', { headers: { 'content-length': 9 * 1024 * 1024 } });
  for (const [fetchImpl, status, code] of [[timeoutBody, 504, 'UPSTREAM_TIMEOUT'], [hugeBody, 502, 'UPSTREAM_RESPONSE']]) {
    const { base } = await app(t, { fetchImpl });
    const response = await fetch(`${base}/api/catalog/countries`);
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }
});

test('rate limiting happens before upstream calls', async (t) => {
  const { base, calls } = await app(t, { rateLimit: 1 });
  await fetch(`${base}/api/catalog/countries`).then((r) => r.json());
  const response = await fetch(`${base}/api/catalog/cities`);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(calls.length, 1);
});

test('static SPA serves built assets, never dotfiles, traversal or symlinks outside dist', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ant-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<html>ANT demo</html>');
  await writeFile(join(dist, 'assets', 'app.js'), 'console.log("ANT")');
  await writeFile(join(dist, '.env'), 'private-config');
  await writeFile(join(root, 'outside.txt'), 'outside-private');
  await symlink(join(root, 'outside.txt'), join(dist, 'escape.txt'));
  const { base } = await app(t, { staticDir: dist });
  const page = await fetch(base + '/activities/product_a');
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '<html>ANT demo</html>');
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  const asset = await fetch(base + '/assets/app.js');
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
  await asset.text();
  for (const path of ['/.env', '/%2eenv', '/escape.txt', '/assets/missing.js']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    assert.equal((await response.text()).includes('private'), false);
  }
  // Raw HTTP intentionally retains ..; browser fetch normalises it before send.
  const response = await new Promise((resolve, reject) => {
    const req = request(base, { path: '/%2e%2e/outside.txt' }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
    req.on('error', reject); req.end();
  });
  assert.equal(response.statusCode, 404);
});
