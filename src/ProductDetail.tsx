import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost } from './api';
import type { BookingSelection, PackageData, ProductDetailData, SearchState } from './types';
import './detail.css';

type Sku = {
  sku_code: string;
  title: string;
  sku_type?: string | null;
  min_age?: number | null;
  max_age?: number | null;
  sku_min_pax?: number | null;
  sku_max_pax?: number | null;
  required?: boolean | null;
};
type PackageView = PackageData & {
  package_code: string;
  package_name: string;
  sku_list: Sku[];
  package_min_pax?: number | null;
  package_max_pax?: number | null;
  cancellation_desc?: string;
  voucher_usage_desc?: string;
  timeslot_type?: number | null;
  instant?: number | null;
  is_open_date?: number | null;
  time_zone?: string;
  sections?: unknown[];
  spec_attrs?: unknown[];
};
type CalendarDate = {
  date: string;
  selling_price: string;
  inventory: number;
  cutoff_time_utc?: string | null;
  [key: string]: unknown;
};
type CalendarSku = {
  sku_code: string;
  sku_title?: string;
  currency: string;
  publish_status?: number;
  calendars: { month: string; dates: CalendarDate[] }[];
};
type Availability = { items: { sku_code: string; available: boolean; selling_price: string; currency: string }[] };

function Icon({ name, size = 22 }: { name: 'back' | 'next' | 'pin' | 'calendar' | 'check' | 'share' | 'image' | 'minus' | 'plus' | 'clock'; size?: number }) {
  const paths: Record<string, string> = {
    back: 'm14 5-7 7 7 7', next: 'm9 5 7 7-7 7', pin: 'M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0ZM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
    calendar: 'M5 5h14a2 2 0 0 1 2 2v13H3V7a2 2 0 0 1 2-2ZM3 10h18M7 3v4M17 3v4M7 14h2M13 14h2M7 17h2',
    check: 'm5 12 4 4L19 6',
    share: 'M15 8a3 3 0 1 0 0-4 3 3 0 0 0 0 4ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.5 10.5l7-4M8.5 13.5l7 4',
    image: 'M3 3h18v18H3V3ZM3 17l6-6 4 4 3-3 5 5M17 7h.01', minus: 'M5 12h14', plus: 'M5 12h14M12 5v14', clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3 2',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function localDate(timeZone = 'Asia/Shanghai') {
  const offset = String(timeZone).match(/^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (offset) {
    const hours = Number(offset[2]);
    const minutes = Number(offset[3] || 0);
    if (hours <= 14 && minutes < 60 && !(hours === 14 && minutes !== 0)) {
      const direction = offset[1] === '+' ? 1 : -1;
      return new Date(Date.now() + direction * (hours * 60 + minutes) * 60_000).toISOString().slice(0, 10);
    }
  }
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)?.value).join('-');
  } catch { return localDate('Asia/Shanghai'); }
}
function addMonths(month: string, delta: number) {
  const [year, number] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, number - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}
