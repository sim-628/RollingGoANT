import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CalendarDays, ChevronDown, ChevronRight, Info, MapPin, ShieldCheck, UsersRound } from 'lucide-react';
import { ApiError, apiGet, apiPost, formatMoney } from './api';
import type { BookingSelection, ExtraField } from './types';
import type { OrderResult } from './App';
import ProductDetail from './ProductDetail';
import PriceSkeleton from './PriceSkeleton';
import './booking.css';

interface Quote { valid: boolean; quote: { currency: string; total_amount: string; items?: { sku_list?: { sku_code: string; selling_unit_price: string; count: number }[] }[] } }
interface Availability { items: { sku_code: string; available: boolean; selling_price: string; currency: string }[] }
type Values = Record<string, string>;
interface ExtraPackage { package_code?: string; booking_extra_info?: ExtraField[]; unit_extra_info?: ExtraField[] }
function extraPackage(selection: BookingSelection): ExtraPackage {
  const info = selection.extraInfo;
  if (Array.isArray(info)) return (info as ExtraPackage[]).find(p => String(p.package_code) === String(selection.package.package_code)) || {};
  if (info && typeof info === 'object') return info as ExtraPackage;
  return {};
}
function childFields(field: ExtraField, value: string): ExtraField[] {
  const options = field.options as ExtraField[] | undefined;
  const selected = options?.find(o => String(o.key) === value);
  if (Array.isArray(selected?.options) && selected.options.length) return selected.options as ExtraField[];
  if (selected?.required && ['text', 'mobile', 'email', 'date', 'datetime', 'number'].includes(String(selected.input_type))) return [selected];
  return [];
}
interface ExtraAnswer { key: string; content?: string; selected?: ExtraAnswer[] }
function fieldValues(fields: ExtraField[], values: Values, prefix = ''): ExtraAnswer[] {
  return fields.flatMap<ExtraAnswer>(field => {
    const path = `${prefix}${field.key}`;
    const value = values[path] || '';
    if (!value) return [];
    const selected = field.options?.find(option => String(option.key) === value) as ExtraField | undefined;
    const children = childFields(field, value);
    if (selected && field.input_type !== 'mobile') {
      const nested = Array.isArray(selected.options) && selected.options.length
        ? fieldValues(children, values, `${path}.`) : [];
      return [{ key: field.key, selected: [{ key: selected.key,
        content: values[`${path}.${selected.key}`] || '',
        ...(nested.length ? { selected: nested } : {}) }] }];
    }
    return [{ key: field.key, content: field.input_type === 'datetime' ? value.replace('T', ' ') : value }];
  });
}

function unsupportedRequiredField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(unsupportedRequiredField);
  if (!value || typeof value !== 'object') return false;
  const field = value as Record<string, unknown>;
  return Boolean(field.required && field.input_type === 'checkbox') || ['booking_extra_info', 'unit_extra_info', 'options'].some(key => unsupportedRequiredField(field[key]));
}

