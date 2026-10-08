import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { apiGet } from './api';
import type { SearchState } from './types';
import { placeNameZh, categoryNameZh, locationLabelZh } from './localization';
import './catalog.css';

type Category = { category_code: string; category_name: string; sub_categories?: { sub_category_code: string; sub_category_name: string }[] };
type CatalogProduct = { product_code: string; title: string; subtitle?: string; city_name?: string; country_name?: string; category_name?: string; currency?: string | null; price?: string | number | null; images?: { image_url: string; image_type?: string }[] };
type ProductPage = { total: number; page: number; limit: number; has_next: boolean; products: CatalogProduct[] };
type StartingPrice = { product_code: string; status: 'ready' | 'unavailable' | 'error'; price: string | null; currency: string | null; start_date?: string; end_date?: string };
type Props = { mode: 'home' | 'results'; onOpenProduct: (code: string) => void; search: SearchState; activeSearch: SearchState; onSearchChange: (next: SearchState) => void; onSearch: (next: SearchState) => void; onHome: () => void; onOpenSearch: () => void };

const iconPaths: Record<string, ReactNode> = {
  pin: <><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></>,
  search: <><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  ticket: <><path d="M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4V5Z"/><path d="M15 5v3m0 3v2m0 3v3"/></>,
  globe: <><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a20 20 0 0 0 0 20 20 20 0 0 0 0-20Z"/></>,
  arrow: <><path d="M3 12h18m-6-6 6 6-6 6"/></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/></>,
  filter: <><path d="M3 6h18M3 12h18M3 18h18"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="9" cy="18" r="2"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
};

export function CatalogIcon({ name, size = 20, className = '' }: { name: string; size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">{iconPaths[name] || iconPaths.ticket}</svg>;
}

function imageFor(product: CatalogProduct) { return product.images?.find(item => item.image_type === 'BANNER')?.image_url || product.images?.[0]?.image_url; }
function money(value: string | number, currency: string) { const amount = Number(value); if (!Number.isFinite(amount)) return `${currency} ${value}`; try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount); } catch { return `${currency} ${amount.toFixed(2)}`; } }

function ProductStartingPrice({ price }: { price?: StartingPrice }) {
  if (!price) return <span className="cat-see-price" aria-label="正在加载起价">报价加载中…</span>;
  if (price.status === 'error') return <span className="cat-see-price">报价暂不可用</span>;
  if (price.status !== 'ready' || price.price == null || !Number.isFinite(Number(price.price)) || Number(price.price) < 0 || !price.currency) return <span className="cat-see-price">暂无报价</span>;
  return <strong className="cat-product-price" title="未来90天内各套餐可用成人或通用规格最低单价，实际价格以所选日期和套餐为准">{money(price.price, price.currency)}<span className="cat-price-from">起</span></strong>;
}