function addDays(date: string, delta: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + delta);
  return value.toISOString().slice(0, 10);
}
function monthEnd(month: string) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
}
function money(value: number | string, currency?: string | null) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '价格待确认';
  if (!currency) return `${amount.toFixed(2)}`;
  try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount); }
  catch { return `${currency} ${amount.toFixed(2)}`; }
}
function plainText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const doc = new DOMParser().parseFromString(value, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, template').forEach(node => node.remove());
  doc.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  doc.querySelectorAll('p, li, div, h1, h2, h3, h4').forEach(node => node.append('\n'));
  return (doc.body.textContent || '').replace(/\n\s*\n\s*\n/g, '\n\n').replace(/^\s*#{1,6}\s+/gm, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').trim();
}
function textFrom(value: unknown, depth = 0): string {
  if (depth > 4) return '';
  if (typeof value === 'string') return plainText(value);
  if (Array.isArray(value)) return value.map(item => textFrom(item, depth + 1)).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  if (typeof item.content_plain === 'string' && item.content_plain.trim()) return item.content_plain.replace(/\r\n?/g, '\n').trim();
  if (typeof item.content_markdown === 'string' && item.content_markdown.trim()) {
    return plainText(item.content_markdown).replace(/^\s*#{1,6}\s+/gm, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1');
  }
  return ['content', 'text', 'description', 'html', 'body', 'items', 'paragraphs', 'value', 'details'].map(key => textFrom(item[key], depth + 1)).filter(Boolean).join('\n');
}
function sectionViews(sections: unknown) {
  if (!Array.isArray(sections)) return [];
  return sections.flatMap((section, index) => {
    if (!section || typeof section !== 'object') return [];
    const item = section as Record<string, unknown>;
    const title = plainText(item.title || item.name || item.section_title || item.heading || (String(item.group_name || '').includes('自由文本') ? item.section_name : item.group_name) || item.section_name);
    const content = textFrom(item);
    return content ? [{ title: title || '活动信息', content, key: `${String(item.id || item.key || item.ref_field_tag || 'section')}-${index}`, isFact: item.group_type_name === 'icon' }] : [];
  });
}
function bookable(row?: CalendarDate, published?: number) {
  if (!row || published === 0 || !Number.isFinite(Number(row.inventory)) || Number(row.inventory) <= 0 || row.selling_price == null || row.selling_price === '' || !Number.isFinite(Number(row.selling_price)) || Number(row.selling_price) < 0) return false;
  if (row.cutoff_time_utc) {
    const cutoff = Date.parse(row.cutoff_time_utc.includes('T') ? (/Z$|[+-]\d{2}:?\d{2}$/.test(row.cutoff_time_utc) ? row.cutoff_time_utc : `${row.cutoff_time_utc}Z`) : `${row.cutoff_time_utc.replace(' ', 'T')}Z`);
    if (Number.isFinite(cutoff) && cutoff <= Date.now()) return false;
  }
  return true;
}
function realTimeSlots(rows: CalendarDate[]) {
  const slots = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const match = value.match(/(?:^|\s|T)(\d{2}:\d{2}(?::\d{2})?)(?:$|Z)/);
    if (match && match[1] !== '00:00:00' && match[1] !== '00:00') slots.add(match[1].length === 5 ? `${match[1]}:00` : match[1]);
  };
  rows.forEach(row => {
    ['start_time', 'session_start_time', 'time_slot', 'time', 'date'].forEach(key => add(row[key]));
    ['time_slots', 'sessions', 'slots'].forEach(key => {
      if (Array.isArray(row[key])) (row[key] as unknown[]).forEach(slot => {
        if (typeof slot === 'string') add(slot);
        else if (slot && typeof slot === 'object') ['start_time', 'time', 'time_slot', 'session_start_time'].forEach(field => add((slot as Record<string, unknown>)[field]));
      });
    });
  });
  return [...slots].sort();
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : '暂时无法获取活动信息，请稍后重试';
}
function requiresUnsupportedConfirmation(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(requiresUnsupportedConfirmation);
  if (!value || typeof value !== 'object') return false;
  const field = value as Record<string, unknown>;
  return Boolean(field.required && field.input_type === 'checkbox')
    || ['booking_extra_info', 'unit_extra_info', 'options'].some(key => requiresUnsupportedConfirmation(field[key]));
}

export default function ProductDetail({ productCode, search, onBack, onBook }: { productCode: string; search: SearchState; onBack: () => void; onBook: (booking: BookingSelection) => void }) {
  const [product, setProduct] = useState<ProductDetailData | null>(null);
  const [productError, setProductError] = useState('');
  const [productLoading, setProductLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [selectedCode, setSelectedCode] = useState('');
  const [imageIndex, setImageIndex] = useState(0);
  const [failedImages, setFailedImages] = useState<string[]>([]);
  const [activeSection, setActiveSection] = useState('ant-packages');
  const [toast, setToast] = useState('');
  const [date, setDate] = useState('');
  const [month, setMonth] = useState(localDate().slice(0, 7));
  const [calendars, setCalendars] = useState<CalendarSku[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarError, setCalendarError] = useState('');
  const [calendarReload, setCalendarReload] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [time, setTime] = useState('');
  const [bookingError, setBookingError] = useState('');
  const [bookingLoading, setBookingLoading] = useState(false);
  const bookingRef = useRef<HTMLElement>(null);
  const packages = (product?.package_list || []) as PackageView[];
  const selectedPackage = packages.find(item => item.package_code === selectedCode) || null;
  const destinationToday = localDate(selectedPackage?.time_zone);
  const minimumDate = [selectedPackage?.timeslot_type === 1 ? destinationToday : addDays(destinationToday, 1), localDate('Asia/Shanghai')].sort().at(-1)!;
  const images = (product?.images || []).filter(image => typeof image.image_url === 'string' && /^https?:\/\//i.test(image.image_url));
  const hasProductPrice = product?.price != null && String(product.price).trim() !== '' && Number.isFinite(Number(product.price)) && Number(product.price) >= 0;

  useEffect(() => {
    let active = true;
    setProductLoading(true); setProductError(''); setProduct(null); setSelectedCode('');
    apiGet<ProductDetailData>(`/api/catalog/products/${encodeURIComponent(productCode)}`).then(data => {
      if (!active) return;
      setProduct(data); setSelectedCode(data.package_list?.[0]?.package_code || ''); setImageIndex(0); setFailedImages([]);
    }).catch(error => { if (active) setProductError(errorText(error)); }).finally(() => { if (active) setProductLoading(false); });
    return () => { active = false; };
  }, [productCode, reload]);

  useEffect(() => {
    if (!selectedPackage) return;
    const primary = selectedPackage.sku_list?.find(sku => /adult|成人/i.test(`${sku.sku_type || ''} ${sku.title}`)) || selectedPackage.sku_list?.[0];
    const initial: Record<string, number> = {};
    (selectedPackage.sku_list || []).forEach(sku => {
      const requiredMin = sku.required ? Math.max(1, sku.sku_min_pax || 0) : 0;
      const chosen = sku.sku_code === primary?.sku_code ? Math.max(requiredMin, 1, sku.sku_min_pax || 0) : requiredMin;
      initial[sku.sku_code] = Math.min(99, chosen, sku.sku_max_pax && sku.sku_max_pax > 0 ? sku.sku_max_pax : Infinity);
    });
    setCounts(initial);
    const initialDate = minimumDate;
    setDate(initialDate); setMonth(initialDate.slice(0, 7)); setTime(''); setBookingError('');
  // The package choice initializes counts once; changing counts must not reset the selection.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCode, product]);

  useEffect(() => {
    if (!selectedPackage?.sku_list?.length) { setCalendars([]); return; }
    let active = true;
    setCalendarLoading(true); setCalendarError(''); setCalendars([]); setTime(''); setBookingError('');
    const start = `${month}-01` < minimumDate ? minimumDate : `${month}-01`;
    const end = monthEnd(month);
    if (end < start) { setMonth(minimumDate.slice(0, 7)); return; }
    const skus = selectedPackage.sku_list.map(sku => sku.sku_code);
    const batches: string[][] = [];
    for (let index = 0; index < skus.length; index += 20) batches.push(skus.slice(index, index + 20));
    Promise.all(batches.map(batch => apiGet<CalendarSku[]>('/api/catalog/skus/calendar', { sku_codes: batch.join(','), start_date: `${start} 00:00:00`, end_date: `${end} 23:59:59` }))).then(data => {
      if (!active) return;
      const result = data.flat();
      setCalendars(result);
      const availableDates = result.flatMap(sku => (sku.calendars || []).flatMap(calendar => (calendar.dates || []).filter(row => bookable(row, sku.publish_status)).map(row => row.date.slice(0, 10)))).filter(value => value >= minimumDate).sort();
      setDate(current => current.startsWith(month) && availableDates.includes(current) ? current : availableDates[0] || '');
    }).catch(error => { if (active) setCalendarError(errorText(error)); }).finally(() => { if (active) setCalendarLoading(false); });
    return () => { active = false; };
  // Request a new calendar only when the package or displayed month changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCode, product, month, calendarReload]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const skuRows = useMemo(() => (selectedPackage?.sku_list || []).map(sku => {
    const calendar = calendars.find(item => item.sku_code === sku.sku_code);
    const row = calendar?.calendars?.flatMap(group => group.dates || []).find(item => item.date.slice(0, 10) === date);
    return { sku, calendar, row, available: bookable(row, calendar?.publish_status) };
  }), [selectedPackage, calendars, date]);
  const selectedRows = skuRows.filter(item => (counts[item.sku.sku_code] || 0) > 0);
  const slots = realTimeSlots(selectedRows.flatMap(item => item.row ? [item.row] : []));
  const requiresTime = selectedPackage?.timeslot_type === 1;
  const bookingTime = requiresTime ? (time || (slots.length === 1 ? slots[0] : '')) : '00:00:00';
  const currencies = [...new Set(selectedRows.map(item => item.calendar?.currency).filter(Boolean))];
  const currency = currencies[0] || product?.currency || '';
  const total = selectedRows.reduce((sum, item) => sum + Number(item.row?.selling_price || 0) * counts[item.sku.sku_code], 0);
  const totalCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
  let selectionError = '';
  if (!selectedPackage) selectionError = '请选择套餐';
  else if (!date) selectionError = '请选择可预订的日期';
  else if (!selectedRows.length) selectionError = '请选择参加人数';
  else if (selectedRows.some(item => !item.available)) selectionError = '所选人数类型在该日期暂不可预订，请调整日期或人数';
  else if (selectedRows.some(item => counts[item.sku.sku_code] > Number(item.row?.inventory || 0))) selectionError = '所选人数超过余量，请调整人数';
  else if (skuRows.some(item => item.sku.required && !counts[item.sku.sku_code])) selectionError = '请选择套餐要求的人数类型';
  else if (selectedRows.some(item => (item.sku.sku_min_pax && counts[item.sku.sku_code] < item.sku.sku_min_pax) || (item.sku.sku_max_pax && counts[item.sku.sku_code] > item.sku.sku_max_pax))) selectionError = '人数不符合套餐要求，请调整';
  else if (selectedPackage.package_min_pax && totalCount < selectedPackage.package_min_pax) selectionError = `此套餐至少需要 ${selectedPackage.package_min_pax} 人`;
  else if (selectedPackage.package_max_pax && totalCount > selectedPackage.package_max_pax) selectionError = `此套餐最多可选择 ${selectedPackage.package_max_pax} 人`;
  else if (currencies.length > 1) selectionError = '此套餐价格币种不一致，请选择其他套餐';
  else if (requiresTime && !bookingTime) selectionError = slots.length ? '请选择活动场次' : '此套餐需选择场次，当前暂未开放场次预订';

  const mainSku = selectedPackage?.sku_list?.find(sku => /adult|成人/i.test(`${sku.sku_type || ''} ${sku.title}`)) || selectedPackage?.sku_list?.[0];
  const mainCalendar = calendars.find(item => item.sku_code === mainSku?.sku_code);
  const referenceRow = mainCalendar?.calendars?.flatMap(group => group.dates || []).find(item => item.date.slice(0, 10) === date);
  const hasCalendarReference = bookable(referenceRow, mainCalendar?.publish_status);
  const referencePrice = hasCalendarReference ? referenceRow!.selling_price : hasProductPrice ? product!.price : null;
  const referenceCurrency = hasCalendarReference ? mainCalendar?.currency : product?.currency;
  const apiLocation = plainText(product?.location);
  const locationIsCoordinates = /^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(apiLocation);
  const locationLabel = (!locationIsCoordinates && apiLocation) || plainText(product?.address) || plainText(product?.city_info?.[0]?.city_name) || search.destination?.name;
  const days = Array.from({ length: Number(monthEnd(month).slice(-2)) }, (_, index) => {
    const value = `${month}-${String(index + 1).padStart(2, '0')}`;
    const row = mainCalendar?.calendars?.flatMap(group => group.dates || []).find(item => item.date.slice(0, 10) === value);
    const anyAvailable = calendars.some(sku => bookable(sku.calendars?.flatMap(group => group.dates || []).find(item => item.date.slice(0, 10) === value), sku.publish_status));
    return { value, row, available: value >= minimumDate && anyAvailable };
  });
  const firstDay = (new Date(`${month}-01T12:00:00Z`).getUTCDay() + 6) % 7;
  const sections = sectionViews(product?.sections);
  const quickFacts = sections.filter(section => section.isFact);
  const contentSections = sections.filter(section => !section.isFact);
  const packageSections = sectionViews(selectedPackage?.sections);

  async function proceed() {
    if (!product || !selectedPackage || calendarLoading || bookingLoading) return;
    if (selectionError) { setBookingError(selectionError); bookingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    setBookingLoading(true); setBookingError('');
    try {
      const skus = selectedRows.map(item => ({ sku_code: item.sku.sku_code, title: item.sku.title, count: counts[item.sku.sku_code], price: item.row!.selling_price, currency: item.calendar!.currency }));
      const [extraInfo, availability] = await Promise.all([
        apiGet<unknown>('/api/catalog/packages/extra-info', { package_codes: selectedPackage.package_code }),
        apiPost<Availability>('/api/availability-check', [{ package_code: selectedPackage.package_code, start_time: `${date} ${bookingTime}`, sku_list: skus.map(sku => ({ sku_code: sku.sku_code, count: sku.count, price: sku.price })) }]),
      ]);
      if (requiresUnsupportedConfirmation(extraInfo)) throw new Error('该套餐暂不支持在线预订，请选择其他套餐。');
      if (!Array.isArray(availability.items) || skus.some(sku => !availability.items.find(item => item.sku_code === sku.sku_code && item.available))) throw new Error('所选日期或人数暂不可预订，请重新选择');
      const liveSkus = skus.map(sku => {
        const quote = availability.items.find(item => item.sku_code === sku.sku_code)!;
        if (quote.selling_price == null || quote.selling_price === '' || !Number.isFinite(Number(quote.selling_price)) || Number(quote.selling_price) < 0) throw new Error('暂时无法确认价格，请重试');
        return { ...sku, price: quote.selling_price, currency: quote.currency };
      });
      if (new Set(liveSkus.map(sku => sku.currency)).size !== 1) throw new Error('套餐价格币种不一致，请重新选择');
      onBook({ product, package: selectedPackage, date, time: bookingTime, skus: liveSkus, total: liveSkus.reduce((sum, sku) => sum + Number(sku.price) * sku.count, 0), currency: liveSkus[0].currency, extraInfo });
    } catch (error) {
      setBookingError(errorText(error));
    } finally { setBookingLoading(false); }
  }

  async function share() {
    try {
      if (navigator.share) await navigator.share({ title: product?.title || 'RollingGo 活动', url: window.location.href });
      else { await navigator.clipboard.writeText(window.location.href); setToast('活动链接已复制'); }
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setToast('暂时无法分享，请复制浏览器地址'); }
  }

  function scrollToSection(section: string) {
    setActiveSection(section);
    document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  if (productLoading || !product) return <div className="detail-page"><header className="detail-toolbar"><button className="detail-icon-button" aria-label="返回活动列表" onClick={onBack}><Icon name="back" /></button><span>活动详情</span><span /></header>{productLoading ? <div className="detail-loading"><div className="detail-skeleton detail-skeleton-hero" /><div className="detail-skeleton detail-skeleton-title" /><div className="detail-skeleton detail-skeleton-copy" /><div className="detail-skeleton detail-skeleton-copy" /><p>正在为你加载活动详情…</p></div> : <div className="detail-empty"><Icon name="image" size={44} /><h2>暂时无法查看此活动</h2><p>{productError || '活动信息暂不可用'}</p><button className="detail-primary" onClick={() => setReload(value => value + 1)}>重新加载</button><button className="detail-text-button" onClick={onBack}>返回活动列表</button></div>}</div>;

  return <div className="detail-page">
    <header className="detail-toolbar"><button className="detail-icon-button" aria-label="返回活动列表" onClick={onBack}><Icon name="back" /></button><span>活动详情</span><div className="detail-toolbar-actions"><button className="detail-icon-button" aria-label="分享活动" onClick={share}><Icon name="share" size={20} /></button></div></header>
    <div className="detail-gallery">
      {images.length && !failedImages.includes(images[imageIndex]?.image_url) ? <img src={images[imageIndex]?.image_url} alt={`${product.title} · 图片 ${imageIndex + 1}`} className="detail-hero-image" onError={() => setFailedImages(current => [...current, images[imageIndex].image_url])} /> : <div className="detail-no-image"><Icon name="image" size={48} /><span>{images.length ? '活动图片暂时无法显示' : '活动图片暂未提供'}</span></div>}
      {images.length > 1 && <><button className="detail-gallery-arrow detail-gallery-prev" aria-label="上一张活动图片" onClick={() => setImageIndex(index => (index - 1 + images.length) % images.length)}><Icon name="back" /></button><button className="detail-gallery-arrow detail-gallery-next" aria-label="下一张活动图片" onClick={() => setImageIndex(index => (index + 1) % images.length)}><Icon name="next" /></button><span className="detail-image-count"><Icon name="image" size={14} />{imageIndex + 1} / {images.length}</span><div className="detail-gallery-dots">{images.slice(0, 12).map((image, index) => <button key={`${image.image_url}-${index}`} className={imageIndex === index ? 'active' : ''} aria-label={`查看第 ${index + 1} 张图片`} onClick={() => setImageIndex(index)} />)}</div></>}
    </div>
    <div className="detail-main-grid">
      <div className="detail-overview">
        <section className="detail-heading">
          <div className="detail-eyebrow">{plainText(product.category_info?.leaf_category_name) || plainText(product.category_info?.sub_category_name) || '探索当地活动'}</div>
          <h1>{product.title}</h1>
          {product.subtitle && <p className="detail-subtitle">{plainText(product.subtitle)}</p>}
          {locationLabel && <div className="detail-location"><Icon name="pin" size={16} /><span>{locationLabel}</span></div>}
          <div className="detail-top-price">{referencePrice != null && <><strong>{money(referencePrice, referenceCurrency)}</strong><span>{hasCalendarReference && mainSku ? `${mainSku.title}单价` : '参考价'}</span></>}</div>
          {quickFacts.length > 0 && <div className="detail-quick-facts">{quickFacts.map(section => <div key={section.key}><span>{section.title}</span><strong>{section.content.startsWith(`${section.title}：`) ? section.content.slice(section.title.length + 1).trim() : section.content}</strong></div>)}</div>}
        </section>
        <nav className="detail-section-nav" aria-label="活动详情栏目">{[['ant-packages', '选择套餐'], ['ant-introduction', '活动介绍'], ['ant-information', '使用须知']].map(([section, label]) => <button key={section} className={activeSection === section ? 'active' : ''} onClick={() => scrollToSection(section)}>{label}</button>)}</nav>
        {product.description && <section className="detail-content-card detail-description" id="ant-introduction"><h2>活动亮点</h2><p className="detail-rich-text">{plainText(product.description)}</p></section>}
        {!product.description && <span id="ant-introduction" />}
        {contentSections.map(section => <section className="detail-content-card" key={section.key}><h2>{section.title}</h2><p className="detail-rich-text">{section.content}</p></section>)}
        <section className="detail-content-card detail-practical" id="ant-information">
          <h2>使用须知</h2>
          {product.address && <div className="detail-practical-row"><Icon name="pin" size={20} /><div><h3>活动地点</h3><p>{plainText(product.address)}</p></div></div>}
          {selectedPackage?.voucher_usage_desc && <div className="detail-practical-row"><Icon name="check" size={20} /><div><h3>凭证使用方式</h3><p className="detail-rich-text">{plainText(selectedPackage.voucher_usage_desc)}</p></div></div>}
          {selectedPackage?.cancellation_desc && <div className="detail-practical-row"><Icon name="calendar" size={20} /><div><h3>取消政策</h3><p className="detail-rich-text">{plainText(selectedPackage.cancellation_desc)}</p></div></div>}
          {Array.isArray(product.supported_languages) && product.supported_languages.length > 0 && <div className="detail-practical-row"><Icon name="check" size={20} /><div><h3>支持语言</h3><p>{product.supported_languages.join(' · ')}</p></div></div>}
          {!product.address && !selectedPackage?.voucher_usage_desc && !selectedPackage?.cancellation_desc && !product.supported_languages?.length && <p className="detail-muted">请选择套餐，查看适用的预订与使用信息。</p>}
        </section>
      </div>
      <section className="detail-booking-panel" id="ant-packages" ref={bookingRef}>
        <div className="detail-booking-title"><span className="detail-title-icon"><Icon name="calendar" size={22} /></span><div><h2>选择套餐</h2><p>选好你的下一段精彩旅程</p></div></div>
        {!packages.length ? <div className="detail-empty-small">此活动暂未开放可预订套餐</div> : <>
          <div className="detail-package-list">{packages.map(item => <button key={item.package_code} className={`detail-package-card ${selectedCode === item.package_code ? 'selected' : ''}`} onClick={() => setSelectedCode(item.package_code)} aria-pressed={selectedCode === item.package_code}><div><strong>{item.package_name}</strong></div><span className="detail-package-radio">{selectedCode === item.package_code && <Icon name="check" size={13} />}</span></button>)}</div>
          {packageSections.length > 0 && <details className="detail-package-inclusions"><summary>查看套餐详情 <Icon name="next" size={15} /></summary>{packageSections.map(section => <div key={section.key}><h4>{section.title}</h4><p className="detail-rich-text">{section.content}</p></div>)}</details>}
          <div className="detail-booking-divider" />
          <div className="detail-field-heading"><h3>选择日期</h3><span>目的地当地日期</span></div>
          <div className="detail-calendar">
            <div className="detail-calendar-header"><button className="detail-icon-button" aria-label="上一个月" disabled={month <= minimumDate.slice(0, 7)} onClick={() => { setMonth(value => addMonths(value, -1)); setDate(''); }}><Icon name="back" size={18} /></button><strong>{Number(month.slice(0, 4))} 年 {Number(month.slice(5))} 月</strong><button className="detail-icon-button" aria-label="下一个月" onClick={() => { setMonth(value => addMonths(value, 1)); setDate(''); }}><Icon name="next" size={18} /></button></div>
            <div className="detail-calendar-weekdays">{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}</div>
            <div className={`detail-calendar-days ${calendarLoading ? 'is-loading' : ''}`}>{Array.from({ length: firstDay }, (_, index) => <span key={`empty-${index}`} />)}{days.map(day => <button key={day.value} className={`detail-calendar-day ${date === day.value && day.available ? 'selected' : ''}`} disabled={calendarLoading || !day.available} aria-label={`${day.value}${day.available ? `，${day.row ? money(day.row.selling_price, mainCalendar?.currency) : '可预订'}` : '，不可预订'}`} aria-pressed={date === day.value} onClick={() => { setDate(day.value); setTime(''); setBookingError(''); }}><span>{Number(day.value.slice(-2))}</span><small>{calendarLoading ? '·' : day.available ? day.row && bookable(day.row, mainCalendar?.publish_status) ? Number(day.row.selling_price).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '可订' : '—'}</small></button>)}</div>
            {calendarLoading && <p className="detail-calendar-note">正在查询可预订日期与价格…</p>}
            {!calendarLoading && !calendarError && <p className="detail-calendar-note">{mainCalendar?.currency ? `价格以 ${mainCalendar.currency} 计，最终总价依所选人数计算` : '选择日期后查看对应价格'}</p>}
            {calendarError && <div className="detail-inline-error" role="alert"><span>{calendarError}</span><button onClick={() => setCalendarReload(value => value + 1)}>重新查询</button></div>}
            {!calendarLoading && !calendarError && !days.some(day => day.available) && <div className="detail-empty-small">这个月暂时没有可预订日期，试试下个月</div>}
          </div>
          {requiresTime && <div className="detail-time-selection"><h3>选择场次</h3>{slots.length ? <div className="detail-time-slots">{slots.map(slot => <button key={slot} className={bookingTime === slot ? 'selected' : ''} onClick={() => { setTime(slot); setBookingError(''); }}><Icon name="clock" size={15} />{slot.slice(0, 5)}</button>)}</div> : <p className="detail-unavailable-time">该套餐需要选择场次，目前暂未开放场次预订。你可以选择其他套餐。</p>}</div>}
          <div className="detail-booking-divider" />
          <div className="detail-field-heading"><h3>选择数量</h3>{selectedPackage?.package_min_pax ? <span>至少 {selectedPackage.package_min_pax} 人</span> : <span>按实际参与人数选择</span>}</div>
          <div className="detail-sku-list">{skuRows.map(({ sku, row, calendar, available }) => {
            const count = counts[sku.sku_code] || 0;
            const min = sku.required ? Math.max(1, sku.sku_min_pax || 0) : 0;
            const max = Math.min(99, sku.sku_max_pax && sku.sku_max_pax > 0 ? sku.sku_max_pax : Infinity, row ? Number(row.inventory) : 0);
            const age = sku.min_age === 0 && sku.max_age === 0 ? '' : sku.min_age != null && sku.max_age != null ? `${sku.min_age}–${sku.max_age} 岁` : sku.min_age != null ? `${sku.min_age} 岁及以上` : sku.max_age != null ? `${sku.max_age} 岁及以下` : '';
            return <div className={`detail-sku-row ${!available ? 'unavailable' : ''}`} key={sku.sku_code}><div className="detail-sku-info"><h4>{sku.title}{Boolean(sku.required) && <span>必选</span>}</h4>{age && <small>{age}</small>}<strong>{calendarLoading ? '查询价格中…' : available && row ? money(row.selling_price, calendar?.currency) : date ? '此日期暂不可订' : '请先选择日期'}</strong></div><div className="detail-stepper"><button aria-label={`减少${sku.title}数量`} disabled={count <= min || bookingLoading} onClick={() => { setCounts(current => ({ ...current, [sku.sku_code]: Math.max(min, count - 1 < (sku.sku_min_pax || 0) ? 0 : count - 1) })); setBookingError(''); }}><Icon name="minus" size={16} /></button><span aria-live="polite">{count}</span><button aria-label={`增加${sku.title}数量`} disabled={!available || count >= max || calendarLoading || bookingLoading} onClick={() => { setCounts(current => ({ ...current, [sku.sku_code]: Math.min(max, count ? count + 1 : Math.max(1, sku.sku_min_pax || 0)) })); setBookingError(''); }}><Icon name="plus" size={16} /></button></div></div>;
          })}</div>
          {bookingError && <div className="detail-inline-error" role="alert"><span>{bookingError}</span><button onClick={() => { setBookingError(''); setCalendarReload(value => value + 1); }}>刷新价格</button></div>}
          <div className="detail-desktop-summary"><div><span>总价</span><strong>{date && selectedRows.length && selectedRows.every(row => row.available) ? money(total, currency) : '选择日期与人数'}</strong></div><button className="detail-primary" onClick={proceed} disabled={calendarLoading || bookingLoading || !selectedPackage || !selectedPackage.sku_list?.length}>{bookingLoading ? '正在确认…' : '立即预订'}</button>{selectionError && <small>{selectionError}</small>}</div>
        </>}
      </section>
    </div>
    <footer className="detail-mobile-booking"><div><small>{date && selectedRows.length && selectedRows.every(row => row.available) ? `${date.slice(5).replace('-', '月')}日 · ${totalCount} 人` : hasProductPrice ? '参考价' : '活动价格'}</small><strong>{date && selectedRows.length && selectedRows.every(row => row.available) ? money(total, currency) : hasProductPrice ? money(product.price!, product.currency) : '选择套餐'}</strong></div><button className="detail-primary" onClick={proceed} disabled={calendarLoading || bookingLoading || !packages.length}>{bookingLoading ? '正在确认…' : '立即预订'}</button></footer>
    {toast && <div className="detail-toast" role="status">{toast}</div>}
  </div>;
}
