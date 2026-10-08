import { useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CalendarDays, ChevronDown, Info, LockKeyhole, MapPin, ShieldCheck, UsersRound } from 'lucide-react';
import { ApiError, apiPost, formatMoney } from './api';
import type { BookingSelection, ExtraField } from './types';
import type { OrderResult } from './App';

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

export default function Booking({ selection, onBack, onComplete }: { selection: BookingSelection; onBack: () => void; onComplete: (result: OrderResult) => void }) {
  const [contact, setContact] = useState({ first_name: '', family_name: '', mobile: '', email: '', title: 'MR', country: 'CN', dialing: '86' });
  const [bookingValues, setBookingValues] = useState<Values>({});
  const [travellerValues, setTravellerValues] = useState<Record<string, Values>>({});
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [confirmedQuote, setConfirmedQuote] = useState<{ currency: string; total: number; prices: Record<string, string> } | null>(null);
  const orderCode = useRef(`ANT-${crypto.randomUUID()}`);
  const extra = useMemo(() => extraPackage(selection), [selection]);
  const rules = selection.package.contact_info || [];
  const required = (name: string) => rules.some(rule => rule.key === name && Boolean(rule.required));
  const englishName = required('name_english');
  const travellers = selection.skus.flatMap(sku => Array.from({ length: sku.count }, (_, index) => ({ key: `${sku.sku_code}:${index}`, sku, index })));
  const updateContact = (name: keyof typeof contact, value: string) => { setContact(c => ({ ...c, [name]: value })); setConfirmedQuote(null); };
  const displayedPrice = confirmedQuote?.total ?? selection.total;
  const displayedCurrency = confirmedQuote?.currency ?? selection.currency;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
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
    try {
      const availability = await apiPost<Availability>('/api/availability-check', [{
        package_code: selection.package.package_code,
        start_time: `${selection.date} ${selection.time || '00:00:00'}`,
        sku_list: selection.skus.filter(sku => sku.count > 0).map(sku => ({ sku_code: sku.sku_code, count: sku.count }))
      }]);
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
      const validation = await apiPost<Quote>('/api/orders/validate', payload);
      if (validation.valid !== true || !validation.quote) throw new Error('预订信息尚未通过确认，请检查后重试。');
      const latest = Number(validation.quote.total_amount);
      if (!Number.isFinite(latest) || latest < 0) throw new Error('当前报价暂时无法确认，请稍后重试。');
      if (Math.abs(latest - agreedTotal) > 0.005 || validation.quote.currency !== agreedCurrency) {
        const quotePrices = Object.fromEntries((validation.quote.items || []).flatMap(item => item.sku_list || []).map(sku => [sku.sku_code, sku.selling_unit_price]));
        setConfirmedQuote({ currency: validation.quote.currency, total: latest, prices: { ...prices, ...quotePrices } });
        setError('价格已更新，请核对新的总额，再次确认预订。'); return;
      }
      const result = await apiPost<OrderResult>('/api/orders', { ...payload, expected_currency: validation.quote.currency, expected_total: validation.quote.total_amount });
      if (result.mode !== 'validated' || !result.quote) throw new Error('预订报价暂时无法确认，请稍后重试。');
      onComplete(result);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PRICE_CHANGED') {
        const quote = err.details?.quote as Quote['quote'] | undefined;
        if (quote && Number.isFinite(Number(quote.total_amount)) && Number(quote.total_amount) >= 0 && /^[A-Z]{3}$/.test(quote.currency)) {
          const prices = Object.fromEntries((quote.items || []).flatMap(item => item.sku_list || []).map(sku => [sku.sku_code, sku.selling_unit_price]));
          setConfirmedQuote({ currency: quote.currency, total: Number(quote.total_amount), prices });
        }
      }
      setError(err instanceof Error ? err.message : '暂时无法提交，请稍后重试。');
    }
    finally { setBusy(false); }
  }
  return <main className="booking-page">
    <header className="simple-topbar"><button className="icon-button" aria-label="返回商品详情" onClick={onBack}><ArrowLeft size={22} /></button><span>填写预订信息</span><LockKeyhole size={17} /></header>
    <div className="booking-progress"><span className="done">1 选择套餐</span><i /><span className="current">2 确认预订</span><i /><span>3 收银台</span></div>
    <form onSubmit={submit}>
      <section className="surface-card booking-summary">
        <div className="booking-image">{selection.product.images?.[0]?.image_url && !imageFailed ? <img src={selection.product.images[0].image_url} alt={selection.product.title} onError={() => setImageFailed(true)} /> : <MapPin size={24} aria-label="商品图片暂不可用" />}</div>
        <div><h1>{selection.product.title}</h1><p>{selection.package.package_name}</p></div>
        <div className="summary-detail"><span><CalendarDays size={15} />{selection.date}</span><span><UsersRound size={15} />{selection.skus.filter(s => s.count > 0).map(s => `${s.title} × ${s.count}`).join('、')}</span></div>
      </section>
      <section className="surface-card form-card"><div className="section-label"><span className="section-step">01</span><h2>联系人信息</h2></div><p className="section-hint">用于接收预订确认，请准确填写。</p>
        {englishName && <div className="inline-notice"><Info size={16} />此套餐要求填写英文姓名，请与证件一致。</div>}
        {required('title') && <label className="field-label">称谓<span>*</span><select required value={contact.title} onChange={e => updateContact('title', e.target.value)}><option value="MR">先生 MR</option><option value="MRS">女士 MRS</option><option value="MISS">小姐 MISS</option></select></label>}
        <div className="field-grid"><label className="field-label">姓<span>*</span><input required name="family_name" autoComplete="family-name" maxLength={80} placeholder={englishName ? '例如 ZHANG' : '请输入姓氏'} value={contact.family_name} pattern={englishName ? '[A-Za-z ]+' : undefined} onChange={e => updateContact('family_name', e.target.value)} /></label><label className="field-label">名<span>*</span><input required name="first_name" autoComplete="given-name" maxLength={80} placeholder={englishName ? '例如 WEI' : '请输入名字'} value={contact.first_name} pattern={englishName ? '[A-Za-z ]+' : undefined} onChange={e => updateContact('first_name', e.target.value)} /></label></div>
        <label className="field-label">手机号码<span>*</span><div className="phone-field"><select aria-label="国际电话区号" value={contact.dialing} onChange={e => updateContact('dialing', e.target.value)}><option value="86">+86</option><option value="852">+852</option><option value="853">+853</option><option value="886">+886</option><option value="65">+65</option><option value="60">+60</option><option value="81">+81</option><option value="82">+82</option><option value="66">+66</option><option value="44">+44</option><option value="1">+1</option></select><input required name="mobile" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={15} placeholder="请输入手机号码" value={contact.mobile} onChange={e => updateContact('mobile', e.target.value.replace(/[^0-9]/g, ''))} /></div></label>
        <label className="field-label">电子邮箱{required('email') ? <span>*</span> : <small>选填</small>}<input name="email" type="email" autoComplete="email" required={required('email')} maxLength={150} placeholder="请输入电子邮箱" value={contact.email} onChange={e => updateContact('email', e.target.value)} /></label>
        {required('country') && <label className="field-label">国籍／地区代码<span>*</span><input name="country" required maxLength={2} pattern="[A-Z]{2}" placeholder="例如 CN" value={contact.country} onChange={e => updateContact('country', e.target.value.toUpperCase())} /><small>填写证件上的两位国家／地区代码。</small></label>}
      </section>
      {Boolean(extra.booking_extra_info?.length) && <section className="surface-card form-card"><div className="section-label"><span className="section-step">02</span><h2>预订补充信息</h2></div><ExtraFields fields={extra.booking_extra_info || []} values={bookingValues} setValues={values => { setBookingValues(values); setConfirmedQuote(null); }} /></section>}
      {Boolean(extra.unit_extra_info?.length) && travellers.map((traveller, index) => <section className="surface-card form-card" key={traveller.key}><div className="section-label"><span className="section-step"><UsersRound size={15} /></span><h2>旅客 {index + 1} · {traveller.sku.title}</h2></div><ExtraFields fields={extra.unit_extra_info || []} values={travellerValues[traveller.key] || {}} setValues={values => { setTravellerValues(old => ({ ...old, [traveller.key]: values })); setConfirmedQuote(null); }} /></section>)}
      <section className="surface-card form-card"><div className="section-label"><ShieldCheck size={20} /><h2>预订须知</h2></div>
        {selection.package.cancellation_desc && <details><summary>取消与退款说明<ChevronDown size={16} /></summary><p>{selection.package.cancellation_desc}</p></details>}
        {selection.package.voucher_usage_desc && <details><summary>凭证使用说明<ChevronDown size={16} /></summary><p>{selection.package.voucher_usage_desc}</p></details>}
        <label className="agreement"><input type="checkbox" checked={accepted} required onChange={e => setAccepted(e.target.checked)} /><span>我已核对出行日期、套餐及旅客信息，并阅读以上预订说明。</span></label>
      </section>
      {error && <div className="form-error" role="alert"><Info size={18} /><span>{error}</span></div>}
      <div className="booking-bottom"><div><span>预订总额</span><strong>{formatMoney(displayedPrice, displayedCurrency)}</strong></div><button className="primary-button" type="submit" disabled={busy}>{busy ? '正在确认…' : confirmedQuote ? '确认更新后的价格' : '确认预订'}</button></div>
    </form><p className="secure-caption"><LockKeyhole size={12} />你的信息仅用于本次预订</p>
  </main>;
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
        return code ? <option key={option.key} value={code}>{option.name || option.label}</option> : null;
      })}</select> : <input aria-label={`${field.name || field.key} 国际区号`} placeholder="区号" inputMode="numeric" required={field.required} value={dial} onChange={e => setValues({ ...values, [path]: `${e.target.value.replace(/\D/g, '')}-${phone}` })} />}
        <input id={id} aria-label={field.name || field.key} required={field.required} type="tel" inputMode="numeric" pattern="[0-9]{5,15}" maxLength={15} placeholder="请输入手机号码" value={phone} onChange={e => setValues({ ...values, [path]: `${dial}-${e.target.value.replace(/\D/g, '')}` })} /></div>
        : options.length ? <select id={id} required={field.required} value={value} onChange={e => setValues({ ...values, [path]: e.target.value })}><option value="">请选择</option>{options.map(option => <option value={option.key} key={option.key}>{option.name || option.label || option.key}</option>)}</select>
        : <input id={id} required={field.required} type={type === 'date' ? 'date' : type === 'datetime' ? 'datetime-local' : type === 'email' ? 'email' : type === 'number' ? 'number' : 'text'} minLength={minimum} maxLength={limit} placeholder={field.description || '请输入'} value={value} onChange={e => setValues({ ...values, [path]: e.target.value })} />}
      {field.description && <small className="field-description">{field.description}</small>}</label>
      {children.length > 0 && <div className="nested-fields"><ExtraFields fields={children} values={values} setValues={setValues} prefix={`${path}.`} /></div>}
    </div>;
  })}</>;
}
