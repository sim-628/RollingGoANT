import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createCatalogPriceService } from './catalog-prices.mjs';
import { createWorkerGateway } from './worker.mjs';
import { createAppServer } from './index.mjs';

const time = Date.parse('2099-10-08T04:00:00Z');
const pkg = (code, skus) => ({ package_code: code, time_zone: '+08:00', sku_list: skus.map(([sku_code, sku_type = 'PERSON']) => ({ sku_code, sku_type, title: sku_type })) });
const detail = packages => ({ success: true, data: { product_code: 'product_a', price: '0.00', currency: 'USD', package_list: packages } });
const date = (price, inventory = 3, extra = {}) => ({ date: '2099-10-09 11:00:00', selling_price: price, inventory, cutoff_time_utc: '2099-10-09 01:00:00', ...extra });
const calendar = (code, packageCode, dates, extra = {}) => ({ sku_code: code, package_code: packageCode, publish_status: 1, currency: 'USD', calendars: [{ month: '2099-10', dates }], ...extra });
function service(packages, rows, options = {}) {
  const calls = [];
  const resolve = createCatalogPriceService({ now: () => time, upstream: async (path, method, query) => {
    calls.push({ path, method, query });
    return { status: 200, data: path.startsWith('/products/') ? detail(packages) : { success: true, data: rows.filter(row => new URLSearchParams(query).get('sku_codes').split(',').includes(row.sku_code)) } };
  }, ...options });
  return { resolve, calls };
}