function ProductImage({ product, className = '' }: { product: CatalogProduct; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = imageFor(product);
  return src && !failed ? <img className={className} src={src} alt={product.title} loading="lazy" onError={() => setFailed(true)} /> : <div className={`cat-image-placeholder ${className}`}><CatalogIcon name="image" size={36}/><span>探索精彩活动</span></div>;
}

export default function Catalog({ mode, onOpenProduct, activeSearch, onSearchChange, onSearch, onHome, onOpenSearch }: Props) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [startingPrices, setStartingPrices] = useState<Record<string, StartingPrice>>({});
  const [priceRetry, setPriceRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const submitted = mode === 'results';
  const [selectedCategory, setSelectedCategory] = useState(activeSearch.category?.code || '');
  const [hasNext, setHasNext] = useState(false);
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [toast, setToast] = useState('');
  const request = useRef(0);

  useEffect(() => {
    let alive = true;
    apiGet<Category[]>('/api/catalog/categories').then(data => { if (alive) setCategories(Array.isArray(data) ? data : []); }).catch(() => {});
    return () => { alive = false; };
  }, [retry]);

  useEffect(() => {
    const current = ++request.current;
    setLoading(true); setError(false); setProducts([]); setPage(1);
    apiGet<ProductPage>('/api/catalog/products', { page: 1, limit: 12, city_codes: submitted ? activeSearch.destination?.code : undefined, keyword: submitted ? activeSearch.keyword || undefined : undefined, category_codes: selectedCategory || undefined })
      .then(data => { if (request.current === current) { setProducts(data.products || []); setHasNext(Boolean(data.has_next)); } })
      .catch(() => { if (request.current === current) setError(true); })
      .finally(() => { if (request.current === current) setLoading(false); });
    return () => { if (request.current === current) request.current++; };
  }, [submitted, activeSearch, selectedCategory, retry]);

  const productCodes = products.map(product => product.product_code).join(',');
  const priceCache = useRef(new Map<string, { value: StartingPrice; expires: number }>());
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const codes = productCodes.split(',').filter(Boolean);
    const cached: Record<string, StartingPrice> = {};
    const missing = codes.filter(code => {
      const entry = priceCache.current.get(code);
      if (!entry || entry.expires <= Date.now()) return true;
      cached[code] = entry.value;
      return false;
    });
    setStartingPrices(cached);
    async function loadPrices() {
      for (let offset = 0; offset < missing.length && active; offset += 4) {
        const batch = missing.slice(offset, offset + 4);
        let prices: StartingPrice[];
        try {
          const data = await apiGet<{ prices: StartingPrice[] }>('/api/catalog/prices', { product_codes: batch.join(',') }, { signal: controller.signal });
          prices = batch.map(code => data.prices?.find(price => price.product_code === code) || { product_code: code, status: 'error', price: null, currency: null });
        } catch {
          prices = batch.map(code => ({ product_code: code, status: 'error', price: null, currency: null }));
        }
        if (!active) return;
        for (const value of prices) if (value.status !== 'error') {
          if (priceCache.current.size >= 300) priceCache.current.delete(priceCache.current.keys().next().value!);
          priceCache.current.set(value.product_code, { value, expires: Date.now() + 30_000 });
        }
        setStartingPrices(previous => ({ ...previous, ...Object.fromEntries(prices.map(value => [value.product_code, value])) }));
      }
    }
    void loadPrices();
    return () => { active = false; controller.abort(); };
  }, [productCodes, priceRetry]);

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

  function chooseCategory(code: string, name = '') {
    if (!submitted) { setSelectedCategory(code); return; }
    const next = { ...activeSearch, category: code ? { code, name } : undefined };
    if (!next.destination && !next.keyword && !next.category) onHome();
    else onSearch(next);
  }

  const resultTitle = activeSearch.destination
    ? `${placeNameZh(activeSearch.destination.name)}${activeSearch.category ? ` · ${categoryNameZh(activeSearch.category.name)}` : '活动'}`
    : activeSearch.keyword ? `“${activeSearch.keyword}”的搜索结果`
    : activeSearch.category ? categoryNameZh(activeSearch.category.name) : '活动列表';

  return <div className="catalog">
    {submitted ? <header className="cat-list-header">
      <button className="cat-icon-button" aria-label="返回首页" onClick={onHome}><span className="cat-back-icon"><CatalogIcon name="chevron"/></span></button>
      <h1>活动列表</h1><span className="cat-list-header-spacer"/>
    </header> : <header className="cat-header"><div className="cat-header-inner"><button className="cat-brand" onClick={onHome} aria-label="RollingGo 首页"><span><img className="cat-brand-logo" src="/design/rollinggo-logo.svg" alt="RollingGo" width="134" height="30"/><small>您的下一次旅程，从这里开始</small></span></button><nav className="cat-desktop-nav" aria-label="主导航"><button onClick={() => setToast('酒店预订请前往 RollingGo 主站')}>酒店</button><button onClick={() => setToast('机票预订请前往 RollingGo 主站')}>机票</button><button className="active" onClick={onHome}>活动体验</button></nav><div className="cat-header-actions"><span className="cat-currency"><CatalogIcon name="globe" size={16}/> 简体中文</span></div></div></header>}


    <main className={`cat-main ${submitted ? 'cat-list-main' : ''}`}>
      {!submitted && <section className="cat-hero">
        <div className="cat-search-panel">
          <div className="cat-service-tabs" role="tablist" aria-label="旅行服务"><button role="tab" aria-selected={false} onClick={() => setToast('酒店预订请前往 RollingGo 主站')}>酒店</button><button role="tab" aria-selected={false} onClick={() => setToast('机票预订请前往 RollingGo 主站')}>机票</button><button role="tab" aria-selected={true} className="active">活动</button></div>
          <div className="cat-search-fields"><button className="cat-search-field cat-destination-field" aria-label="搜索目的地/活动" onClick={onOpenSearch}><CatalogIcon name="search"/><span><strong className="is-placeholder">搜索目的地/活动</strong></span></button><button className="cat-primary-button cat-search-button" onClick={onOpenSearch}>查询</button></div>
        </div>
      </section>}

      <section className="cat-results-section" id="cat-results">
        <div className="cat-section-title"><h2>{submitted ? resultTitle : '热门推荐'}</h2></div>
        {submitted && <button className="cat-list-search" aria-label="修改搜索" onClick={onOpenSearch}><CatalogIcon name="search" size={18}/><span>{activeSearch.keyword || (activeSearch.destination ? placeNameZh(activeSearch.destination.name) : '搜索目的地或活动')}</span><span className="cat-list-search-edit">修改搜索</span></button>}
        {categories.length > 0 && <div className="cat-category-row" aria-label="活动类别"><button className={!selectedCategory ? 'selected' : ''} onClick={() => chooseCategory('')}>全部体验</button>{categories.map(category => <button key={category.category_code} className={selectedCategory === category.category_code ? 'selected' : ''} onClick={() => chooseCategory(category.category_code, category.category_name)}>{categoryNameZh(category.category_name)}</button>)}</div>}
        {loading ? <div className="cat-product-grid" aria-label="正在加载活动">{Array.from({ length: 6 }, (_, index) => <div className="cat-skeleton-card" key={index}><div className="cat-skeleton-photo"/><div className="cat-skeleton-line"/><div className="cat-skeleton-line short"/><div className="cat-skeleton-line price"/></div>)}</div> : error ? <div className="cat-empty-state"><div className="cat-empty-icon"><CatalogIcon name="globe" size={32}/></div><h3>精彩体验正在路上</h3><p>暂时无法加载活动，请稍后重试。</p><button className="cat-secondary-button" onClick={() => setRetry(value => value + 1)}>重新加载</button></div> : products.length === 0 ? <div className="cat-empty-state"><div className="cat-empty-icon"><CatalogIcon name="search" size={32}/></div><h3>暂时没有找到相关活动</h3><p>试试其他目的地或活动类别，探索更多精彩。</p><button className="cat-secondary-button" onClick={() => { setSelectedCategory(''); const next = { ...activeSearch, keyword: '', category: undefined }; onSearchChange(next); if (submitted) { if (next.destination) onSearch(next); else onHome(); } }}>查看全部体验</button></div> : <div className="cat-product-grid">{products.map(product => <article className="cat-product-card" key={product.product_code}><div className="cat-product-photo"><button className="cat-photo-link" onClick={() => onOpenProduct(product.product_code)} aria-label={`查看 ${product.title}`}><ProductImage product={product}/></button>{product.category_name && <span className="cat-product-category">{categoryNameZh(product.category_name)}</span>}</div><button className="cat-product-info" onClick={() => onOpenProduct(product.product_code)}>{(product.city_name || product.country_name) && <span className="cat-product-location"><CatalogIcon name="pin" size={13}/>{locationLabelZh(product.city_name, product.country_name)}</span>}<h3>{product.title}</h3>{product.subtitle && <p className="cat-product-subtitle">{product.subtitle}</p>}<div className="cat-product-bottom"><div><ProductStartingPrice price={startingPrices[product.product_code]}/></div><span className="cat-product-arrow"><CatalogIcon name="arrow" size={19}/></span></div></button></article>)}</div>}
        {!loading && Object.values(startingPrices).some(price => price.status === 'error') && <button className="cat-text-button cat-price-retry" onClick={() => setPriceRetry(value => value + 1)}>重新加载报价</button>}
        {!loading && !error && hasNext && <div className="cat-load-more"><button className="cat-secondary-button" onClick={loadMore} disabled={loadingMore}>{loadingMore ? '加载中…' : '探索更多活动'}{!loadingMore && <CatalogIcon name="arrow" size={17}/>}</button></div>}
      </section>

      <footer className="cat-footer"><small>© {new Date().getFullYear()} RollingGo · 活动体验 DEMO</small></footer>
    </main>



    {toast && <div className="cat-toast" role="status">{toast}</div>}
  </div>;
}
