import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { createWorkerGateway } from './worker.mjs';

const ORIGIN = 'https://ant.test';
const UPSTREAM = 'https://didatickettest.wysiwysi.com/api/distribution/v1';
const testKey = 'ANT-WORKER-CONTRACT-FAKE-KEY';
const order = {
  agent_order_code: 'ANT-worker-contract-test',
  contact_info: { first_name: 'Demo', family_name: 'Traveller', mobile: '86-13800000000' },
  items: [{ package_code: 'package_a', start_time: '2099-10-08 09:30:00',
    sku_list: [{ sku_code: 'adult_a', count: 2, acceptable_price: '79.00' }],
    booking_extra_info: [], unit_extra_info: [] }],
};
const validation = { success: true, data: { valid: true, quote: {
  currency: 'USD', total_amount: '158.00', items: [{
    package_code: 'package_a', start_time: '2099-10-08 09:30:00', selling_total: '158.00',
    sku_list: [{ sku_code: 'adult_a', count: 2, selling_unit_price: '79.00' }],
  }],
} } };

function app(options = {}) {
  const calls = [];
  const { fetchImpl = async () => Response.json({ success: true, data: [] }), ...rest } = options;
  const fetchRequest = createWorkerGateway({
    env: { DIDA_API_KEY: testKey }, ...rest,
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return fetchImpl(url, init); },
  });
  return {
    calls,
    fetch: (path, init = {}) => fetchRequest(new Request(ORIGIN + path, {
      ...init, headers: { 'cf-connecting-ip': '203.0.113.10', ...init.headers },
    })),
  };
}
function post(body, headers = {}) {
  return { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
}
function quoteApp(quote = validation) { return app({ fetchImpl: async () => Response.json(quote) }); }

test('Worker exports a native fetch handler and health reports binding presence only', async () => {
  assert.equal(typeof worker.fetch, 'function');
  const health = await worker.fetch(new Request(ORIGIN + '/api/health'), {}, {});
  assert.equal(health.status, 200);
  assert.deepEqual((await health.json()).data, { service: 'rollinggo-ant', configured: false, order_mode: 'validate' });
  const { fetch, calls } = app({ env: {} });
  const missing = await fetch('/api/catalog/countries');
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error.code, 'API_NOT_CONFIGURED');
  assert.equal(calls.length, 0);
});