test('minimum spans all package variants and dates with exact decimal comparison, excluding accompaniment SKUs', async () => {
  const packages = [pkg('p1', [['adult_1', 'ADULT'], ['child_1', 'CHILD'], ['infant_1', 'INFANT']]), pkg('p2', [['person_2']]), pkg('p3', [['adult_3', 'ADULT']])];
  const rows = [calendar('adult_1', 'p1', [date('18.0001'), date('17.6001')]), calendar('person_2', 'p2', [date('17.6000')]), calendar('adult_3', 'p3', [date('10.00', 0), date('11.00', 3, { cutoff_time_utc: '2099-10-08 03:00:00' })])];
  const { resolve, calls } = service(packages, rows);
  const result = (await resolve('product_a')).data.prices[0];
  assert.equal(result.status, 'ready');
  assert.equal(result.price, '17.6000');
  assert.equal(result.currency, 'USD');
  assert.equal(result.start_date, '2099-10-08');
  assert.equal(result.end_date, '2100-01-05');
  assert.deepEqual(new URLSearchParams(calls[1].query).get('sku_codes').split(','), ['adult_1', 'person_2', 'adult_3']);
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('unpublished, sold-out, expired and out-of-window prices are excluded; genuine adult zero prices remain valid', async () => {
  const packages = [pkg('p1', [['adult_1', 'ADULT']]), pkg('p2', [['person_2']])];
  const rows = [calendar('adult_1', 'p1', [date('0.00')]), calendar('person_2', 'p2', [date('0.00')], { publish_status: 0 })];
  assert.equal((await service(packages, rows).resolve('product_a')).data.prices[0].price, '0.00');
  rows[0].calendars[0].dates = [date('12.00', 0), date('8.00', 3, { cutoff_time_utc: '2099-10-08T04:00:00Z' }), date('5.00', 3, { date: '2099-10-07 11:00:00' })];
  assert.equal((await service(packages, rows).resolve('product_a')).data.prices[0].reason, 'no_available_price');
});

test('mixed currencies and incomplete supplier batches never produce a partial or converted minimum', async () => {
  const packages = [pkg('p1', [['one']]), pkg('p2', [['two']])];
  const rows = [calendar('one', 'p1', [date('17.60')]), calendar('two', 'p2', [date('10.00')], { currency: 'HKD' })];
  const mixed = (await service(packages, rows).resolve('product_a')).data.prices[0];
  assert.equal(mixed.price, null);
  assert.equal(mixed.reason, 'mixed_currencies');
  const missing = (await service(packages, rows.slice(0, 1)).resolve('product_a')).data.prices[0];
  assert.equal(missing.reason, 'incomplete_data');
  const bad = (await service(packages, [rows[0], { ...rows[1], currency: 'USD', calendars: [{ month: '2099-10', dates: [date('NaN')] }] }]).resolve('product_a')).data.prices[0];
  assert.equal(bad.reason, 'incomplete_data');
});

test('authoritative child SKU types cannot become adult offers through their titles', async () => {
  const packages = [pkg('p1', [['adult_1', 'ADULT'], ['child_1', 'CHILD'], ['infant_1', 'INFANT']])];
  packages[0].sku_list[1].title = 'Child with adult';
  packages[0].sku_list[2].title = 'Infant with adult';
  const rows = [calendar('adult_1', 'p1', [date('20.00')]), calendar('child_1', 'p1', [date('0.00')]), calendar('infant_1', 'p1', [date('0.00')])];
  const { resolve, calls } = service(packages, rows);
  assert.equal((await resolve('product_a')).data.prices[0].price, '20.00');
  assert.equal(new URLSearchParams(calls[1].query).get('sku_codes'), 'adult_1');
});

test('malformed inventory invalidates the minimum while legitimate sold-out rows are skipped', async () => {
  const packages = [pkg('p1', [['one']])];
  for (const inventory of ['3', null, undefined, 1.5, NaN]) {
    const result = (await service(packages, [calendar('one', 'p1', [date('1.00', 3, { inventory }), date('20.00')])]).resolve('product_a')).data.prices[0];
    assert.equal(result.price, null);
    assert.equal(result.reason, 'incomplete_data');
  }
  const soldOut = (await service(packages, [calendar('one', 'p1', [date('1.00', 0), date('20.00')])]).resolve('product_a')).data.prices[0];
  assert.equal(soldOut.price, '20.00');
});

test('90-day local calendar window never precedes supplier Shanghai today or a package destination today', async () => {
  const packages = [pkg('p1', [['one']])];
  packages[0].time_zone = '-08:00';
  const west = (await service(packages, [calendar('one', 'p1', [date('17.60')])]).resolve('product_a')).data.prices[0];
  assert.equal(west.start_date, '2099-10-08');
  packages[0].time_zone = '+14:00';
  const late = Date.parse('2099-10-08T15:00:00Z');
  const { resolve, calls } = service(packages, [calendar('one', 'p1', [date('17.60')])], { now: () => late });
  assert.equal((await resolve('product_a')).data.prices[0].start_date, '2099-10-09');
  const params = new URLSearchParams(calls[1].query);
  assert.ok(Date.parse(params.get('end_date').replace(' ', 'T') + 'Z') - Date.parse(params.get('start_date').replace(' ', 'T') + 'Z') < 90 * 86_400_000);
});

test('price queries are bounded, deduplicated, batched by 20 SKUs and share concurrent work', async () => {
  const packages = [pkg('p1', Array.from({ length: 41 }, (_, i) => [`sku_${i}`]))];
  const rows = packages[0].sku_list.map(sku => calendar(sku.sku_code, 'p1', [date('17.60')]));
  const { resolve, calls } = service(packages, rows);
  await Promise.all([resolve('product_a'), resolve('product_a')]);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.slice(1).map(call => new URLSearchParams(call.query).get('sku_codes').split(',').length), [20, 20, 1]);
  await resolve('product_a');
  assert.equal(calls.length, 4);
  for (const codes of ['', 'a,a', 'a,b,c,d,e', '../../secrets']) await assert.rejects(resolve(codes), error => error.code === 'INVALID_QUERY');
  packages[0].sku_list = Array.from({ length: 101 }, (_, i) => ({ sku_code: `sku_${i}` }));
  const oversized = service(packages, []);
  assert.equal((await oversized.resolve('product_a')).data.prices[0].reason, 'too_many_skus');
  assert.equal(oversized.calls.length, 1);
});

test('each calendar batch is reduced before requesting the next and a later failure discards its partial minimum', async () => {
  let firstReduced = false;
  let batches = 0;
  const packages = [pkg('p1', Array.from({ length: 21 }, (_, i) => [`sku_${i}`]))];
  const resolve = createCatalogPriceService({ now: () => time, upstream: async (path, method, query, body, options) => {
    assert.equal(options.maxResponseBytes, 2 * 1024 * 1024);
    assert.ok(options.signal instanceof AbortSignal);
    if (path.startsWith('/products/')) return { status: 200, data: detail(packages) };
    batches++;
    if (batches === 2) {
      assert.equal(firstReduced, true);
      return { status: 200, data: { success: true, data: [] } };
    }
    const rows = new URLSearchParams(query).get('sku_codes').split(',').map(code => calendar(code, 'p1', [date('1.00')]));
    Object.defineProperty(rows[0].calendars[0].dates[0], 'selling_price', { get() { firstReduced = true; return '1.00'; } });
    return { status: 200, data: { success: true, data: rows } };
  } });
  const result = (await resolve('product_a')).data.prices[0];
  assert.equal(result.price, null);
  assert.equal(result.reason, 'incomplete_data');
  assert.equal(batches, 2);
});

test('admission caps unique products at20 and whole-price deadlines abort active reads and queued work', async () => {
  let reads = 0;
  let aborted = 0;
  const resolve = createCatalogPriceService({ now: () => time, priceTimeoutMs: 15, upstream: async (path, method, query, body, { signal }) => {
    reads++;
    return new Promise((done, reject) => signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true }));
  } });
  const accepted = [];
  for (let index = 0; index < 20; index += 4) accepted.push(resolve(Array.from({ length: 4 }, (_, i) => `code_${index + i}`).join(',')));
  const busy = (await resolve('overflow')).data.prices[0];
  assert.equal(busy.reason, 'price_busy');
  assert.equal(reads, 4);
  const shared = resolve('code_0');
  const results = await Promise.all([...accepted, shared]);
  assert.equal(aborted, reads);
  assert.ok(reads <= 20);
  assert.ok(results.every(result => result.data.prices.every(price => price.reason === 'price_timeout' && price.price === null)));
  const retried = (await resolve('overflow')).data.prices[0];
  assert.equal(retried.reason, 'price_timeout');
  assert.equal(reads, aborted);
});