export default function Booking({ selection: initialSelection, onBack, onComplete }: { selection: BookingSelection; onBack: () => void; onComplete: (result: OrderResult, selection: BookingSelection) => void }) {
  const [selection, setSelection] = useState(initialSelection);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [preparing, setPreparing] = useState(true);
  const [preparationError, setPreparationError] = useState('');
  const [editor, setEditor] = useState<'date' | 'quantity' | null>(null);
  const [contact, setContact] = useState({ first_name: '', family_name: '', mobile: '', email: '', title: 'MR', country: 'CN', dialing: '86' });
  const [bookingValues, setBookingValues] = useState<Values>({});
  const [travellerValues, setTravellerValues] = useState<Record<string, Values>>({});
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [confirmedQuote, setConfirmedQuote] = useState<{ currency: string; total: number; prices: Record<string, string> } | null>(null);
  const orderCode = useRef(`ANT-${crypto.randomUUID()}`);
  const mounted = useRef(true);
  const submission = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; submission.current?.abort(); };
  }, []);
  const extra = useMemo(() => extraPackage(selection), [selection]);
  const rules = selection.package.contact_info || [];
  const required = (name: string) => rules.some(rule => rule.key === name && Boolean(rule.required));
  const englishName = required('name_english');
  const travellers = selection.skus.flatMap(sku => Array.from({ length: sku.count }, (_, index) => ({ key: `${sku.sku_code}:${index}`, sku, index })));
  const updateContact = (name: keyof typeof contact, value: string) => { setContact(c => ({ ...c, [name]: value })); setConfirmedQuote(null); };
  const displayedPrice = confirmedQuote?.total ?? selection.total;
  const displayedCurrency = confirmedQuote?.currency ?? selection.currency;
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setPreparing(true); setPreparationError(''); setError('');
    const skus = selection.skus.filter(sku => sku.count > 0);
    Promise.all([
      apiGet<unknown>('/api/catalog/packages/extra-info', { package_codes: selection.package.package_code }, { signal: controller.signal }),
      apiPost<Availability>('/api/availability-check', [{
        package_code: selection.package.package_code,
        start_time: `${selection.date} ${selection.time || '00:00:00'}`,
        sku_list: skus.map(sku => ({ sku_code: sku.sku_code, count: sku.count, price: sku.price })),
      }], { signal: controller.signal }),
    ]).then(([extraInfo, availability]) => {
      if (!active) return;
      if (unsupportedRequiredField(extraInfo)) throw new Error('该套餐暂不支持在线预订，请选择其他套餐。');
      if (!skus.length || !Array.isArray(availability.items)) throw new Error('请选择参加人数。');
      const liveSkus = skus.map(sku => {
        const item = availability.items.find(row => row.sku_code === sku.sku_code);
        if (!item?.available) throw new Error('所选日期或人数暂不可预订，请重新选择。');
        if (item.selling_price == null || item.selling_price === '' || !Number.isFinite(Number(item.selling_price)) || Number(item.selling_price) < 0 || !/^[A-Z]{3}$/.test(item.currency)) throw new Error('暂时无法获取价格，请重试。');
        return { ...sku, price: item.selling_price, currency: item.currency };
      });
      if (new Set(liveSkus.map(sku => sku.currency)).size !== 1) throw new Error('套餐价格币种不一致，请重新选择。');
      setSelection(previous => ({ ...previous, skus: liveSkus, total: liveSkus.reduce((sum, sku) => sum + Number(sku.price) * sku.count, 0), currency: liveSkus[0].currency, extraInfo }));
    }).catch(err => { if (active) setPreparationError(err instanceof Error ? err.message : '暂时无法加载预订信息，请重试。'); })
      .finally(() => { if (active) setPreparing(false); });
    return () => { active = false; controller.abort(); };
    // A revision changes only after a confirmed edit or an explicit retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionRevision]);
  const commitEdit = (next: BookingSelection) => {
    setEditor(null); setSelection(next); setConfirmedQuote(null); setAccepted(false);
    setPreparing(true); setPreparationError(''); setSelectionRevision(value => value + 1);
  };
  const openEditor = (view: 'date' | 'quantity') => {
    if (!busy && !preparing) setEditor(view);
  };
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || preparing || preparationError || editor) return;
    setError('');
    if (!accepted) { setError('请先确认已阅读预订及取消说明。'); return; }
    if (englishName && !/^[A-Za-z ]+$/.test(contact.first_name.trim() + contact.family_name.trim())) { setError('此套餐需要英文姓名，请使用英文字母填写。'); return; }
    if (!/^\d{5,15}$/.test(contact.mobile.trim())) { setError('请填写有效的手机号码。'); return; }
    const payload = {
      agent_order_code: orderCode.current,
      contact_info: {
        first_name: contact.first_name.trim(), family_name: contact.family_name.trim(),
        mobile: `${contact.dialing}-${contact.mobile.trim().replace(/^0+/, '')}`,
        ...(contact.email.trim() ? { email: contact.email.trim() } : {}),
        ...(required('title') ? { title: contact.title } : {}),
        ...(required('country') ? { country: contact.country } : {})
      },
      items: [{
        package_code: selection.package.package_code,
        start_time: `${selection.date} ${selection.time || '00:00:00'}`,
        sku_list: selection.skus.filter(sku => sku.count > 0).map(sku => ({ sku_code: sku.sku_code, count: sku.count, acceptable_price: sku.price })),
        booking_extra_info: fieldValues(extra.booking_extra_info || [], bookingValues),
        unit_extra_info: travellers.map(traveller => ({
          sku_code: traveller.sku.sku_code, index: traveller.index + 1,
          extra_info: fieldValues(extra.unit_extra_info || [], travellerValues[traveller.key] || {})
        }))
      }]
    };
    setBusy(true);
    const controller = new AbortController();
    submission.current = controller;
    try {
      const availability = await apiPost<Availability>('/api/availability-check', [{
        package_code: selection.package.package_code,
        start_time: `${selection.date} ${selection.time || '00:00:00'}`,
        sku_list: selection.skus.filter(sku => sku.count > 0).map(sku => ({ sku_code: sku.sku_code, count: sku.count }))
      }], { signal: controller.signal });
      const prices: Record<string, string> = {};
      const currencies = new Set<string>();
      let currentTotal = 0;
      for (const sku of selection.skus.filter(sku => sku.count > 0)) {
        const live = availability.items?.find(item => item.sku_code === sku.sku_code);
        if (!live?.available) throw new Error('所选日期或人数已不可预订，请返回套餐重新选择。');
        if (!Number.isFinite(Number(live.selling_price)) || Number(live.selling_price) < 0 || !/^[A-Z]{3}$/.test(live.currency)) throw new Error('当前报价暂时无法确认，请稍后重试。');
        prices[sku.sku_code] = live.selling_price;
        currencies.add(live.currency);
        currentTotal += Number(live.selling_price) * sku.count;
      }
      if (currencies.size !== 1) throw new Error('当前报价币种不一致，请返回套餐重新选择。');
      const currentCurrency = [...currencies][0];
      const agreedTotal = confirmedQuote?.total ?? selection.total;
      const agreedCurrency = confirmedQuote?.currency ?? selection.currency;
      if (!confirmedQuote && (Math.abs(currentTotal - agreedTotal) > 0.005 || currentCurrency !== agreedCurrency)) {
        setConfirmedQuote({ currency: currentCurrency, total: currentTotal, prices });
        setError('价格已更新，请核对新的总额，再次确认预订。'); return;
      }
      payload.items[0].sku_list = payload.items[0].sku_list.map(sku => ({ ...sku, acceptable_price: confirmedQuote?.prices[sku.sku_code] || prices[sku.sku_code] }));
      const validation = await apiPost<Quote>('/api/orders/validate', payload, { signal: controller.signal });
      if (validation.valid !== true || !validation.quote) throw new Error('预订信息尚未通过确认，请检查后重试。');
      const latest = Number(validation.quote.total_amount);
      if (!Number.isFinite(latest) || latest < 0) throw new Error('当前报价暂时无法确认，请稍后重试。');
      if (Math.abs(latest - agreedTotal) > 0.005 || validation.quote.currency !== agreedCurrency) {
        const quotePrices = Object.fromEntries((validation.quote.items || []).flatMap(item => item.sku_list || []).map(sku => [sku.sku_code, sku.selling_unit_price]));
        setConfirmedQuote({ currency: validation.quote.currency, total: latest, prices: { ...prices, ...quotePrices } });
        setError('价格已更新，请核对新的总额，再次确认预订。'); return;
      }
      const result = await apiPost<OrderResult>('/api/orders', { ...payload, expected_currency: validation.quote.currency, expected_total: validation.quote.total_amount }, { signal: controller.signal });
      if (result.mode !== 'validated' || !result.quote) throw new Error('预订报价暂时无法确认，请稍后重试。');
      if (mounted.current) onComplete(result, selection);
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ApiError && err.code === 'PRICE_CHANGED') {
        const quote = err.details?.quote as Quote['quote'] | undefined;
        if (quote && Number.isFinite(Number(quote.total_amount)) && Number(quote.total_amount) >= 0 && /^[A-Z]{3}$/.test(quote.currency)) {
          const prices = Object.fromEntries((quote.items || []).flatMap(item => item.sku_list || []).map(sku => [sku.sku_code, sku.selling_unit_price]));
          setConfirmedQuote({ currency: quote.currency, total: Number(quote.total_amount), prices });
        }
      }
      setError(err instanceof Error ? err.message : '暂时无法提交，请稍后重试。');
    }
    finally { if (mounted.current) setBusy(false); submission.current = null; }
  }
  const header = <header className="simple-topbar"><button className="icon-button" aria-label="返回商品详情" onClick={onBack}><ArrowLeft size={22} /></button><span>填写预订信息</span><span /></header>;
  const summary = <section className="surface-card booking-summary">
        <div className="booking-image">{selection.product.images?.[0]?.image_url && !imageFailed ? <img src={selection.product.images[0].image_url} alt={selection.product.title} onError={() => setImageFailed(true)} /> : <MapPin size={24} aria-label="商品图片暂不可用" />}</div>
        <div><h1>{selection.product.title}</h1><p>{selection.package.package_name}</p></div>
        <div className="booking-edit-row"><button type="button" aria-label="修改出行日期" disabled={busy} onClick={() => openEditor('date')}><CalendarDays size={17} /><span className="booking-edit-label">出行日期</span><strong className="booking-edit-value">{new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(`${selection.date}T12:00:00Z`))}</strong><ChevronRight className="booking-edit-chevron" size={17} /></button></div>
        <div className="booking-edit-row"><button type="button" aria-label="修改预订人数" disabled={busy} onClick={() => openEditor('quantity')}><UsersRound size={17} /><span className="booking-edit-label">预订人数</span><strong className="booking-edit-value">{selection.skus.filter(s => s.count > 0).map(s => `${s.title} × ${s.count}`).join('、')}</strong><ChevronRight className="booking-edit-chevron" size={17} /></button></div>
      </section>;
  const selectionEditor = editor && <ProductDetail productCode={selection.product.product_code} search={{ destination: null, keyword: '' }} onBack={() => setEditor(null)} onBook={commitEdit} editorSelection={selection} editorView={editor} onEditorClose={() => setEditor(null)} />;
  if (preparing) return <main className="booking-page booking-loading">{header}<BookingSkeleton /></main>;
  if (preparationError) return <main className="booking-page">{header}<div className="booking-preparation-error">{summary}<div className="form-error" role="alert"><Info size={18} /><span>{preparationError}</span></div><button type="button" className="primary-button full-width booking-prepare-retry" onClick={() => setSelectionRevision(value => value + 1)}>重新加载预订信息</button></div>{selectionEditor}</main>;
  return <main className="booking-page">{header}
    <form onSubmit={submit} aria-busy={busy}>
      <fieldset disabled={busy} className="booking-form-fields">
      {summary}
      <section className="surface-card form-card booking-contact-card"><div className="section-label"><h2>联系人信息</h2></div>
        {required('title') && <label className="field-label">称谓<span>*</span><select required value={contact.title} onChange={e => updateContact('title', e.target.value)}><option value="MR">先生 MR</option><option value="MRS">女士 MRS</option><option value="MISS">小姐 MISS</option></select></label>}
        <div className="field-grid"><label className="field-label">姓<span>*</span><input required name="family_name" autoComplete="family-name" maxLength={80} placeholder={englishName ? '例如 ZHANG' : '请输入姓氏'} value={contact.family_name} pattern={englishName ? '[A-Za-z ]+' : undefined} onChange={e => updateContact('family_name', e.target.value)} /></label><label className="field-label">名<span>*</span><input required name="first_name" autoComplete="given-name" maxLength={80} placeholder={englishName ? '例如 WEI' : '请输入名字'} value={contact.first_name} pattern={englishName ? '[A-Za-z ]+' : undefined} onChange={e => updateContact('first_name', e.target.value)} /></label></div>
        <p className="booking-name-hint">{englishName ? '请填写与证件一致的英文姓名' : '姓名请与证件一致'}</p>
        <label className="field-label">手机号码<span>*</span><div className="phone-field"><select aria-label="国际电话区号" value={contact.dialing} onChange={e => updateContact('dialing', e.target.value)}><option value="86">+86</option><option value="852">+852</option><option value="853">+853</option><option value="886">+886</option><option value="65">+65</option><option value="60">+60</option><option value="81">+81</option><option value="82">+82</option><option value="66">+66</option><option value="44">+44</option><option value="1">+1</option></select><input required name="mobile" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={15} placeholder="请输入手机号码" value={contact.mobile} onChange={e => updateContact('mobile', e.target.value.replace(/[^0-9]/g, ''))} /></div></label>
        <label className="field-label">电子邮箱{required('email') ? <span>*</span> : <small>选填</small>}<input name="email" type="email" autoComplete="email" required={required('email')} maxLength={150} placeholder="请输入电子邮箱" value={contact.email} onChange={e => updateContact('email', e.target.value)} /></label>
        {required('country') && <label className="field-label">国籍／地区代码<span>*</span><input name="country" required maxLength={2} pattern="[A-Z]{2}" placeholder="例如 CN" value={contact.country} onChange={e => updateContact('country', e.target.value.toUpperCase())} /><small>填写证件上的两位国家／地区代码。</small></label>}
      </section>
      {Boolean(extra.booking_extra_info?.length) && <section className="surface-card form-card"><div className="section-label"><span className="section-step">02</span><h2>预订补充信息</h2></div><ExtraFields fields={extra.booking_extra_info || []} values={bookingValues} setValues={values => { setBookingValues(values); setConfirmedQuote(null); }} /></section>}
      {Boolean(extra.unit_extra_info?.length) && travellers.map((traveller, index) => <section className="surface-card form-card" key={traveller.key}><div className="section-label"><span className="section-step"><UsersRound size={15} /></span><h2>旅客 {index + 1} · {traveller.sku.title}</h2></div><ExtraFields fields={extra.unit_extra_info || []} values={travellerValues[traveller.key] || {}} setValues={values => { setTravellerValues(old => ({ ...old, [traveller.key]: values })); setConfirmedQuote(null); }} /></section>)}
      <section className="surface-card form-card booking-notices"><div className="section-label"><ShieldCheck size={20} /><h2>预订须知</h2></div>
        {selection.package.cancellation_desc && <details><summary>取消政策<ChevronDown size={16} /></summary><p>{policyCopy(selection.package.cancellation_desc)}</p></details>}
        {selection.package.voucher_usage_desc && <details><summary>凭证使用<ChevronDown size={16} /></summary><p>{policyCopy(selection.package.voucher_usage_desc)}</p></details>}
        <label className="agreement"><input type="checkbox" checked={accepted} required onChange={e => setAccepted(e.target.checked)} /><span>已核对出行信息，并阅读预订须知</span></label>
      </section>
      {error && <div className="form-error" role="alert"><Info size={18} /><span>{error}</span></div>}
      </fieldset>
      <div className="booking-bottom"><div><span>预订总额</span><strong>{formatMoney(displayedPrice, displayedCurrency)}</strong></div><button className="primary-button" type="submit" disabled={busy} aria-label={confirmedQuote ? '确认更新后的价格' : '确认预订'}>{busy ? <PriceSkeleton /> : confirmedQuote ? '确认更新后的价格' : '确认预订'}</button></div>
    </form>{selectionEditor}
  </main>;
}

