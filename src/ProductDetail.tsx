import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { apiGet, apiPost, formatMoney as money } from './api';
import { categoryNameZh, locationLabelZh, placeNameZh } from './localization';
import type { BookingSelection, PackageData, ProductDetailData, SearchState } from './types';
import PriceSkeleton from './PriceSkeleton';
import './detail.css';
import './pickers.css';

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
type PackageQuotes = { key: string; loading: boolean; calendars: CalendarSku[]; failedSkus: string[] };

function Icon({ name, size = 22 }: { name: 'back' | 'next' | 'pin' | 'calendar' | 'check' | 'image' | 'minus' | 'plus' | 'clock' | 'close'; size?: number }) {
  const paths: Record<string, string> = {
    back: 'm14 5-7 7 7 7', next: 'm9 5 7 7-7 7', pin: 'M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0ZM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
    calendar: 'M5 5h14a2 2 0 0 1 2 2v13H3V7a2 2 0 0 1 2-2ZM3 10h18M7 3v4M17 3v4M7 14h2M13 14h2M7 17h2',
    check: 'm5 12 4 4L19 6', close: 'm6 6 12 12M18 6 6 18',
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
function sectionContent(value: string, title: string) {
  const normalize = (text: string) => text.replace(/^[\s#*•-]+|[\s:：*]+$/g, '').replace(/\s+/g, '').toLowerCase();
  const headingGroups = [
    ['取消政策', '退票政策', '退改政策', '退款政策', 'cancellationpolicy'],
    ['确认详情', '确认详细', '预订确认详情', '确认信息', 'confirmationdetails'],
    ['出发路线与时间安排', '出发路线时间安排', '路线与时间安排', '行程路线与时间安排', 'departureandreturn'],
    ['使用资格', '适用资格', '参加资格', '参与资格', 'eligibility'],
    ['注意事项', '温馨提示', 'additionalinformation'],
    ['费用包含', '费用包括', '包含项目', 'whatsincluded'],
    ['费用不包含', '费用不包括', '不包含项目', 'whatsnotincluded'],
  ];
  const normalizedTitle = normalize(title);
  const aliases = headingGroups.find(group => group.map(normalize).includes(normalizedTitle)) || [title];
  const repeatedHeadings = new Set(aliases.map(normalize));
  const lines = value.trim().split('\n');
  while (lines.length && (!lines[0].trim() || repeatedHeadings.has(normalize(lines[0])))) lines.shift();
  return lines.join('\n').trim();
}
function sectionViews(sections: unknown) {
  if (!Array.isArray(sections)) return [];
  return sections.flatMap((section, index) => {
    if (!section || typeof section !== 'object') return [];
    const item = section as Record<string, unknown>;
    const title = plainText(item.title || item.name || item.section_title || item.heading || (String(item.group_name || '').includes('自由文本') ? item.section_name : item.group_name) || item.section_name);
    const content = sectionContent(textFrom(item), title);
    return content ? [{ title: title || '活动信息', content, key: `${String(item.id || item.key || item.ref_field_tag || 'section')}-${index}`, refFieldTag: String(item.ref_field_tag || ''), isFact: item.group_type_name === 'icon' }] : [];
  });
}
function bookable(row?: CalendarDate, published?: number) {
  if (!row || published !== 1 || !Number.isInteger(row.inventory) || row.inventory <= 0 || row.selling_price == null || row.selling_price === '' || !Number.isFinite(Number(row.selling_price)) || Number(row.selling_price) < 0) return false;
  if (row.cutoff_time_utc) {
    const cutoff = Date.parse(row.cutoff_time_utc.includes('T') ? (/Z$|[+-]\d{2}:?\d{2}$/.test(row.cutoff_time_utc) ? row.cutoff_time_utc : `${row.cutoff_time_utc}Z`) : `${row.cutoff_time_utc.replace(' ', 'T')}Z`);
    if (!Number.isFinite(cutoff) || cutoff <= Date.now()) return false;
  }
  return true;
}
function representativeSku(item: PackageView) {
  const skus = item.sku_list || [];
  const kind = (sku: Sku) => {
    if (/child|infant|baby/i.test(sku.sku_type || '')) return 'child';
    if (/adult/i.test(sku.sku_type || '')) return 'adult';
    if (/child|infant|baby|儿童|兒童|婴儿|嬰兒|幼儿/i.test(sku.title)) return 'child';
    return /adult|成人/i.test(sku.title) ? 'adult' : 'general';
  };
  return skus.find(sku => kind(sku) === 'adult') || skus.find(sku => kind(sku) === 'general');
}
function minimumPackageDate(item?: PackageView | null) {
  const today = localDate(item?.time_zone);
  return [item?.timeslot_type === 1 ? today : addDays(today, 1), localDate('Asia/Shanghai')].sort().at(-1)!;
}
function calendarRow(calendar: CalendarSku | undefined, date: string) {
  return calendar?.calendars?.flatMap(group => group.dates || []).find(row => row.date.slice(0, 10) === date);
}
function quoteStatus(row?: CalendarDate, published?: number) {
  if (published === 0) return '该规格暂未开放';
  if (!row) return '此日期暂无报价';
  if (published !== 1) return '该规格开放状态待确认';
  if (row.selling_price == null || row.selling_price === '' || !Number.isFinite(Number(row.selling_price)) || Number(row.selling_price) < 0) return '此日期价格暂不可用';
  if (!Number.isInteger(row.inventory)) return '此日期库存待确认';
  if (Number(row.inventory) <= 0) return '此日期已售罄';
  return bookable(row, published) ? '' : '已过预订截止时间';
}
function mergeCalendarMonth(previous: CalendarSku[], incoming: CalendarSku[], month: string) {
  return incoming.map(sku => {
    const old = previous.find(item => item.sku_code === sku.sku_code);
    const dates = [...(old?.calendars || []).flatMap(group => group.dates || []).filter(row => !row.date.startsWith(month)), ...(sku.calendars || []).flatMap(group => group.dates || [])];
    const months = [...new Set(dates.map(row => row.date.slice(0, 7)))];
    return { ...sku, calendars: months.map(value => ({ month: value, dates: dates.filter(row => row.date.startsWith(value)) })) };
  });
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
  const [highlightsExpanded, setHighlightsExpanded] = useState(false);
  const [date, setDate] = useState('');
  const [month, setMonth] = useState(localDate().slice(0, 7));
  const [calendarData, setCalendarData] = useState<{ context: string; items: CalendarSku[] }>({ context: '', items: [] });
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarError, setCalendarError] = useState('');
  const [calendarReload, setCalendarReload] = useState(0);
  const [packagesExpanded, setPackagesExpanded] = useState(false);
  const [sheetView, setSheetView] = useState<'booking' | 'details' | 'date' | 'quantity' | null>(null);
  const [draftDate, setDraftDate] = useState('');
  const [draftCounts, setDraftCounts] = useState<Record<string, number>>({});
  const [packageQuotes, setPackageQuotes] = useState<PackageQuotes>({ key: '', loading: false, calendars: [], failedSkus: [] });
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [time, setTime] = useState('');
  const [bookingError, setBookingError] = useState('');
  const [bookingLoading, setBookingLoading] = useState(false);
  const bookingRef = useRef<HTMLElement>(null);
  const sheetRef = useRef<HTMLDialogElement>(null);
  const sheetTrigger = useRef<HTMLElement | null>(null);
  const detailsFromBooking = useRef(false);
  const pickerReturnView = useRef<'booking' | null>(null);
  const sheetOpen = sheetView !== null;
  const explicitDate = useRef(false);
  const dateRef = useRef(date);
  dateRef.current = date;
  const packages = (product?.package_list || []) as PackageView[];
  const selectedPackage = packages.find(item => item.package_code === selectedCode) || null;
  const destinationToday = localDate(selectedPackage?.time_zone);
  const minimumDate = minimumPackageDate(selectedPackage);
  const calendarContext = `${productCode}:${selectedCode}`;
  const calendars = calendarData.context === calendarContext ? calendarData.items : [];
  const representatives = useMemo(() => ((product?.package_list || []) as PackageView[]).map(item => ({ item, sku: representativeSku(item) })), [product]);
  const representativeCodes = [...new Set(representatives.flatMap(({ sku }) => sku ? [sku.sku_code] : []))].join(',');
  const quoteKey = `${productCode}:${date}:${representativeCodes}:${calendarReload}`;
  const images = (product?.images || []).filter(image => typeof image.image_url === 'string' && /^https?:\/\//i.test(image.image_url));
  const hasProductPrice = product?.price != null && String(product.price).trim() !== '' && Number.isFinite(Number(product.price)) && Number(product.price) >= 0;

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setProductLoading(true); setProductError(''); setProduct(null); setSelectedCode('');
    explicitDate.current = false;
    setDate(''); setCalendarData({ context: '', items: [] }); setPackagesExpanded(false); setHighlightsExpanded(false); setSheetView(null);
    apiGet<ProductDetailData>(`/api/catalog/products/${encodeURIComponent(productCode)}`, {}, { signal: controller.signal }).then(data => {
      if (!active) return;
      setProduct(data); setSelectedCode(data.package_list?.[0]?.package_code || ''); setImageIndex(0); setFailedImages([]);
    }).catch(error => { if (active) setProductError(errorText(error)); }).finally(() => { if (active) setProductLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [productCode, reload]);

  useEffect(() => {
    if (!selectedPackage) return;
    const primary = representativeSku(selectedPackage) || selectedPackage.sku_list?.[0];
    const initial: Record<string, number> = {};
    (selectedPackage.sku_list || []).forEach(sku => {
      const requiredMin = sku.required ? Math.max(1, sku.sku_min_pax || 0) : 0;
      const chosen = sku.sku_code === primary?.sku_code ? Math.max(requiredMin, 1, sku.sku_min_pax || 0) : requiredMin;
      initial[sku.sku_code] = Math.min(99, chosen, sku.sku_max_pax && sku.sku_max_pax > 0 ? sku.sku_max_pax : Infinity);
    });
    setCounts(initial);
    const initialDate = dateRef.current || minimumDate;
    setDate(initialDate); setMonth(initialDate.slice(0, 7)); setTime(''); setBookingError('');
  // The package choice initializes counts once; changing counts must not reset the selection.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCode, product]);

  useEffect(() => {
    const dialog = sheetRef.current;
    if (!sheetOpen || !dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (!dialog.open) dialog.showModal();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (sheetTrigger.current?.isConnected) sheetTrigger.current.focus();
    };
  }, [sheetOpen]);

  useEffect(() => {
    if (sheetView) sheetRef.current?.querySelector<HTMLButtonElement>('.detail-booking-sheet-header button')?.focus();
  }, [sheetView]);

  useEffect(() => {
    if (!selectedPackage?.sku_list?.length) { setCalendarData({ context: calendarContext, items: [] }); setCalendarLoading(false); return; }
    let active = true;
    const controller = new AbortController();
    setCalendarLoading(true); setCalendarError(''); setBookingError('');
    setCalendarData(previous => previous.context === calendarContext ? previous : { context: calendarContext, items: [] });
    const start = `${month}-01` < minimumDate ? minimumDate : `${month}-01`;
    const end = monthEnd(month);
    if (end < start) { setCalendarLoading(false); setMonth(minimumDate.slice(0, 7)); return; }
    const skus = selectedPackage.sku_list.map(sku => sku.sku_code);
    const batches: string[][] = [];
    for (let index = 0; index < skus.length; index += 20) batches.push(skus.slice(index, index + 20));
    Promise.all(batches.map(batch => apiGet<CalendarSku[]>('/api/catalog/skus/calendar', { sku_codes: batch.join(','), start_date: `${start} 00:00:00`, end_date: `${end} 23:59:59` }, { signal: controller.signal }))).then(data => {
      if (!active) return;
      const result = data.flat();
      setCalendarData(previous => ({ context: calendarContext, items: mergeCalendarMonth(previous.context === calendarContext ? previous.items : [], result, month) }));
      const availableDates = result.flatMap(sku => (sku.calendars || []).flatMap(calendar => (calendar.dates || []).filter(row => bookable(row, sku.publish_status)).map(row => row.date.slice(0, 10)))).filter(value => value >= minimumDate).sort();
      setDate(current => explicitDate.current || (current && !current.startsWith(month)) || availableDates.includes(current) ? current : availableDates[0] || '');
    }).catch(error => { if (active) setCalendarError(errorText(error)); }).finally(() => { if (active) setCalendarLoading(false); });
    return () => { active = false; controller.abort(); };
  // Request a new calendar only when the package or displayed month changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCode, product, month, calendarReload]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    if (!date || !representativeCodes) {
      setPackageQuotes({ key: quoteKey, loading: false, calendars: [], failedSkus: [] });
      return () => { active = false; controller.abort(); };
    }
    setPackageQuotes({ key: quoteKey, loading: true, calendars: [], failedSkus: [] });
    const codes = representativeCodes.split(',');
    const batches: string[][] = [];
    for (let index = 0; index < codes.length; index += 20) batches.push(codes.slice(index, index + 20));
    Promise.all(batches.map(async batch => {
      try {
        const rows = await apiGet<CalendarSku[]>('/api/catalog/skus/calendar', { sku_codes: batch.join(','), start_date: `${date} 00:00:00`, end_date: `${date} 23:59:59` }, { signal: controller.signal });
        return { rows, failedSkus: [] as string[] };
      } catch { return { rows: [] as CalendarSku[], failedSkus: batch }; }
    })).then(results => {
      if (active) setPackageQuotes({ key: quoteKey, loading: false, calendars: results.flatMap(result => result.rows), failedSkus: results.flatMap(result => result.failedSkus) });
    });
    return () => { active = false; controller.abort(); };
  }, [date, representativeCodes, quoteKey]);

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
  else if (date < minimumDate) selectionError = '所选日期在此套餐的预订范围之外，请重新选择日期';
  else if (!selectedRows.length) selectionError = '请选择参加人数';
  else if (selectedRows.some(item => !item.available)) selectionError = '所选人数类型在该日期暂不可预订，请调整日期或人数';
  else if (selectedRows.some(item => counts[item.sku.sku_code] > Number(item.row?.inventory || 0))) selectionError = '所选人数超过余量，请调整人数';
  else if (skuRows.some(item => item.sku.required && !counts[item.sku.sku_code])) selectionError = '请选择套餐要求的人数类型';
  else if (selectedRows.some(item => (item.sku.sku_min_pax && counts[item.sku.sku_code] < item.sku.sku_min_pax) || (item.sku.sku_max_pax && counts[item.sku.sku_code] > item.sku.sku_max_pax))) selectionError = '人数不符合套餐要求，请调整';
  else if (selectedPackage.package_min_pax && totalCount < selectedPackage.package_min_pax) selectionError = `此套餐至少需要 ${selectedPackage.package_min_pax} 人`;
  else if (selectedPackage.package_max_pax && totalCount > selectedPackage.package_max_pax) selectionError = `此套餐最多可选择 ${selectedPackage.package_max_pax} 人`;
  else if (currencies.length > 1) selectionError = '此套餐价格币种不一致，请选择其他套餐';
  else if (requiresTime && !bookingTime) selectionError = slots.length ? '请选择活动场次' : '此套餐需选择场次，当前暂未开放场次预订';

  const mainSku = selectedPackage ? representativeSku(selectedPackage) : undefined;
  const mainCalendar = calendars.find(item => item.sku_code === mainSku?.sku_code);
  const referenceRow = mainCalendar?.calendars?.flatMap(group => group.dates || []).find(item => item.date.slice(0, 10) === date);
  const hasCalendarReference = bookable(referenceRow, mainCalendar?.publish_status);
  const referencePrice = hasCalendarReference ? referenceRow!.selling_price : null;
  const referenceCurrency = mainCalendar?.currency;
  const apiLocation = plainText(product?.location);
  const locationIsCoordinates = /^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/.test(apiLocation);
  const cityName = plainText(product?.city_info?.[0]?.city_name) || search.destination?.name;
  const countryName = plainText(product?.city_info?.[0]?.country_name) || search.destination?.countryName;
  const locationLabel = cityName ? locationLabelZh(cityName, countryName) : (!locationIsCoordinates && apiLocation ? placeNameZh(apiLocation) : '');
  const days = Array.from({ length: Number(monthEnd(month).slice(-2)) }, (_, index) => {
    const value = `${month}-${String(index + 1).padStart(2, '0')}`;
    const row = mainCalendar?.calendars?.flatMap(group => group.dates || []).find(item => item.date.slice(0, 10) === value);
    const anyAvailable = calendars.some(sku => bookable(sku.calendars?.flatMap(group => group.dates || []).find(item => item.date.slice(0, 10) === value), sku.publish_status));
    return { value, row, available: value >= minimumDate && anyAvailable };
  });
  const firstDay = new Date(`${month}-01T12:00:00Z`).getUTCDay();
  const sections = sectionViews(product?.sections);
  const quickFacts = sections.filter(section => section.isFact).map(section => {
    const content = section.content.replace(/^\s*[-*•]\s+/gm, '').trim();
    const prefix = [`${section.title}：`, `${section.title}:`].find(value => content.startsWith(value));
    const value = (prefix ? content.slice(prefix.length) : content).trim().replace(/\s*\n+\s*/g, ' · ');
    return { ...section, value, isDuration: /活动时长|活动时间|duration/i.test(section.title) || /duration/i.test(section.refFieldTag) };
  }).sort((a, b) => Number(a.isDuration) - Number(b.isDuration));
  const highlightSections = sections.filter(section => section.refFieldTag === 'summary' || /^(活动亮点|行程亮点|highlights?)$/i.test(section.title));
  const highlightItems = highlightSections.flatMap(section => section.content.split(/\n+/).map(line => line.trim().replace(/^[-*•]\s+/, '')).filter(Boolean));
  const hasMoreHighlights = highlightItems.length > 1 || (highlightItems[0]?.length || 0) > 50;
  const contentSections = sections.filter(section => !section.isFact && !highlightSections.includes(section));
  const packageSections = sectionViews(selectedPackage?.sections);
  const hasMorePackageDescription = packageSections.length > 1 || packageSections.some(section => section.content.length > 100 || section.content.split('\n').length > 5);
  const quickDates = [...new Set((mainCalendar ? [mainCalendar] : calendars).flatMap(sku => (sku.calendars || []).flatMap(group => (group.dates || []).filter(row => bookable(row, sku.publish_status)).map(row => row.date.slice(0, 10)))))].filter(value => value >= minimumDate).sort().slice(0, 3);

  function chooseDate(value: string) {
    explicitDate.current = true;
    setDate(value); setMonth(value.slice(0, 7)); setTime(''); setBookingError('');
  }

  function choosePackage(value: string) {
    if (date) explicitDate.current = true;
    setSelectedCode(value);
  }

  function openSheet(view: 'booking' | 'details') {
    if (!sheetView) sheetTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    detailsFromBooking.current = view === 'details' && sheetView === 'booking';
    setSheetView(view);
  }

  function openPicker(view: 'date' | 'quantity') {
    if (bookingLoading) return;
    if (!sheetView) sheetTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pickerReturnView.current = sheetView === 'booking' ? 'booking' : null;
    if (view === 'date') {
      explicitDate.current = true;
      setDraftDate(date);
      setMonth((date || minimumDate).slice(0, 7));
    } else setDraftCounts({ ...counts });
    setSheetView(view);
  }

  function dismissSheet() {
    if (sheetView === 'date' || sheetView === 'quantity') {
      if (sheetView === 'date') setMonth((date || minimumDate).slice(0, 7));
      setSheetView(pickerReturnView.current);
      return;
    }
    setSheetView(sheetView === 'details' && detailsFromBooking.current ? 'booking' : null);
  }

  function quantityError(selection: Record<string, number>) {
    const rows = skuRows.filter(item => (selection[item.sku.sku_code] || 0) > 0);
    const count = rows.reduce((sum, item) => sum + selection[item.sku.sku_code], 0);
    if (!rows.length) return '请选择参加人数';
    if (rows.some(item => !item.available)) return '所选人数类型在该日期暂不可预订，请调整日期或人数';
    if (rows.some(item => selection[item.sku.sku_code] > Number(item.row?.inventory || 0))) return '所选人数超过余量，请调整人数';
    if (skuRows.some(item => item.sku.required && !selection[item.sku.sku_code])) return '请选择套餐要求的人数类型';
    if (rows.some(item => (item.sku.sku_min_pax && selection[item.sku.sku_code] < item.sku.sku_min_pax) || (item.sku.sku_max_pax && selection[item.sku.sku_code] > item.sku.sku_max_pax))) return '人数不符合套餐要求，请调整';
    if (selectedPackage?.package_min_pax && count < selectedPackage.package_min_pax) return `此套餐至少需要 ${selectedPackage.package_min_pax} 人`;
    if (selectedPackage?.package_max_pax && count > selectedPackage.package_max_pax) return `此套餐最多可选择 ${selectedPackage.package_max_pax} 人`;
    return '';
  }

  function confirmPicker() {
    if (bookingLoading) return;
    if (sheetView === 'date') {
      if (calendarLoading || draftDate < minimumDate || !calendars.some(sku => bookable(calendarRow(sku, draftDate), sku.publish_status))) return;
      chooseDate(draftDate);
    } else if (sheetView === 'quantity') {
      if (calendarLoading || quantityError(draftCounts)) return;
      setCounts({ ...draftCounts }); setBookingError('');
    }
    setSheetView(pickerReturnView.current);
  }

  function trapSheetFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')).filter(element => element.getClientRects().length > 0);
    const target = event.shiftKey ? controls.at(-1) : controls[0];
    if (target && (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1)) || !event.currentTarget.contains(document.activeElement))) {
      event.preventDefault();
      target.focus();
    }
  }

  async function proceed() {
    if (!product || !selectedPackage || calendarLoading || bookingLoading) return;
    if (selectionError) { setBookingError(selectionError); sheetRef.current?.querySelector('.detail-sheet-quantity')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
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

  function scrollToSection(section: string) {
    setActiveSection(section);
    document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderDateSelection() {
    return <>
      <div className="detail-quick-dates" aria-label="快捷选择可预订日期">
        {quickDates.map(value => <button key={value} data-date={value} className={`detail-quick-date ${date === value ? 'selected' : ''}`} aria-label={`选择${value}${value === addDays(destinationToday, 1) ? '，明天' : ''}`} aria-pressed={date === value} disabled={calendarLoading || bookingLoading} onClick={() => chooseDate(value)}>{value === addDays(destinationToday, 1) ? '明天' : `${Number(value.slice(5, 7))}月${Number(value.slice(8))}日`}</button>)}
        <button className="detail-all-dates" aria-label="所有日期" aria-haspopup="dialog" onClick={() => openPicker('date')}><Icon name="calendar" size={16} />所有日期</button>
      </div>
      {calendarLoading && <div className="detail-date-loading" role="status" aria-label="正在加载可预订日期"><span /><span /><span /></div>}
      {calendarError && <div className="detail-inline-error" role="alert"><span>{calendarError}</span><button onClick={() => setCalendarReload(value => value + 1)}>重新查询</button></div>}
      {!calendarLoading && !calendarError && !quickDates.length && <p className="detail-date-context">当前已查询日期暂不可预订，请打开所有日期查看其他月份。</p>}
    </>;
  }

  function renderCalendarPicker() {
    return <div className="detail-calendar" id="detail-full-calendar">
      <div className="detail-calendar-weekdays">{['日', '一', '二', '三', '四', '五', '六'].map(day => <span key={day}>{day}</span>)}</div>
      <div className="detail-calendar-header"><strong>{Number(month.slice(0, 4))}年{Number(month.slice(5))}月</strong><div><button className="detail-icon-button" aria-label="上一个月" disabled={month <= minimumDate.slice(0, 7) || calendarLoading} onClick={() => setMonth(value => addMonths(value, -1))}><Icon name="back" size={18} /></button><button className="detail-icon-button" aria-label="下一个月" disabled={calendarLoading} onClick={() => setMonth(value => addMonths(value, 1))}><Icon name="next" size={18} /></button></div></div>
      {calendarLoading && <div className="detail-date-loading" role="status" aria-label="正在加载可预订日期"><span /><span /><span /></div>}
      {calendarError && <div className="detail-inline-error" role="alert"><span>{calendarError}</span><button onClick={() => setCalendarReload(value => value + 1)}>重新查询</button></div>}
      <div className={`detail-calendar-days ${calendarLoading ? 'is-loading' : ''}`}>{Array.from({ length: firstDay }, (_, index) => <span key={`empty-${index}`} />)}{days.map(day => <button key={day.value} data-date={day.value} className={`detail-calendar-day ${draftDate === day.value && day.available ? 'selected' : ''}`} disabled={calendarLoading || !day.available} aria-label={`${day.value}${day.available ? '，可预订' : '，不可预订'}`} aria-pressed={draftDate === day.value} onClick={() => setDraftDate(day.value)}><span>{Number(day.value.slice(-2))}</span></button>)}</div>
      {!calendarLoading && !calendarError && !days.some(day => day.available) && <div className="detail-empty-small">这个月暂时没有可预订日期，试试下个月</div>}
    </div>;
  }

  function renderQuantitySelection() {
    return <>
      <div className="detail-picker-minimum">{selectedPackage?.package_min_pax ? `此套餐最少预订数量为 ${selectedPackage.package_min_pax}` : '按实际参与人数选择'}</div>
      <div className="detail-sku-list">{skuRows.map(({ sku, row, calendar, available }) => {
        const count = draftCounts[sku.sku_code] || 0;
        const min = sku.required ? Math.max(1, sku.sku_min_pax || 0) : 0;
        const max = Math.min(99, sku.sku_max_pax && sku.sku_max_pax > 0 ? sku.sku_max_pax : Infinity, row ? Number(row.inventory) : 0);
        const age = sku.min_age === 0 && sku.max_age === 0 ? '' : sku.min_age != null && sku.max_age != null ? `${sku.min_age}–${sku.max_age} 岁` : sku.min_age != null ? `${sku.min_age} 岁及以上` : sku.max_age != null ? `${sku.max_age} 岁及以下` : '';
        return <div className={`detail-sku-row ${!available ? 'unavailable' : ''}`} key={sku.sku_code}><div className="detail-sku-info"><h4>{sku.title}{Boolean(sku.required) && <span>必选</span>}</h4>{age && <small>{age}</small>}<strong>{calendarLoading ? <PriceSkeleton /> : available && row ? money(row.selling_price, calendar?.currency) : date ? '此日期暂不可订' : '请先选择日期'}</strong></div><div className="detail-stepper"><button aria-label={`减少${sku.title}数量`} disabled={count <= min} onClick={() => setDraftCounts(current => ({ ...current, [sku.sku_code]: Math.max(min, count - 1 < (sku.sku_min_pax || 0) ? 0 : count - 1) }))}><Icon name="minus" size={16} /></button><span aria-live="polite">{count}</span><button aria-label={`增加${sku.title}数量`} disabled={!available || count >= max || calendarLoading} onClick={() => setDraftCounts(current => ({ ...current, [sku.sku_code]: Math.min(max, count ? count + 1 : Math.max(1, sku.sku_min_pax || 0)) }))}><Icon name="plus" size={16} /></button></div></div>;
      })}</div>
    </>;
  }

  if (productLoading || !product) return <div className="detail-page"><header className="detail-toolbar"><button className="detail-icon-button" aria-label="返回活动列表" onClick={onBack}><Icon name="back" /></button><span>活动详情</span><span /></header>{productLoading ? <div className="detail-loading"><div className="detail-skeleton detail-skeleton-hero" /><div className="detail-skeleton detail-skeleton-title" /><div className="detail-skeleton detail-skeleton-copy" /><div className="detail-skeleton detail-skeleton-copy" /></div> : <div className="detail-empty"><Icon name="image" size={44} /><h2>暂时无法查看此活动</h2><p>{productError || '活动信息暂不可用'}</p><button className="detail-primary" onClick={() => setReload(value => value + 1)}>重新加载</button><button className="detail-text-button" onClick={onBack}>返回活动列表</button></div>}</div>;

  return <div className="detail-page">
    <header className="detail-toolbar"><button className="detail-icon-button" aria-label="返回活动列表" onClick={onBack}><Icon name="back" /></button><span>活动详情</span></header>
    <div className="detail-gallery">
      {images.length && !failedImages.includes(images[imageIndex]?.image_url) ? <img src={images[imageIndex]?.image_url} alt={`${product.title} · 图片 ${imageIndex + 1}`} className="detail-hero-image" onError={() => setFailedImages(current => [...current, images[imageIndex].image_url])} /> : <div className="detail-no-image"><Icon name="image" size={48} /><span>{images.length ? '活动图片暂时无法显示' : '活动图片暂未提供'}</span></div>}
      {images.length > 1 && <><button className="detail-gallery-arrow detail-gallery-prev" aria-label="上一张活动图片" onClick={() => setImageIndex(index => (index - 1 + images.length) % images.length)}><Icon name="back" /></button><button className="detail-gallery-arrow detail-gallery-next" aria-label="下一张活动图片" onClick={() => setImageIndex(index => (index + 1) % images.length)}><Icon name="next" /></button><span className="detail-image-count"><Icon name="image" size={14} />{imageIndex + 1} / {images.length}</span><div className="detail-gallery-dots">{images.slice(0, 12).map((image, index) => <button key={`${image.image_url}-${index}`} className={imageIndex === index ? 'active' : ''} aria-label={`查看第 ${index + 1} 张图片`} onClick={() => setImageIndex(index)} />)}</div></>}
    </div>
    <div className="detail-main-grid">
      <div className="detail-overview">
        <section className="detail-heading">
          <div className="detail-eyebrow">{locationLabel && <><span>{locationLabel}</span><span aria-hidden="true">·</span></>}<span>{categoryNameZh(plainText(product.category_info?.leaf_category_name) || plainText(product.category_info?.sub_category_name))}</span></div>
          <h1>{product.title}</h1>
          {product.subtitle && <p className="detail-subtitle">{plainText(product.subtitle)}</p>}
          <div className="detail-top-price">{calendarLoading ? <PriceSkeleton /> : referencePrice != null && referenceCurrency ? <><strong>{money(referencePrice, referenceCurrency)}</strong><span>起</span></> : <span>价格待确认</span>}</div>
          {quickFacts.length > 0 && <div className="detail-quick-facts">{quickFacts.map(section => section.isDuration ? <div className="detail-fact-duration" key={section.key}><span className="detail-fact-tag">活动时长：{section.value}</span></div> : <span className="detail-fact-tag" key={section.key}>{section.value}</span>)}</div>}
          {highlightItems.length > 0 && <section className="detail-highlights" id="ant-highlights" aria-label="活动亮点">
            <div className={`detail-highlights-content ${hasMoreHighlights && !highlightsExpanded ? 'is-collapsed' : ''}`} id="detail-highlights-content"><ul>{highlightItems.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
            {hasMoreHighlights && <button className="detail-highlights-more" aria-expanded={highlightsExpanded} aria-controls="detail-highlights-content" onClick={() => setHighlightsExpanded(value => !value)}>{highlightsExpanded ? '收起亮点' : '查看更多'}<Icon name="next" size={18} /></button>}
          </section>}
        </section>
        <nav className="detail-section-nav" aria-label="活动详情栏目">{[['ant-packages', '选择套餐'], ['ant-introduction', '活动介绍'], ['ant-information', '使用须知']].map(([section, label]) => <button key={section} className={activeSection === section ? 'active' : ''} onClick={() => scrollToSection(section)}>{label}</button>)}</nav>
        {product.description && <section className="detail-content-card detail-description" id="ant-introduction"><h2>活动介绍</h2><p className="detail-rich-text">{plainText(product.description)}</p></section>}
        {!product.description && <span className="detail-introduction-marker" id="ant-introduction" />}
        {contentSections.map(section => <section className="detail-content-card" key={section.key}><h2>{section.title}</h2><p className="detail-rich-text">{section.content}</p></section>)}
        <section className="detail-content-card detail-practical" id="ant-information">
          <h2>使用须知</h2>
          {product.address && <div className="detail-practical-row"><Icon name="pin" size={20} /><div><h3>活动地点</h3><p>{plainText(product.address)}</p></div></div>}
          {selectedPackage?.voucher_usage_desc && <div className="detail-practical-row"><Icon name="check" size={20} /><div><h3>凭证使用方式</h3><p className="detail-rich-text">{sectionContent(plainText(selectedPackage.voucher_usage_desc), '凭证使用方式')}</p></div></div>}
          {selectedPackage?.cancellation_desc && <div className="detail-practical-row"><Icon name="calendar" size={20} /><div><h3>取消政策</h3><p className="detail-rich-text">{sectionContent(plainText(selectedPackage.cancellation_desc), '取消政策')}</p></div></div>}
          {!product.address && !selectedPackage?.voucher_usage_desc && !selectedPackage?.cancellation_desc && <p className="detail-muted">请选择套餐，查看适用的预订与使用信息。</p>}
        </section>
      </div>
      <section className="detail-booking-panel" id="ant-packages" ref={bookingRef}>
        <div className="detail-booking-title"><h2>套餐选项</h2></div>
        {!packages.length ? <div className="detail-empty-small">此活动暂未开放可预订套餐</div> : <>
          {renderDateSelection()}
          <div className="detail-package-heading"><h3>套餐类型</h3><span>{packages.length} 个套餐</span></div>
          <div className={`detail-package-rail ${packagesExpanded ? 'is-expanded' : ''}`}>
            <div className={`detail-package-list ${packagesExpanded ? 'is-expanded' : ''}`} id="detail-package-options">{representatives.map(({ item, sku }) => {
              const currentQuote = packageQuotes.key === quoteKey;
              const quote = currentQuote ? packageQuotes.calendars.find(value => value.sku_code === sku?.sku_code) : undefined;
              const row = calendarRow(quote, date);
              const loading = Boolean(date && sku && (!currentQuote || packageQuotes.loading));
              const failed = Boolean(sku && currentQuote && packageQuotes.failedSkus.includes(sku.sku_code));
              const status = !sku ? '暂无成人或通用规格报价' : !date ? '请先选择日期' : loading ? '' : date < minimumPackageDate(item) ? '此日期不可预订' : failed ? '报价查询失败，请重试' : quoteStatus(row, quote?.publish_status);
              const ready = !loading && !status && Boolean(row && quote?.currency);
              return <button key={item.package_code} data-package-code={item.package_code} data-date={date} className={`detail-package-card ${selectedCode === item.package_code ? 'selected' : ''}`} onClick={() => choosePackage(item.package_code)} disabled={bookingLoading} aria-pressed={selectedCode === item.package_code}>
                <strong>{item.package_name}</strong>
                <span className={`detail-package-price ${ready ? '' : 'is-unavailable'}`} data-sku-code={sku?.sku_code} data-quote-status={loading ? 'loading' : failed ? 'error' : ready ? 'ready' : 'unavailable'}>{loading ? <PriceSkeleton /> : ready ? money(row!.selling_price, quote!.currency) : status || '价格币种待确认'}</span>
              </button>;
            })}</div>
            {packages.length > 1 && <button className="detail-expand-packages" aria-label={packagesExpanded ? '收起套餐' : '展开全部套餐'} aria-expanded={packagesExpanded} aria-controls="detail-package-options" onClick={() => setPackagesExpanded(value => !value)}><Icon name="next" size={20} />{packagesExpanded && <span>收起</span>}</button>}
          </div>
          {packageQuotes.key === quoteKey && packageQuotes.failedSkus.length > 0 && <button className="detail-package-price-retry detail-text-button" onClick={() => setCalendarReload(value => value + 1)}>重新查询套餐报价</button>}
          {selectedPackage && <div className="detail-package-description detail-package-inclusions" data-package-code={selectedPackage.package_code}><h3>{selectedPackage.package_name}</h3><div id="detail-package-description-content" className={hasMorePackageDescription ? 'is-collapsed' : ''}>{packageSections.length ? packageSections.map(section => <div key={section.key}><h4>{section.title}</h4><p className="detail-rich-text">{section.content}</p></div>) : <p className="detail-muted">该套餐暂未提供详细说明。</p>}</div><button className="detail-package-more" aria-haspopup="dialog" onClick={() => openSheet('details')}>查看套餐详情<Icon name="next" size={14} /></button></div>}
          <div className="detail-desktop-summary"><div><span>总价</span><strong>{calendarLoading ? <PriceSkeleton /> : date && selectedRows.length && selectedRows.every(row => row.available) ? money(total, currency) : '选择日期与人数'}</strong></div><button className="detail-primary" aria-haspopup="dialog" onClick={() => openSheet('booking')} disabled={bookingLoading || !selectedPackage || !selectedPackage.sku_list?.length}>{bookingLoading ? '正在确认…' : '立即预订'}</button>{selectionError && <small>{selectionError}</small>}</div>
        </>}
      </section>
    </div>
    <footer className="detail-mobile-booking"><div><small>{date && selectedRows.length && selectedRows.every(row => row.available) ? `${date.slice(5).replace('-', '月')}日 · ${totalCount} 人` : hasProductPrice ? '参考价' : '活动价格'}</small><strong>{calendarLoading ? <PriceSkeleton /> : date && selectedRows.length && selectedRows.every(row => row.available) ? money(total, currency) : hasProductPrice ? money(product.price!, product.currency) : '选择套餐'}</strong></div><button className="detail-primary" aria-haspopup="dialog" onClick={() => openSheet('booking')} disabled={bookingLoading || !packages.length}>{bookingLoading ? '正在确认…' : '立即预订'}</button></footer>
    {sheetView && selectedPackage && <dialog className={`detail-booking-overlay ${sheetView === 'date' || sheetView === 'quantity' ? 'detail-picker-overlay' : ''}`} ref={sheetRef} aria-labelledby="detail-sheet-title" onKeyDown={trapSheetFocus} onCancel={event => { event.preventDefault(); if (!bookingLoading) dismissSheet(); }} onClick={event => { if (event.target === event.currentTarget && !bookingLoading) dismissSheet(); }}>
      <div className={`detail-booking-sheet ${sheetView === 'date' || sheetView === 'quantity' ? `detail-picker-sheet ${sheetView}` : ''}`}>
        <header className="detail-booking-sheet-header">{sheetView === 'date' || sheetView === 'quantity' ? <><span /><h2 id="detail-sheet-title">{sheetView === 'date' ? '选择日期' : '选择人数'}</h2><button className="detail-icon-button" aria-label={sheetView === 'date' ? '关闭日期选择' : '关闭人数选择'} onClick={dismissSheet}><Icon name="close" /></button></> : <><button className="detail-icon-button" aria-label={sheetView === 'details' ? detailsFromBooking.current ? '返回预订选项' : '关闭套餐详情' : '关闭预订选项'} disabled={bookingLoading} onClick={dismissSheet}><Icon name={sheetView === 'details' && detailsFromBooking.current ? 'back' : 'close'} /></button><h2 id="detail-sheet-title">{sheetView === 'details' ? '套餐详情' : '预订选项'}</h2><span /></>}</header>
        <div className="detail-booking-sheet-body">
          {sheetView === 'date' ? renderCalendarPicker() : sheetView === 'quantity' ? renderQuantitySelection() : <>
            <div className="detail-sheet-package-heading"><h3>{selectedPackage.package_name}</h3>{sheetView === 'booking' && <button className="detail-text-button" disabled={bookingLoading} onClick={() => openSheet('details')}>详情<Icon name="next" size={16} /></button>}</div>
            <div className="detail-sheet-attrs">{selectedPackage.package_min_pax != null && selectedPackage.package_min_pax > 0 && <span>最少预订人数：{selectedPackage.package_min_pax} 人</span>}{selectedPackage.package_max_pax != null && selectedPackage.package_max_pax > 0 && selectedPackage.package_max_pax <= 99 && <span>最多 {selectedPackage.package_max_pax} 人</span>}{selectedPackage.instant === 1 && <span>立即确认</span>}</div>
            {sheetView === 'details' ? <div className="detail-sheet-package-content" data-package-code={selectedPackage.package_code}>
              {packageSections.length ? packageSections.map(section => <section key={section.key}><h3>{section.title}</h3><p className="detail-rich-text">{section.content}</p></section>) : <p className="detail-muted">该套餐暂未提供详细说明。</p>}
              {selectedPackage.cancellation_desc && <section><h3>取消政策</h3><p className="detail-rich-text">{sectionContent(plainText(selectedPackage.cancellation_desc), '取消政策')}</p></section>}
              {selectedPackage.voucher_usage_desc && <section><h3>凭证使用方式</h3><p className="detail-rich-text">{sectionContent(plainText(selectedPackage.voucher_usage_desc), '凭证使用方式')}</p></section>}
            </div> : <>
              <section className="detail-sheet-section detail-sheet-date-panel"><button className="detail-sheet-selector detail-sheet-selector-date" disabled={bookingLoading} onClick={() => openPicker('date')}><span>选择日期</span><strong>{date ? `${Number(date.slice(0, 4))}年${Number(date.slice(5, 7))}月${Number(date.slice(8))}日` : '请选择'}</strong><Icon name="next" size={18} /></button></section>
              <section className="detail-sheet-section detail-sheet-quantity"><button className="detail-sheet-selector detail-sheet-selector-quantity" disabled={bookingLoading} onClick={() => openPicker('quantity')}><span>选择人数</span><strong>{totalCount} 人</strong><Icon name="next" size={18} /></button><p className="detail-sheet-count-summary">{selectedRows.map(item => `${item.sku.title} × ${counts[item.sku.sku_code]}`).join(' · ') || '请选择参加人数'}</p></section>
              {requiresTime && <section className="detail-sheet-section detail-time-selection"><h3>选择场次</h3>{slots.length ? <div className="detail-time-slots">{slots.map(slot => <button key={slot} className={bookingTime === slot ? 'selected' : ''} disabled={bookingLoading} onClick={() => { setTime(slot); setBookingError(''); }}><Icon name="clock" size={15} />{slot.slice(0, 5)}</button>)}</div> : <p className="detail-unavailable-time">该套餐需要选择场次，目前暂未开放场次预订。你可以选择其他套餐。</p>}</section>}
              {bookingError && <div className="detail-inline-error" role="alert"><span>{bookingError}</span><button onClick={() => { setBookingError(''); setCalendarReload(value => value + 1); }}>刷新价格</button></div>}
            </>}
          </>}
        </div>
        {sheetView === 'date' || sheetView === 'quantity' ? <footer className="detail-booking-sheet-footer detail-picker-footer">
          {sheetView === 'date' ? <><p className="detail-picker-date-notice">所选日期为活动当地日期</p><p className="detail-picker-selected-date">{draftDate ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(`${draftDate}T12:00:00Z`)) : '请选择参加活动的日期'}</p></> : quantityError(draftCounts) && <p className="detail-sheet-selection-note" role="status">{quantityError(draftCounts)}</p>}
          <button className="detail-primary detail-picker-confirm" onClick={confirmPicker} disabled={calendarLoading || (sheetView === 'date' ? draftDate < minimumDate || !calendars.some(sku => bookable(calendarRow(sku, draftDate), sku.publish_status)) : Boolean(quantityError(draftCounts)))}>确认</button>
        </footer> : sheetView === 'booking' && <footer className="detail-booking-sheet-footer"><div><span>总价</span><strong aria-live="polite">{calendarLoading ? <PriceSkeleton /> : date && selectedRows.length && selectedRows.every(row => row.available) ? money(total, currency) : '选择日期与人数'}</strong></div>{!calendarLoading && selectionError && <p className="detail-sheet-selection-note">{selectionError}</p>}<button className="detail-primary" onClick={proceed} disabled={calendarLoading || bookingLoading || !selectedPackage.sku_list?.length}>{bookingLoading ? '正在确认…' : '立即预订'}</button></footer>}
      </div>
    </dialog>}
  </div>;
}