test('display summaries expire after 30 seconds and failed supplier responses are immediately retryable', async () => {
  let current = time;
  let count = 0;
  const resolve = createCatalogPriceService({ now: () => current, upstream: async path => {
    count++;
    if (path.startsWith('/products/')) return { status: 200, data: detail([pkg('p1', [['one']])]) };
    return { status: 200, data: { success: true, data: [calendar('one', 'p1', [date(count < 4 ? '17.60' : '18.00')])] } };
  } });
  assert.equal((await resolve('product_a')).data.prices[0].price, '17.60');
  current += 29_999;
  assert.equal((await resolve('product_a')).data.prices[0].price, '17.60');
  assert.equal(count, 2);
  current++;
  assert.equal((await resolve('product_a')).data.prices[0].price, '18.00');
  assert.equal(count, 4);
  const failed = createCatalogPriceService({ upstream: async () => { count++; throw new Error('private diagnostic'); } });
  const failure = (await failed('product_a')).data.prices[0];
  assert.equal(failure.status, 'error');
  assert.equal(JSON.stringify(failure).includes('private'), false);
  await failed('product_a');
  assert.equal(count, 6);
});

test('parallel requests keep supplier concurrency at four across the service', async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const resolve = createCatalogPriceService({ now: () => time, upstream: async (path, method, query) => {
    active++;
    maximum = Math.max(maximum, active);
    calls++;
    await new Promise(done => setTimeout(done, 2));
    active--;
    if (path.startsWith('/products/')) {
      const productCode = path.split('/').at(-1);
      return { status: 200, data: { success: true, data: { product_code: productCode, package_list: [pkg(`pkg_${productCode}`, [[`sku_${productCode}`]])] } } };
    }
    const skuCode = new URLSearchParams(query).get('sku_codes');
    return { status: 200, data: { success: true, data: [calendar(skuCode, `pkg_${skuCode.slice(4)}`, [date('17.60')])] } };
  } });
  const responses = await Promise.all([resolve('a,b,c,d'), resolve('e,f,g,h')]);
  assert.equal(maximum, 4);
  assert.equal(calls, 16);
  assert.ok(responses.every(response => response.data.prices.every(price => price.status === 'ready')));
});

for (const transport of ['Worker', 'Node']) test(`${transport} exposes read-only price aggregation through fixed authenticated supplier endpoints`, async t => {
  const calls = [];
  const options = { env: { DIDA_API_KEY: 'TEST-PRICE-SERVICE-ONLY' }, now: () => time, fetchImpl: async (value, init) => {
    const url = new URL(value);
    calls.push({ url, init });
    return Response.json(url.pathname.endsWith('/products/product_a') ? detail([pkg('p1', [['one']])]) : { success: true, data: [calendar('one', 'p1', [date('17.60')])] });
  } };
  let read;
  if (transport === 'Worker') {
    const gateway = createWorkerGateway(options);
    read = path => gateway(new Request(`https://ant.test${path}`));
  } else {
    const server = createAppServer({ ...options, staticDir: false });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    read = path => fetch(`http://127.0.0.1:${server.address().port}${path}`);
  }
  const response = await read('/api/catalog/prices?product_codes=product_a');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.prices[0].price, '17.60');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url.origin === 'https://didatickettest.wysiwysi.com' && call.init.method === 'GET'));
  assert.ok(calls.every(call => call.init.headers.Authorization === 'Bearer TEST-PRICE-SERVICE-ONLY' && call.init.headers['Accept-Language'] === 'zh-CN'));
  for (const path of ['/api/catalog/prices', '/api/catalog/prices?product_codes=a,b,c,d,e', '/api/catalog/prices?product_codes=product_a&url=https://evil.test']) assert.equal((await read(path)).status, 400);
  assert.equal(calls.length, 2);
});

test('Worker limits price aggregation response bodies to2MiB while ordinary catalog limits remain unchanged', async () => {
  const size = 2 * 1024 * 1024 + 1;
  const fetch = createWorkerGateway({ env: { DIDA_API_KEY: 'TEST-PRICE-SIZE-ONLY' }, fetchImpl: async () => new Response(JSON.stringify({ success: true, data: [] }), { headers: { 'content-length': String(size) } }) });
  const response = await fetch(new Request('https://ant.test/api/catalog/prices?product_codes=product_a'));
  assert.equal((await response.json()).data.prices[0].reason, 'supplier_unavailable');
  const ordinary = await fetch(new Request('https://ant.test/api/catalog/cities'));
  assert.equal(ordinary.status, 200);
  assert.equal((await ordinary.json()).success, true);
});
