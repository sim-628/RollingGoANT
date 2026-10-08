import { HttpError, isObject, moneyUnits } from './gateway-core.mjs';

const MAX_PRODUCTS = 4;
const MAX_SKUS = 100;
const CACHE_MS = 30_000;
const MAX_PENDING = 20;
const PRICE_TIMEOUT_MS = 22_000;
const MAX_PRICE_RESPONSE_BYTES = 2 * 1024 * 1024;
const CODE = /^[A-Za-z0-9_-]{1,128}$/;
const DAY_MS = 86_400_000;

export function validatePriceCodes(value) {
  const codes = typeof value === 'string' ? value.split(',') : [];
  if (!codes.length || codes.length > MAX_PRODUCTS || codes.some(code => !CODE.test(code)) || new Set(codes).size !== codes.length) {
    throw new HttpError(400, 'INVALID_QUERY', `product_codes 须为 1 至 ${MAX_PRODUCTS} 个不重复的商品编码`);
  }
  return codes;
}

function localDate(time, zone = '+08:00') {
  const offset = typeof zone === 'string' && zone.match(/^([+-])(\d{2}):(\d{2})$/);
  if (offset && Number(offset[2]) <= 14 && Number(offset[3]) < 60) {
    const minutes = (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '-' ? -1 : 1);
    return new Date(time + minutes * 60_000).toISOString().slice(0, 10);
  }
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(time);
    const field = type => parts.find(part => part.type === type)?.value;
    return `${field('year')}-${field('month')}-${field('day')}`;
  } catch { return new Date(time + 8 * 3_600_000).toISOString().slice(0, 10); }
}

function eligibleSkus(pkg) {
  if (!Array.isArray(pkg.sku_list) || pkg.sku_list.some(sku => !isObject(sku))) return null;
  const kind = sku => {
    const type = String(sku.sku_type || '');
    const title = String(sku.title || '');
    // Explicit supplier age categories take precedence over marketing titles
    // such as a CHILD SKU named "Child with adult".
    if (/child|infant|baby/i.test(type)) return 'accompaniment';
    if (/adult/i.test(type)) return 'adult';
    if (/child|infant|baby|儿童|兒童|婴儿|嬰兒/i.test(title)) return 'accompaniment';
    return /adult|成人/i.test(title) ? 'adult' : 'general';
  };
  const adults = pkg.sku_list.filter(sku => kind(sku) === 'adult');
  // A free infant/child accompaniment must never advertise an adult activity as
  // free. Packages without age categories still include person/group/ticket SKUs.
  return adults.length ? adults : pkg.sku_list.filter(sku => kind(sku) === 'general');
}

