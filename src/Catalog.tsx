import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { apiGet } from './api';
import type { Destination, SearchState } from './types';
import './catalog.css';

type City = { city_code: string; city_name: string; country_name?: string; country_code?: string };
type Category = { category_code: string; category_name: string; sub_categories?: { sub_category_code: string; sub_category_name: string }[] };
type CatalogProduct = { product_code: string; title: string; subtitle?: string; city_name?: string; country_name?: string; category_name?: string; currency?: string | null; price?: string | number | null; images?: { image_url: string; image_type?: string }[] };
type ProductPage = { total: number; page: number; limit: number; has_next: boolean; products: CatalogProduct[] };
type Sheet = 'destination' | 'dates' | 'adults' | null;
type Props = { onOpenProduct: (code: string) => void; search: SearchState; onSearchChange: (next: SearchState) => void };

const iconPaths: Record<string, ReactNode> = {
  pin: <><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></>,
  search: <><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 2v6m10-6v6M3 11h18m-13 5h2m4 0h2"/></>,
  people: <><circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-17a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v3"/></>,
  heart: <path d="m12 21-8.5-8.3C-2 7.3 6.3-.6 12 5c5.7-5.6 14 2.3 8.5 7.7Z"/>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  hotel: <><path d="M3 20V5m18 15V9M3 15h18M3 9h5a3 3 0 0 1 3 3v3m0-6h7a3 3 0 0 1 3 3"/><path d="M5 9V6h3v3"/></>,
  flight: <path d="m22 2-7 20-3-10L2 9 22 2Zm-10 10L22 2"/>,
  ticket: <><path d="M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4V5Z"/><path d="M15 5v3m0 3v2m0 3v3"/></>,
  home: <><path d="m3 10 9-8 9 8v11H3V10Z"/><path d="M9 21v-8h6v8"/></>,
  bag: <><rect x="4" y="7" width="16" height="15" rx="3"/><path d="M8 7V5a4 4 0 0 1 8 0v2m-8 5h8"/></>,
  user: <><circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/></>,
  globe: <><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a20 20 0 0 0 0 20 20 20 0 0 0 0-20Z"/></>,
  plus: <path d="M12 4v16M4 12h16"/>,
  minus: <path d="M4 12h16"/>,
  arrow: <><path d="M3 12h18m-6-6 6 6-6 6"/></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/></>,
  sparkle: <><path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z"/><path d="m20 2 1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z"/></>,
  filter: <><path d="M3 6h18M3 12h18M3 18h18"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="9" cy="18" r="2"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
};

export function CatalogIcon({ name, size = 20, className = '' }: { name: string; size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">{iconPaths[name] || iconPaths.ticket}</svg>;
}

function localDate(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function prettyDate(value: string) { const parts = value.split('-'); return value ? `${Number(parts[1])}月${Number(parts[2])}日` : ''; }
function imageFor(product: CatalogProduct) { return product.images?.find(item => item.image_type === 'BANNER')?.image_url || product.images?.[0]?.image_url; }
function money(value: string | number, currency: string) { const amount = Number(value); if (!Number.isFinite(amount)) return `${currency} ${value}`; try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount); } catch { return `${currency} ${amount.toFixed(2)}`; } }

function ProductImage({ product, className = '' }: { product: CatalogProduct; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = imageFor(product);
  return src && !failed ? <img className={className} src={src} alt={product.title} loading="lazy" onError={() => setFailed(true)} /> : <div className={`cat-image-placeholder ${className}`}><CatalogIcon name="image" size={36}/><span>探索精彩活动</span></div>;
}

function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    (ref.current?.querySelector<HTMLElement>('input') || ref.current?.querySelector<HTMLElement>('button, [tabindex="0"]'))?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
      if (event.key !== 'Tab') return;
      const items = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]');
      if (!items?.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', listener);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', listener); previous?.focus(); };
  }, []);
  return <div className="cat-modal-backdrop" onClick={onClose}><div className="cat-sheet" role="dialog" aria-modal="true" aria-label={title} ref={ref} onClick={event => event.stopPropagation()}><div className="cat-sheet-handle"/><header className="cat-sheet-header"><h2>{title}</h2><button className="cat-icon-button" onClick={onClose} aria-label="关闭"><CatalogIcon name="close"/></button></header><div className="cat-sheet-body">{children}</div>{footer && <footer className="cat-sheet-footer">{footer}</footer>}</div></div>;
}