test('Worker fixes the supplier URL and server authentication, never browser authentication', async () => {
  const { fetch, calls } = app();
  const response = await fetch('/api/catalog/products?country_codes=36&page=1&limit=20', {
    headers: { Authorization: 'Bearer browser-controlled', 'Accept-Language': 'en-US' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(calls[0].url, UPSTREAM + '/products?country_codes=36&limit=20&page=1');
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${testKey}`);
  assert.equal(headers.get('accept-language'), 'zh-CN');
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal((await response.text()).includes(testKey), false);
});

test('Worker maps every approved supplier read endpoint and preserves string product codes', async () => {
  const { fetch, calls } = app();
  const paths = [
    ['/api/catalog/countries', '/countries'],
    ['/api/catalog/cities?country_codes=36', '/cities?country_codes=36'],
    ['/api/catalog/categories', '/categories'],
    ['/api/catalog/products/10Y1', '/products/10Y1'],
    ['/api/catalog/packages/extra-info?package_codes=package_a', '/packages/extra-info?package_codes=package_a'],
    ['/api/catalog/skus/calendar?sku_codes=adult_a&start_date=2099-10-08%2000:00:00&end_date=2099-10-08%2023:59:59',
      '/skus/calendar?end_date=2099-10-08+23%3A59%3A59&sku_codes=adult_a&start_date=2099-10-08+00%3A00%3A00'],
  ];
  for (const [path, upstream] of paths) {
    const response = await fetch(path);
    assert.equal(response.status, 200, path);
    assert.equal(calls.at(-1).url, UPSTREAM + upstream);
  }
});

test('Worker blocks payment, cancellation, balance, unknown order routes and arbitrary proxies', async () => {
  const { fetch, calls } = app();
  for (const path of ['/api/balance', '/api/orders/order_a/pay', '/api/orders/order_a/cancel',
    '/api/orders/create', '/api/proxy?url=https://example.com', '/api/catalog/products/10Y1/anything']) {
    assert.equal((await fetch(path, post(order))).status, 404, path);
  }
  assert.equal((await fetch('/api/orders')).status, 405);
  assert.equal((await fetch('/api/catalog/countries', post({}))).status, 405);
  assert.equal(calls.length, 0);
});

test('Worker draft endpoint always validates, including legacy live or checkout configuration', async () => {
  const { fetch, calls } = app({
    env: { DIDA_API_KEY: testKey, DIDA_ORDER_MODE: 'live', ANT_CHECKOUT_URL: 'https://checkout.example/{order_code}' },
    fetchImpl: async () => Response.json(validation),
  });
  const response = await fetch('/api/orders', post({ ...order, expected_currency: 'USD', expected_total: '158.0000' }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.data.mode, 'validated');
  assert.match(result.data.draft_id, /^ANT-/);
  assert.equal(result.data.order_code, undefined);
  assert.equal(result.data.checkout_url, undefined);
  assert.deepEqual(result.data.quote, validation.data.quote);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, UPSTREAM + '/orders/validate');
  assert.deepEqual(JSON.parse(calls[0].init.body), order);
  assert.equal((await (await fetch('/api/health')).json()).data.order_mode, 'validate');
});

test('Worker compares complete Origin, including scheme, and blocks cross-site POSTs', async () => {
  const { fetch, calls } = app();
  for (const headers of [
    { Origin: 'http://ant.test' }, { Origin: 'https://unrelated.example' },
    { Origin: 'https://ant.test:8443' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const response = await fetch('/api/orders/validate', post(order, headers));
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(calls.length, 0);
  assert.equal((await fetch('/api/orders/validate', post(order))).status, 200);
  assert.equal(calls.length, 1);
});

test('Worker query validation rejects unsafe numbers, duplicates, unsupported keys and oversized code sets', async () => {
  const { fetch, calls } = app();
  const badPaths = [
    '/api/catalog/products?page=1', '/api/catalog/products?page=0&limit=20',
    '/api/catalog/products?page=-1&limit=20', '/api/catalog/products?page=1.5&limit=20',
    '/api/catalog/products?page=9007199254740992&limit=20',
    '/api/catalog/products?page=' + '9'.repeat(400) + '&limit=20',
    '/api/catalog/products?page=1&limit=51', '/api/catalog/products?page=1&page=2&limit=20',
    '/api/catalog/products?page=1&limit=20&url=https://example.com',
    '/api/catalog/packages/extra-info',
    '/api/catalog/packages/extra-info?package_codes=' + Array.from({ length: 51 }, (_, i) => `p${i}`).join(','),
    '/api/catalog/skus/calendar?sku_codes=' + Array.from({ length: 21 }, (_, i) => `s${i}`).join(',') + '&start_date=2099-10-08%2000:00:00&end_date=2099-10-08%2023:59:59',
  ];
  for (const path of badPaths) assert.equal((await fetch(path)).status, 400, path);
  assert.equal(calls.length, 0);
});

test('Worker rejects invalid calendar dates, incomplete timestamps and windows over 90 days', async () => {
  const { fetch, calls } = app();
  for (const [start, end] of [
    ['2099-02-30 00:00:00', '2099-03-03 00:00:00'],
    ['2099-02-29 00:00:00', '2099-03-01 00:00:00'],
    ['2099-10-08 24:00:00', '2099-10-09 23:59:59'],
    ['2099-10-08', '2099-10-09'],
    ['2099-10-09 00:00:00', '2099-10-08 00:00:00'],
    ['2099-01-01 00:00:00', '2099-04-02 00:00:00'],
  ]) {
    const query = new URLSearchParams({ sku_codes: 'adult_a', start_date: start, end_date: end });
    assert.equal((await fetch('/api/catalog/skus/calendar?' + query)).status, 400, start);
  }
  assert.equal(calls.length, 0);
  const leap = new URLSearchParams({ sku_codes: 'adult_a', start_date: '2100-02-28 00:00:00', end_date: '2100-02-28 23:59:59' });
  assert.equal((await fetch('/api/catalog/skus/calendar?' + leap)).status, 200);
});

test('Worker trusts cf-connecting-ip for rate limits and ignores spoofed x-forwarded-for', async () => {
  const { fetch, calls } = app({ rateLimit: 1 });
  assert.equal((await fetch('/api/catalog/countries', { headers: { 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': '192.0.2.1' } })).status, 200);
  assert.equal((await fetch('/api/catalog/cities', { headers: { 'cf-connecting-ip': '203.0.113.2', 'x-forwarded-for': '192.0.2.1' } })).status, 200);
  const blocked = await fetch('/api/catalog/categories', { headers: { 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': '192.0.2.99' } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '60');
  assert.equal(calls.length, 2);
});

test('Worker rate windows expire and write calls have a separate 20-request ceiling', async () => {
  let time = 1000;
  const limited = app({ rateLimit: 1, now: () => time, rateWindowMs: 2000 });
  assert.equal((await limited.fetch('/api/catalog/countries')).status, 200);
  assert.equal((await limited.fetch('/api/catalog/cities')).status, 429);
  time += 2000;
  assert.equal((await limited.fetch('/api/catalog/cities')).status, 200);
  const writes = app({ rateLimit: 1000 });
  for (let i = 0; i < 20; i++) assert.equal((await writes.fetch('/api/availability-check', post(order.items))).status, 200);
  assert.equal((await writes.fetch('/api/availability-check', post(order.items))).status, 429);
  assert.equal(writes.calls.length, 20);
});

test('Worker caches successful catalogue reads briefly but never calendars, POSTs or failures', async () => {
  const { fetch, calls } = app();
  for (let i = 0; i < 2; i++) await fetch('/api/catalog/countries');
  assert.equal(calls.length, 1);
  const calendar = '/api/catalog/skus/calendar?sku_codes=adult_a&start_date=2099-10-08%2000:00:00&end_date=2099-10-08%2023:59:59';
  for (let i = 0; i < 2; i++) await fetch(calendar);
  assert.equal(calls.length, 3);
  for (let i = 0; i < 2; i++) await fetch('/api/availability-check', post(order.items));
  assert.equal(calls.length, 5);
  const failed = app({ fetchImpl: async () => Response.json({ success: false, error: { code: '1501', message: 'Unauthorized' } }, { status: 401 }) });
  for (let i = 0; i < 2; i++) assert.equal((await failed.fetch('/api/catalog/countries')).status, 401);
  assert.equal(failed.calls.length, 2);
});

test('Worker accepts JSON root-array availability and preserves verified nested extra information', async () => {
  const { fetch, calls } = quoteApp();
  assert.equal((await fetch('/api/availability-check', post({ items: order.items }))).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await fetch('/api/availability-check', post(order.items))).status, 200);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), order.items);
  const payload = structuredClone(order);
  payload.items[0].booking_extra_info = [{ key: 'contact_way_no', selected: [{ key: 'contact_way_no_whatsapp', content: '86-13800000000' }] }];
  payload.items[0].unit_extra_info = [{ sku_code: 'adult_a', index: 1, extra_info: [] }, { sku_code: 'adult_a', index: 2, extra_info: [] }];
  assert.equal((await fetch('/api/orders', post(payload))).status, 200);
  assert.equal(calls.at(-1).url, UPSTREAM + '/orders/validate');
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), payload);
});

test('Worker keeps malformed bodies and invalid contacts, counts and query metadata local', async () => {
  const { fetch, calls } = app();
  const cases = [
    ['/api/orders', { method: 'POST', body: JSON.stringify(order) }, 415],
    ['/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' }, 400],
    ['/api/orders', post({ ...order, contact_info: { name_english: 'Demo Traveller', mobile: '86-13800000000' } }), 400],
    ['/api/orders', post({ ...order, contact_info: { ...order.contact_info, mobile: '+86 13800000000' } }), 400],
    ['/api/orders', post({ ...order, items: [{ ...order.items[0], sku_list: [{ sku_code: 'adult_a', count: 100 }] }] }), 400],
    ['/api/orders', post({ ...order, expected_currency: 'invalid' }), 400],
    ['/api/orders', post({ ...order, expected_total: 'NaN' }), 400],
    ['/api/orders?url=https://example.com', post(order), 400],
  ];
  for (const [path, init, status] of cases) assert.equal((await fetch(path, init)).status, status, path);
  assert.equal(calls.length, 0);
});

test('Worker bounds announced and streaming request sizes without contacting the supplier', async () => {
  const { fetch, calls } = app({ maxBodyBytes: 1000 });
  const announced = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '2000' }, body: '{}' });
  assert.equal(announced.status, 413);
  const streamed = await fetch('/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, duplex: 'half',
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1200)); controller.close(); } }),
  });
  assert.equal(streamed.status, 413);
  assert.equal(calls.length, 0);
});

test('Worker final quotes must match submitted identities and counts and be internally consistent', async () => {
  const invalidQuotes = [undefined, {}, { ...validation.data.quote, total_amount: 'NaN' },
    { ...validation.data.quote, currency: 'invalid' }, { ...validation.data.quote, items: [] },
    { ...validation.data.quote, total_amount: '159.00' }];
  for (const change of [
    quote => { quote.items[0].sku_list[0].sku_code = 'unexpected_sku'; },
    quote => { quote.items[0].sku_list[0].count = 1; quote.items[0].selling_total = '79.00'; quote.total_amount = '79.00'; },
    quote => { quote.items[0].selling_total = '159.00'; },
  ]) { const quote = structuredClone(validation.data.quote); change(quote); invalidQuotes.push(quote); }
  for (const quote of invalidQuotes) {
    const { fetch, calls } = quoteApp({ success: true, data: { valid: true, quote } });
    const response = await fetch('/api/orders', post(order));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'INVALID_QUOTE');
    assert.deepEqual(calls.map(call => call.url), [UPSTREAM + '/orders/validate']);
  }
});

test('Worker requires acceptable unit prices for draft confirmation', async () => {
  const { fetch, calls } = quoteApp();
  const payload = structuredClone(order);
  delete payload.items[0].sku_list[0].acceptable_price;
  const response = await fetch('/api/orders', post(payload));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'PRICE_CONFIRMATION_REQUIRED');
  assert.ok(calls.every(call => call.url.endsWith('/orders/validate')));
});

test('Worker returns changed supplier quote for explicit reconfirmation without any order creation', async () => {
  const changed = structuredClone(validation);
  changed.data.quote.total_amount = '160.00';
  changed.data.quote.items[0].selling_total = '160.00';
  changed.data.quote.items[0].sku_list[0].selling_unit_price = '80.00';
  const { fetch, calls } = quoteApp(changed);
  const response = await fetch('/api/orders', post(order));
  assert.equal(response.status, 409);
  const result = await response.json();
  assert.equal(result.error.code, 'PRICE_CHANGED');
  assert.deepEqual(result.error.quote, changed.data.quote);
  assert.deepEqual(calls.map(call => call.url), [UPSTREAM + '/orders/validate']);
});

test('Worker detects changed unit prices even when their overall total is unchanged', async () => {
  const payload = structuredClone(order);
  payload.items[0].sku_list = [{ sku_code: 'adult_a', count: 1, acceptable_price: '79.00' }, { sku_code: 'adult_b', count: 1, acceptable_price: '79.00' }];
  const changed = structuredClone(validation);
  changed.data.quote.items[0].sku_list = [{ sku_code: 'adult_a', count: 1, selling_unit_price: '80.00' }, { sku_code: 'adult_b', count: 1, selling_unit_price: '78.00' }];
  const { fetch } = quoteApp(changed);
  const response = await fetch('/api/orders', post(payload));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'PRICE_CHANGED');
});

test('Worker strips local expected metadata and blocks currency or total changes', async () => {
  for (const metadata of [{ expected_currency: 'HKD' }, { expected_currency: 'USD', expected_total: '157.00' }]) {
    const { fetch, calls } = quoteApp();
    const response = await fetch('/api/orders', post({ ...order, ...metadata }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'PRICE_CHANGED');
    assert.deepEqual(JSON.parse(calls[0].init.body), order);
  }
});

test('Worker uses exact decimal comparison while allowing equivalent four-place prices', async () => {
  const payload = structuredClone(order);
  payload.items[0].sku_list[0].acceptable_price = '79.0000';
  payload.expected_currency = 'USD';
  payload.expected_total = '158.0000';
  const { fetch } = quoteApp();
  const response = await fetch('/api/orders', post(payload));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.mode, 'validated');
});

test('Worker rejects failed validation and supplier success without valid=true', async () => {
  for (const [result, status, expected] of [
    [{ success: false, error: { code: '1211', status: 400, message: 'Price changed' } }, 400, 400],
    [{ success: true, data: { valid: false } }, 200, 422],
  ]) {
    const { fetch, calls } = app({ fetchImpl: async () => Response.json(result, { status }) });
    assert.equal((await fetch('/api/orders', post(order))).status, expected);
    assert.deepEqual(calls.map(call => call.url), [UPSTREAM + '/orders/validate']);
  }
});

test('Worker redacts the exact secret from values and reflected property names', async () => {
  const { fetch } = app({ fetchImpl: async () => Response.json({ success: false, error: {
    code: 'test', message: `Echo: ${testKey}`, api_key: testKey,
    nested: { [testKey]: 'reflected-key', Authorization: 'another-sensitive-value' },
  } }, { status: 401 }) });
  const response = await fetch('/api/catalog/countries');
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.text();
  assert.equal(body.includes(testKey), false);
  assert.equal(body.includes('another-sensitive-value'), false);
  assert.equal(body.includes('[redacted]'), true);
});

test('Worker controls network, timeout and non-JSON supplier failures without leaking details', async () => {
  for (const [fetchImpl, status, code] of [
    [async () => { throw new Error(`Sensitive ${testKey}`); }, 502, 'UPSTREAM_UNAVAILABLE'],
    [async () => { throw new DOMException('timeout', 'TimeoutError'); }, 504, 'UPSTREAM_TIMEOUT'],
    [async () => new Response('<html>bad gateway</html>', { status: 502 }), 502, 'UPSTREAM_RESPONSE'],
    [async () => Response.json({ unrelated: true }), 502, 'UPSTREAM_RESPONSE'],
  ]) {
    const { fetch } = app({ fetchImpl });
    const response = await fetch('/api/catalog/countries');
    assert.equal(response.status, status);
    const text = await response.text();
    assert.equal(text.includes(testKey), false);
    assert.equal(text.includes('<html>'), false);
    assert.equal(JSON.parse(text).error.code, code);
  }
});

test('Worker bounds announced and streaming responses and handles timeout during body consumption', async () => {
  const tooLarge = 8 * 1024 * 1024 + 1;
  for (const [fetchImpl, status, code] of [
    [async () => new Response('{}', { headers: { 'content-length': String(tooLarge) } }), 502, 'UPSTREAM_RESPONSE'],
    [async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(tooLarge)); controller.close(); } })), 502, 'UPSTREAM_RESPONSE'],
    [async () => new Response(new ReadableStream({ start(controller) { controller.error(new DOMException('timed out', 'TimeoutError')); } })), 504, 'UPSTREAM_TIMEOUT'],
  ]) {
    const { fetch } = app({ fetchImpl });
    const response = await fetch('/api/catalog/countries');
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }
});

test('Worker API security headers keep browser connections and form submission on the site origin', async () => {
  const { fetch } = app();
  const response = await fetch('/api/catalog/countries');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(response.headers.get('content-security-policy') || '', /connect-src 'self'/);
  assert.match(response.headers.get('content-security-policy') || '', /form-action 'self'/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});