function policyCopy(value: string) {
  return value.replace(/^\s*(?:#{1,6}\s*)?(?:取消政策|退票政策|退款政策|取消与退款说明|凭证使用说明|凭证使用|凭证类型)\s*[:：]?\s*\n/g, '').trim();
}

function BookingSkeleton() {
  return <div className="booking-skeleton" role="status" aria-label="加载预订信息" aria-busy="true">
    <section className="surface-card booking-skeleton-summary"><div className="booking-skeleton-image" /><div className="booking-skeleton-text"><div className="booking-skeleton-line" /><div className="booking-skeleton-line short" /></div><div className="booking-skeleton-line" /><div className="booking-skeleton-line" /></section>
    <section className="surface-card booking-skeleton-card"><div className="booking-skeleton-line short" /><div className="field-grid"><div className="booking-skeleton-field" /><div className="booking-skeleton-field" /></div><div className="booking-skeleton-field" /><div className="booking-skeleton-field" /></section>
    <section className="surface-card booking-skeleton-card"><div className="booking-skeleton-line short" /><div className="booking-skeleton-line" /><div className="booking-skeleton-line" /></section>
    <div className="booking-bottom"><div className="booking-skeleton-price" /><div className="booking-skeleton-button" /></div>
  </div>;
}

function ExtraFields({ fields, values, setValues, prefix = '' }: { fields: ExtraField[]; values: Values; setValues: (values: Values) => void; prefix?: string }) {
  const idPrefix = useId();
  return <>{fields.map(field => {
    const path = `${prefix}${field.key}`;
    const value = values[path] || '';
    const options = Array.isArray(field.options) ? field.options : [];
    const type = String(field.input_type || 'text');
    const limit = typeof field.validation_rules?.max_len === 'number' ? field.validation_rules.max_len : 200;
    const minimum = typeof field.validation_rules?.min_len === 'number' ? field.validation_rules.min_len : undefined;
    const children = childFields(field, value);
    const id = `${idPrefix}-${path}`;
    const defaultDial = options.map(option => (option.name || option.label || '').match(/\+(\d{1,4})/)?.[1]).find(Boolean) || '';
    const dial = value.includes('-') ? value.split('-')[0] : defaultDial;
    const phone = value.includes('-') ? value.slice(value.indexOf('-') + 1) : value;
    return <div key={path}><label className="field-label" htmlFor={id}>{field.name || field.key}{field.required ? <span>*</span> : <small>选填</small>}
      {type === 'mobile' ? <div className="phone-field">{options.length ? <select aria-label={`${field.name || field.key} 国家/地区`} value={dial} onChange={e => setValues({ ...values, [path]: `${e.target.value}-${phone}` })}>{options.map(option => {
        const code = (option.name || option.label || '').match(/\+(\d{1,4})/)?.[1];
        return code ? <option key={option.key} value={code} title={option.name || option.label}>+{code}</option> : null;
      })}</select> : <input aria-label={`${field.name || field.key} 国际区号`} placeholder="区号" inputMode="numeric" required={field.required} value={dial} onChange={e => setValues({ ...values, [path]: `${e.target.value.replace(/\D/g, '')}-${phone}` })} />}
        <input id={id} aria-label={field.name || field.key} required={field.required} type="tel" inputMode="numeric" pattern="[0-9]{5,15}" maxLength={15} placeholder="请输入手机号码" value={phone} onChange={e => setValues({ ...values, [path]: `${dial}-${e.target.value.replace(/\D/g, '')}` })} /></div>
        : options.length ? <select id={id} required={field.required} value={value} onChange={e => setValues({ ...values, [path]: e.target.value })}><option value="">请选择</option>{options.map(option => <option value={option.key} key={option.key}>{option.name || option.label || option.key}</option>)}</select>
        : <input id={id} required={field.required} type={type === 'date' ? 'date' : type === 'datetime' ? 'datetime-local' : type === 'email' ? 'email' : type === 'number' ? 'number' : 'text'} minLength={minimum} maxLength={limit} placeholder={field.description || '请输入'} value={value} onChange={e => setValues({ ...values, [path]: e.target.value })} />}
      {field.description && <small className="field-description">{field.description}</small>}</label>
      {children.length > 0 && <div className="nested-fields"><ExtraFields fields={children} values={values} setValues={setValues} prefix={`${path}.`} /></div>}
    </div>;
  })}</>;
}