export default function Catalog({ onOpenProduct, search, onSearchChange }: Props) {
  const [cities, setCities] = useState<City[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [cityLoading, setCityLoading] = useState(true);
  const [cityError, setCityError] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [cityKeyword, setCityKeyword] = useState('');
  const [country, setCountry] = useState('');
  const [submitted, setSubmitted] = useState(Boolean(search.destination));
  const [activeSearch, setActiveSearch] = useState<SearchState>(search);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [total, setTotal] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [savedProducts, setSavedProducts] = useState<CatalogProduct[]>([]);
  const [savedOnly, setSavedOnly] = useState(false);
  const [toast, setToast] = useState('');
  const [destinationRequired, setDestinationRequired] = useState(false);
  const [draftStart, setDraftStart] = useState(search.startDate);
  const [draftEnd, setDraftEnd] = useState(search.endDate);
  const [draftAdults, setDraftAdults] = useState(search.adults);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const request = useRef(0);
  const today = localDate();
  const countryNames = [...new Set(cities.map(city => city.country_name).filter(Boolean))] as string[];
  const visibleCities = cities.filter(city => (!country || country === city.country_name) && `${city.city_name} ${city.country_name || ''}`.toLocaleLowerCase().includes(cityKeyword.toLocaleLowerCase()));
  const saved = savedProducts.map(product => product.product_code);
  const displayedProducts = savedOnly ? savedProducts : products;

  useEffect(() => {
    let alive = true;
    setCityLoading(true); setCityError(false);
    apiGet<City[]>('/api/catalog/cities').then(data => { if (alive) setCities(Array.isArray(data) ? data : []); }).catch(() => { if (alive) setCityError(true); }).finally(() => { if (alive) setCityLoading(false); });
    apiGet<Category[]>('/api/catalog/categories').then(data => { if (alive) setCategories(Array.isArray(data) ? data : []); }).catch(() => {});
    return () => { alive = false; };
  }, [retry]);

  useEffect(() => {
    const current = ++request.current;
    setLoading(true); setError(false); setProducts([]); setPage(1);
    apiGet<ProductPage>('/api/catalog/products', { page: 1, limit: 12, city_codes: submitted ? activeSearch.destination?.code : undefined, keyword: submitted ? activeSearch.keyword || undefined : undefined, category_codes: selectedCategory || undefined })
      .then(data => { if (request.current === current) { setProducts(data.products || []); setTotal(data.total || 0); setHasNext(Boolean(data.has_next)); } })
      .catch(() => { if (request.current === current) setError(true); })
      .finally(() => { if (request.current === current) setLoading(false); });
    return () => { if (request.current === current) request.current++; };
  }, [submitted, activeSearch, selectedCategory, retry]);

  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3400); return () => clearTimeout(timer); }, [toast]);

  async function loadMore() {
    if (loadingMore) return;
    const current = request.current;
    setLoadingMore(true);
    try {
      const data = await apiGet<ProductPage>('/api/catalog/products', { page: page + 1, limit: 12, city_codes: submitted ? activeSearch.destination?.code : undefined, keyword: submitted ? activeSearch.keyword || undefined : undefined, category_codes: selectedCategory || undefined });
      if (current === request.current) { setProducts(previous => [...previous, ...(data.products || [])]); setPage(page + 1); setHasNext(Boolean(data.has_next)); }
    } catch { setToast('暂时无法加载更多活动，请重试'); }
    finally { setLoadingMore(false); }
  }

  function selectCity(city: City) {
    const destination: Destination = { code: String(city.city_code), name: city.city_name, countryName: city.country_name };
    const next = { ...search, destination };
    onSearchChange(next);
    if (submitted) { setActiveSearch(next); setSavedOnly(false); }
    setDestinationRequired(false); setSheet(null);
  }
  function runSearch() {
    if (!search.destination) { setDestinationRequired(true); setSheet('destination'); return; }
    setSubmitted(true); setActiveSearch({ ...search }); setSavedOnly(false);
    setTimeout(() => document.getElementById('cat-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  }
  function chooseRecommendedCity(city: City) {
    const next: SearchState = { ...search, destination: { code: String(city.city_code), name: city.city_name, countryName: city.country_name }, keyword: '' };
    onSearchChange(next); setActiveSearch(next); setSubmitted(true); setSavedOnly(false); setSelectedCategory('');
    setTimeout(() => document.getElementById('cat-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  }
  function openSheet(next: Sheet) {
    if (next === 'dates') { setDraftStart(search.startDate); setDraftEnd(search.endDate); }
    if (next === 'adults') setDraftAdults(search.adults);
    setSheet(next);
  }
  function toggleSave(code: string) {
    setSavedProducts(values => {
      if (values.some(product => product.product_code === code)) return values.filter(product => product.product_code !== code);
      const product = products.find(item => item.product_code === code);
      return product ? [...values, product] : values;
    });
  }
  function chooseDate(value: string) {
    if (!draftStart || draftEnd || value < draftStart) { setDraftStart(value); setDraftEnd(''); }
    else setDraftEnd(value);
  }
  const firstDay = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1).getDay();
  const days = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();

  return <div className="catalog">
    <header className="cat-header"><div className="cat-header-inner"><button className="cat-brand" onClick={() => { setSubmitted(false); setSelectedCategory(''); setSavedOnly(false); window.scrollTo({ top: 0, behavior: 'smooth' }); }} aria-label="RollingGo 首页"><span className="cat-brand-mark">r<span/></span><span>Rolling<span className="cat-brand-go">Go</span><small>ANT · 活动体验</small></span></button><nav className="cat-desktop-nav" aria-label="主导航"><button onClick={() => setToast('酒店预订请前往 RollingGo 主站')}>酒店</button><button onClick={() => setToast('机票预订请前往 RollingGo 主站')}>机票</button><button className="active" onClick={() => { setSubmitted(false); setSavedOnly(false); }}>活动体验</button></nav><div className="cat-header-actions"><span className="cat-currency"><CatalogIcon name="globe" size={16}/> 简体中文</span><button className={`cat-icon-button ${savedOnly ? 'is-saved' : ''}`} onClick={() => { setSavedOnly(!savedOnly); setTimeout(() => document.getElementById('cat-results')?.scrollIntoView({ behavior: 'smooth' }), 60); }} aria-label="查看已收藏活动"><CatalogIcon name="heart" size={22}/>{saved.length > 0 && <span className="cat-count-dot">{saved.length}</span>}</button></div></div></header>

    <main className="cat-main">
      <section className={`cat-hero ${submitted ? 'cat-hero-compact' : ''}`}>
        <div className="cat-search-panel">
          <div className="cat-service-tabs" role="tablist" aria-label="旅行服务"><button role="tab" aria-selected={false} onClick={() => setToast('酒店预订请前往 RollingGo 主站')}><CatalogIcon name="hotel"/>酒店</button><button role="tab" aria-selected={false} onClick={() => setToast('机票预订请前往 RollingGo 主站')}><CatalogIcon name="flight"/>机票</button><button role="tab" aria-selected={true} className="active"><CatalogIcon name="ticket"/>活动</button></div>
          <div className="cat-search-fields"><button className={`cat-search-field cat-destination-field ${destinationRequired ? 'cat-field-invalid' : ''}`} onClick={() => openSheet('destination')}><CatalogIcon name="pin"/><span><small>目的地 <em>必填</em></small><strong className={!search.destination ? 'is-placeholder' : ''}>{search.destination?.name || '你想去哪里？'}</strong></span><CatalogIcon name="chevron" size={17}/></button><div className="cat-search-field-row"><button className="cat-search-field" onClick={() => openSheet('dates')}><CatalogIcon name="calendar"/><span><small>出行日期 <em>选填</em></small><strong className={!search.startDate ? 'is-placeholder' : ''}>{search.startDate ? `${prettyDate(search.startDate)}${search.endDate && search.endDate !== search.startDate ? ` — ${prettyDate(search.endDate)}` : ''}` : '选择日期范围'}</strong></span></button><button className="cat-search-field" onClick={() => openSheet('adults')}><CatalogIcon name="people"/><span><small>人数 <em>选填</em></small><strong className={search.adults == null ? 'is-placeholder' : ''}>{search.adults == null ? '成人数量' : `${search.adults} 位成人`}</strong></span></button></div><button className="cat-primary-button cat-search-button" onClick={runSearch}><CatalogIcon name="search" size={19}/>搜索活动</button></div>
          {!submitted && <p className="cat-search-help">选择目的地即可出发，日期和人数稍后再定。</p>}
        </div>
      </section>

      {!submitted && cities.length > 0 && <section className="cat-destinations"><div className="cat-section-title"><div><span className="cat-kicker">WHERE TO NEXT</span><h2>下一站，去哪里？</h2></div><button className="cat-text-button" onClick={() => openSheet('destination')}>全部目的地<CatalogIcon name="chevron" size={15}/></button></div><div className="cat-city-row">{cities.slice(0, 8).map((city, index) => <button className="cat-city-pill" key={city.city_code} onClick={() => chooseRecommendedCity(city)}><span className={`cat-city-symbol cat-city-symbol-${index % 4}`}><CatalogIcon name={['pin', 'globe', 'ticket', 'sparkle'][index % 4]} size={22}/></span><span><strong>{city.city_name}</strong><small>{city.country_name}</small></span><CatalogIcon name="arrow" size={16}/></button>)}</div></section>}

      <section className="cat-results-section" id="cat-results">
        <div className="cat-section-title"><div>{!submitted && <span className="cat-kicker">MAKE MEMORIES</span>}<h2>{savedOnly ? '我的收藏' : submitted ? `${activeSearch.destination?.name || ''} · 活动体验` : '值得出发的精彩体验'}{!loading && !error && <span className="cat-result-count">{savedOnly ? displayedProducts.length : total} 项活动</span>}</h2>{submitted && <p className="cat-results-subtitle">{activeSearch.startDate ? `${prettyDate(activeSearch.startDate)}${activeSearch.endDate && activeSearch.endDate !== activeSearch.startDate ? ` — ${prettyDate(activeSearch.endDate)}` : ''} · ` : ''}{activeSearch.adults != null ? `${activeSearch.adults} 位成人 · ` : ''}{activeSearch.startDate || activeSearch.adults != null ? '日期与人数将在选择套餐时确认' : '选择心仪活动，查看可预订套餐'}</p>}</div>{submitted && <button className="cat-round-button" onClick={() => openSheet('destination')}><CatalogIcon name="filter" size={16}/><span>目的地</span></button>}</div>
        {submitted && <label className="cat-keyword-search"><CatalogIcon name="search" size={18}/><input aria-label="搜索目的地内的活动" placeholder={`搜索${activeSearch.destination?.name || ''}的活动、景点…`} value={search.keyword} onChange={event => onSearchChange({ ...search, keyword: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') runSearch(); }}/>{search.keyword && <button onClick={() => { const next = { ...search, keyword: '' }; onSearchChange(next); setActiveSearch(next); }} aria-label="清除关键词"><CatalogIcon name="close" size={16}/></button>}<button className="cat-keyword-submit" onClick={runSearch}>搜索</button></label>}
        {categories.length > 0 && <div className="cat-category-row" aria-label="活动类别"><button className={!selectedCategory ? 'selected' : ''} onClick={() => setSelectedCategory('')}>全部体验</button>{categories.map(category => <button key={category.category_code} className={selectedCategory === category.category_code ? 'selected' : ''} onClick={() => setSelectedCategory(category.category_code)}>{category.category_name}</button>)}</div>}
        {loading ? <div className="cat-product-grid" aria-label="正在加载活动">{Array.from({ length: 6 }, (_, index) => <div className="cat-skeleton-card" key={index}><div className="cat-skeleton-photo"/><div className="cat-skeleton-line"/><div className="cat-skeleton-line short"/><div className="cat-skeleton-line price"/></div>)}</div> : error ? <div className="cat-empty-state"><div className="cat-empty-icon"><CatalogIcon name="globe" size={32}/></div><h3>精彩体验正在路上</h3><p>暂时无法加载活动，请稍后重试。</p><button className="cat-secondary-button" onClick={() => setRetry(value => value + 1)}>重新加载</button></div> : displayedProducts.length === 0 ? <div className="cat-empty-state"><div className="cat-empty-icon"><CatalogIcon name={savedOnly ? 'heart' : 'search'} size={32}/></div><h3>{savedOnly ? '收藏你的心动体验' : '暂时没有找到相关活动'}</h3><p>{savedOnly ? '点击活动卡片上的爱心，留住下一次出发的灵感。' : '试试其他目的地或活动类别，探索更多精彩。'}</p><button className="cat-secondary-button" onClick={() => { if (savedOnly) setSavedOnly(false); else { setSelectedCategory(''); onSearchChange({ ...search, keyword: '' }); setActiveSearch({ ...activeSearch, keyword: '' }); } }}>查看全部体验</button></div> : <div className="cat-product-grid">{displayedProducts.map(product => <article className="cat-product-card" key={product.product_code}><div className="cat-product-photo"><button className="cat-photo-link" onClick={() => onOpenProduct(product.product_code)} aria-label={`查看 ${product.title}`}><ProductImage product={product}/></button>{product.category_name && <span className="cat-product-category">{product.category_name}</span>}<button className={`cat-save-button ${saved.includes(product.product_code) ? 'is-saved' : ''}`} aria-label={`${saved.includes(product.product_code) ? '取消收藏' : '收藏'} ${product.title}`} aria-pressed={saved.includes(product.product_code)} onClick={() => toggleSave(product.product_code)}><CatalogIcon name="heart" size={20}/></button></div><button className="cat-product-info" onClick={() => onOpenProduct(product.product_code)}>{(product.city_name || product.country_name) && <span className="cat-product-location"><CatalogIcon name="pin" size={13}/>{[product.city_name, product.country_name].filter(Boolean).join(' · ')}</span>}<h3>{product.title}</h3>{product.subtitle && <p className="cat-product-subtitle">{product.subtitle}</p>}<div className="cat-product-bottom"><div>{product.price != null && product.price !== '' && Number.isFinite(Number(product.price)) && Number(product.price) > 0 && product.currency ? <><span className="cat-reference-label">参考价</span><strong className="cat-product-price">{money(product.price, product.currency)}</strong></> : <span className="cat-see-price">选择套餐查看价格</span>}</div><span className="cat-product-arrow"><CatalogIcon name="arrow" size={19}/></span></div></button></article>)}</div>}
        {!loading && !error && hasNext && !savedOnly && <div className="cat-load-more"><button className="cat-secondary-button" onClick={loadMore} disabled={loadingMore}>{loadingMore ? '加载中…' : '探索更多活动'}{!loadingMore && <CatalogIcon name="arrow" size={17}/>}</button></div>}
      </section>

      <footer className="cat-footer"><small>© {new Date().getFullYear()} RollingGo · 活动体验 DEMO</small></footer>
    </main>

    <nav className="cat-bottom-nav" aria-label="底部导航"><button className={!savedOnly ? 'active' : ''} onClick={() => { setSavedOnly(false); setSubmitted(false); setSelectedCategory(''); window.scrollTo({ top: 0, behavior: 'smooth' }); }}><CatalogIcon name="home" size={22}/><span>首页</span></button><button onClick={() => { setSavedOnly(false); document.getElementById('cat-results')?.scrollIntoView({ behavior: 'smooth' }); }}><CatalogIcon name="ticket" size={22}/><span>探索</span></button><button className={savedOnly ? 'active' : ''} onClick={() => { setSavedOnly(true); document.getElementById('cat-results')?.scrollIntoView({ behavior: 'smooth' }); }}><CatalogIcon name="heart" size={22}/><span>收藏</span></button><button onClick={() => setToast('账户与订单请前往 RollingGo 主站')}><CatalogIcon name="user" size={22}/><span>我的</span></button></nav>

    {sheet === 'destination' && <Modal title="想去哪里？" onClose={() => setSheet(null)}><p className="cat-sheet-intro">选择目的地，发现当地的精彩活动。</p>{destinationRequired && <p className="cat-validation-message" role="alert">请先选择一个目的地</p>}<label className="cat-destination-search"><CatalogIcon name="search"/><input autoComplete="off" value={cityKeyword} onChange={event => setCityKeyword(event.target.value)} placeholder="搜索城市或国家" aria-label="搜索城市或国家"/></label>{countryNames.length > 1 && <div className="cat-country-row"><button className={!country ? 'active' : ''} onClick={() => setCountry('')}>全部</button>{countryNames.map(name => <button key={name} className={name === country ? 'active' : ''} onClick={() => setCountry(name)}>{name}</button>)}</div>}{cityLoading ? <div className="cat-sheet-status">正在加载目的地…</div> : cityError ? <div className="cat-sheet-status"><p>暂时无法加载目的地</p><button className="cat-secondary-button" onClick={() => setRetry(value => value + 1)}>重试</button></div> : visibleCities.length === 0 ? <div className="cat-sheet-status">没有找到这个目的地，试试其他城市。</div> : <div className="cat-destination-list">{visibleCities.map(city => <button key={city.city_code} className={search.destination?.code === String(city.city_code) ? 'selected' : ''} onClick={() => selectCity(city)}><span className="cat-destination-icon"><CatalogIcon name="pin"/></span><span><strong>{city.city_name}</strong><small>{city.country_name}</small></span>{search.destination?.code === String(city.city_code) ? <CatalogIcon name="check" size={19}/> : <CatalogIcon name="chevron" size={16}/>}</button>)}</div>}</Modal>}
    {sheet === 'dates' && <Modal title="选择出行日期" onClose={() => setSheet(null)} footer={<><button className="cat-sheet-clear" onClick={() => { onSearchChange({ ...search, startDate: '', endDate: '' }); setSheet(null); }}>暂不选择</button><button className="cat-primary-button" onClick={() => { onSearchChange({ ...search, startDate: draftStart, endDate: draftEnd || draftStart }); setSheet(null); }} disabled={!draftStart}>确认日期</button></>}><p className="cat-sheet-intro">可选择日期范围，也可以在同一天出行。</p><div className="cat-date-summary"><div><small>开始日期</small><strong>{draftStart ? prettyDate(draftStart) : '请选择'}</strong></div><CatalogIcon name="arrow" size={19}/><div><small>结束日期</small><strong>{draftEnd ? prettyDate(draftEnd) : draftStart ? '选择结束日期' : '请选择'}</strong></div></div><div className="cat-calendar-heading"><button className="cat-icon-button" aria-label="上一个月" disabled={calendarMonth.getFullYear() === new Date().getFullYear() && calendarMonth.getMonth() === new Date().getMonth()} onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}><span className="cat-flip"><CatalogIcon name="chevron"/></span></button><strong>{calendarMonth.getFullYear()}年{calendarMonth.getMonth() + 1}月</strong><button className="cat-icon-button" aria-label="下一个月" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}><CatalogIcon name="chevron"/></button></div><div className="cat-calendar-grid">{['日', '一', '二', '三', '四', '五', '六'].map(day => <span className="cat-calendar-weekday" key={day}>{day}</span>)}{Array.from({ length: firstDay }, (_, index) => <span key={`empty-${index}`}/>)}{Array.from({ length: days }, (_, index) => { const date = localDate(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), index + 1)); const endpoint = date === draftStart || date === draftEnd; const inside = draftStart && draftEnd && date > draftStart && date < draftEnd; return <button key={date} disabled={date < today} className={`${endpoint ? 'selected' : ''} ${inside ? 'in-range' : ''}`} onClick={() => chooseDate(date)} aria-label={`${date}${endpoint ? ' 已选择' : ''}`}>{index + 1}{date === today && <small>今天</small>}</button>; })}</div>{draftStart && <button className="cat-same-day" onClick={() => setDraftEnd(draftStart)}>仅选择 {prettyDate(draftStart)} 当天</button>}</Modal>}
    {sheet === 'adults' && <Modal title="有几位成人同行？" onClose={() => setSheet(null)} footer={<><button className="cat-sheet-clear" onClick={() => { onSearchChange({ ...search, adults: null }); setSheet(null); }}>暂不选择</button><button className="cat-primary-button" onClick={() => { onSearchChange({ ...search, adults: draftAdults ?? 1 }); setSheet(null); }}>确认人数</button></>}><p className="cat-sheet-intro">先填写成人数量，具体人群规格可在套餐中选择。</p><div className="cat-adults-row"><div><strong>成人</strong><small>出行人数</small></div><div className="cat-counter"><button disabled={(draftAdults ?? 1) <= 1} onClick={() => setDraftAdults(Math.max(1, (draftAdults ?? 1) - 1))} aria-label="减少成人人数"><CatalogIcon name="minus" size={18}/></button><strong>{draftAdults ?? 1}</strong><button disabled={(draftAdults ?? 1) >= 99} onClick={() => setDraftAdults(Math.min(99, (draftAdults ?? 1) + 1))} aria-label="增加成人人数"><CatalogIcon name="plus" size={18}/></button></div></div></Modal>}
    {toast && <div className="cat-toast" role="status">{toast}</div>}
  </div>;
}