function utcTime(value) {
  if (typeof value !== 'string') return NaN;
  const iso = value.replace(' ', 'T');
  return Date.parse(/Z$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
}

/** Display-only minima. Booking always obtains a fresh calendar and final quote. */
export function createCatalogPriceService({ upstream, now = Date.now, priceTimeoutMs = PRICE_TIMEOUT_MS }) {
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  let active = 0;
  function release() {
    const next = queue.shift();
    if (next) next.resolve(); else active--;
  }
  async function limitedRead(path, query, signal) {
    signal.throwIfAborted();
    if (active >= 4) await new Promise((resolve, reject) => {
      const abort = () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason);
      };
      const waiter = { resolve: () => { signal.removeEventListener('abort', abort); resolve(); } };
      queue.push(waiter);
      signal.addEventListener('abort', abort, { once: true });
    });
    else active++;
    try {
      signal.throwIfAborted();
      return await upstream(path, 'GET', query, undefined, { signal, maxResponseBytes: MAX_PRICE_RESPONSE_BYTES });
    } finally { release(); }
  }

  // Details are reduced in this separate scope so large descriptions and
  // images are not retained while a product waits for its calendar batches.
  async function readProduct(productCode, time, signal) {
      const detail = await limitedRead(`/products/${encodeURIComponent(productCode)}`, '', signal);
      if (detail.status !== 200 || !detail.data.success) return { status: 'error', reason: 'supplier_unavailable' };
      const product = detail.data.data;
      if (!isObject(product) || product.product_code !== productCode || !Array.isArray(product.package_list)) return { reason: 'incomplete_data' };
      const packages = product.package_list;
      const skuPackages = new Map();
      for (const pkg of packages) {
        if (!isObject(pkg) || !CODE.test(pkg.package_code || '')) return { reason: 'incomplete_data' };
        const skus = eligibleSkus(pkg);
        if (!skus) return { reason: 'incomplete_data' };
        for (const sku of skus) {
          if (!isObject(sku) || !CODE.test(sku.sku_code || '') || (skuPackages.has(sku.sku_code) && skuPackages.get(sku.sku_code) !== pkg.package_code)) return { reason: 'incomplete_data' };
          skuPackages.set(sku.sku_code, pkg.package_code);
        }
      }
      const codes = [...skuPackages.keys()];
      if (!codes.length) return { reason: 'no_eligible_skus' };
      if (codes.length > MAX_SKUS) return { reason: 'too_many_skus' };
      // The supplier rejects dates before today's Asia/Shanghai date even for
      // destinations further west. The common window is also never in the past
      // for any package's destination. 90 inclusive calendar dates stay below
      // the supplier's 90-day elapsed-time limit.
      const start = [localDate(time), ...packages.map(pkg => localDate(time, pkg.time_zone))].sort().at(-1);
      const end = new Date(Date.parse(`${start}T00:00:00Z`) + 89 * DAY_MS).toISOString().slice(0, 10);
      const window = { start_date: start, end_date: end, basis: 'adult_or_general_unit' };
      return { codes, skuPackages, window };
  }

  // Only the reduced decimal/currency state leaves this scope. Each batch's
  // calendar rows can be discarded before any later request starts.
  async function readBatch(batch, skuPackages, window, time, signal) {
      const { start_date: start, end_date: end } = window;
      const query = new URLSearchParams({ sku_codes: batch.join(','), start_date: `${start} 00:00:00`, end_date: `${end} 23:59:59` });
      query.sort();
      const result = await limitedRead('/skus/calendar', query.toString(), signal);
      if (result.status !== 200 || !result.data.success) return { status: 'error', reason: 'supplier_unavailable' };
      if (!Array.isArray(result.data.data) || result.data.data.length !== batch.length || result.data.data.some(sku => !isObject(sku) || !batch.includes(sku.sku_code)) || new Set(result.data.data.map(sku => sku.sku_code)).size !== batch.length) return { reason: 'incomplete_data' };
      let minimum;
      const currencies = new Set();
      for (const sku of result.data.data) {
        if (sku.package_code !== skuPackages.get(sku.sku_code) || !Array.isArray(sku.calendars) || ![0, 1].includes(sku.publish_status)) return { reason: 'incomplete_data' };
        if (sku.publish_status !== 1) continue;
        for (const month of sku.calendars) {
          if (!isObject(month) || !Array.isArray(month.dates)) return { reason: 'incomplete_data' };
          for (const row of month.dates) {
            if (!isObject(row) || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.date)) return { reason: 'incomplete_data' };
            if (row.date.slice(0, 10) < start || row.date.slice(0, 10) > end) continue;
            if (!Number.isInteger(row.inventory)) return { reason: 'incomplete_data' };
            if (row.inventory <= 0) continue;
            if (row.cutoff_time_utc != null) {
              const cutoff = utcTime(row.cutoff_time_utc);
              if (!Number.isFinite(cutoff)) return { reason: 'incomplete_data' };
              if (cutoff <= time) continue;
            }
            const units = moneyUnits(row.selling_price);
            if (units === null || typeof sku.currency !== 'string' || !/^[A-Z]{3}$/.test(sku.currency)) return { reason: 'incomplete_data' };
            currencies.add(sku.currency);
            if (!minimum || units < minimum.units) minimum = { units, price: row.selling_price, currency: sku.currency };
          }
        }
      }
      return { minimum, currencies };
  }

  async function resolvePrice(productCode) {
    const time = now();
    const base = { product_code: productCode, status: 'unavailable', price: null, currency: null };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('Price deadline', 'TimeoutError')), priceTimeoutMs);
    try {
      const product = await readProduct(productCode, time, controller.signal);
      if (product.reason) return { ...base, ...product };
      const { codes, skuPackages, window } = product;
      let minimum;
      const currencies = new Set();
      for (let index = 0; index < codes.length; index += 20) {
        const batch = await readBatch(codes.slice(index, index + 20), skuPackages, window, time, controller.signal);
        if (batch.reason) return { ...base, ...window, ...batch };
        for (const currency of batch.currencies) currencies.add(currency);
        if (currencies.size > 1) return { ...base, ...window, reason: 'mixed_currencies' };
        if (batch.minimum && (!minimum || batch.minimum.units < minimum.units)) minimum = batch.minimum;
      }
      return minimum ? { ...base, ...window, status: 'ready', price: minimum.price, currency: minimum.currency } : { ...base, ...window, reason: 'no_available_price' };
    } catch { return { ...base, status: 'error', reason: controller.signal.aborted ? 'price_timeout' : 'supplier_unavailable' }; }
    finally { clearTimeout(timer); }
  }

  async function getPrice(code) {
    const cached = cache.get(code);
    if (cached && cached.expires > now()) return cached.price;
    if (pending.has(code)) return pending.get(code);
    if (pending.size >= MAX_PENDING) return { product_code: code, status: 'error', price: null, currency: null, reason: 'price_busy' };
    const promise = resolvePrice(code).then(price => {
      // Failures are retryable. Never retain supplier credentials or details.
      if (price.status !== 'error') {
        if (cache.size >= 500) cache.delete(cache.keys().next().value);
        cache.set(code, { price, expires: now() + CACHE_MS });
      }
      return price;
    }).finally(() => pending.delete(code));
    pending.set(code, promise);
    return promise;
  }

  return async value => ({ success: true, data: { prices: await Promise.all(validatePriceCodes(value).map(getPrice)) } });
}
