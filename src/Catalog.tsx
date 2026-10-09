import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { apiGet, formatMoney as money } from './api';
import type { SearchState } from './types';
import { categoryNameZh, locationLabelZh } from './localization';
import { validActivityCount } from './searchSuggestions';
import PriceSkeleton from './PriceSkeleton';
import './catalog.css';

type Category = { category_code: string; category_name: string; sub_categories?: { sub_category_code: string; sub_category_name: string }[] };
type CatalogProduct = { product_code: string; title: string; subtitle?: string; city_name?: string; country_name?: string; category_name?: string; currency?: string | null; price?: string | number | null; images?: { image_url: string; image_type?: string }[] };
type ProductPage = { total: number; page: number; limit: number; has_next: boolean; products: CatalogProduct[] };
type StartingPrice = { product_code: string; status: 'ready' | 'unavailable' | 'error'; price: string | null; currency: string | null; start_date?: string; end_date?: string };
type Props = { mode: 'home' | 'results'; onOpenProduct: (code: string) => void; search: SearchState; activeSearch: SearchState; onSearchChange: (next: SearchState) => void; onSearch: (next: SearchState) => void; onHome: () => void; onOpenSearch: () => void };

const featuredProductCodes = ['11AF', '12Y2', '13'] as const;
type CategoryAvailability = { context: string; counts: Record<string, number>; loading: boolean; failed: boolean };
const categoryCountCache = new Map<string, { counts: Record<string, number>; expires: number }>();

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

function ProductStartingPrice({ price }: { price?: StartingPrice }) {
  if (!price) return <PriceSkeleton />;
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
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [categoriesFailed, setCategoriesFailed] = useState(false);
  const [categoryAvailability, setCategoryAvailability] = useState<CategoryAvailability>({ context: '', counts: {}, loading: true, failed: false });
  const [categoryRetry, setCategoryRetry] = useState(0);
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [featuredProducts, setFeaturedProducts] = useState<CatalogProduct[]>([]);
  const [featuredLoading, setFeaturedLoading] = useState(true);
  const [featuredError, setFeaturedError] = useState(false);
  const [startingPrices, setStartingPrices] = useState<Record<string, StartingPrice>>({});
  const [priceRetry, setPriceRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [error, setError] = useState(false);
  const submitted = mode === 'results';
  const [selectedCategory, setSelectedCategory] = useState(activeSearch.category?.code || '');
  const [hasNext, setHasNext] = useState(false);
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [toast, setToast] = useState('');
  const request = useRef(0);
  const loadMoreLock = useRef(false);
  const loadMoreController = useRef<AbortController | null>(null);
  const loadMoreSentinel = useRef<HTMLDivElement>(null);
  const categoryReset = useRef('');
  const categoryCity = activeSearch.destination?.code || '';
  const categoryKeyword = activeSearch.keyword || '';
  const categoryContext = JSON.stringify([categoryCity, categoryKeyword]);
  const categoryCodes = categories.map(category => category.category_code).join(',');

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setCategoriesLoading(true); setCategoriesFailed(false);
    apiGet<Category[]>('/api/catalog/categories', {}, { signal: controller.signal })
      .then(data => { if (alive) setCategories(Array.isArray(data) ? data : []); })
      .catch(() => { if (alive) setCategoriesFailed(true); })
      .finally(() => { if (alive) setCategoriesLoading(false); });
    return () => { alive = false; controller.abort(); };
  }, [retry]);

  useEffect(() => {
    if (!submitted) return;
    let active = true;
    const controller = new AbortController();
    const cached = categoryCountCache.get(categoryContext);
    const counts = cached && cached.expires > Date.now() ? { ...cached.counts } : {};
    const codes = categoryCodes.split(',').filter(Boolean);
    const missing = codes.filter(code => counts[code] === undefined);
    setCategoryAvailability({ context: categoryContext, counts, loading: categoriesLoading || missing.length > 0 && !categoriesFailed, failed: categoriesFailed });
    if (categoriesLoading || categoriesFailed || !missing.length) return () => { active = false; controller.abort(); };

    async function loadCategoryCounts() {
      let failed = false;
      for (let offset = 0; offset < missing.length && active; offset += 4) {
        const batch = await Promise.allSettled(missing.slice(offset, offset + 4).map(async code => {
          const data = await apiGet<{ total: unknown }>('/api/catalog/products', {
            page: 1, limit: 1, city_codes: categoryCity || undefined,
            keyword: categoryKeyword || undefined, category_codes: code,
          }, { signal: controller.signal });
          const count = validActivityCount(data.total);
          if (count === null) throw new Error('Invalid activity count');
          return { code, count };
        }));
        if (!active) return;
        for (const result of batch) {
          if (result.status === 'fulfilled') counts[result.value.code] = result.value.count;
          else failed = true;
        }
        if (categoryCountCache.size >= 50 && !categoryCountCache.has(categoryContext)) categoryCountCache.delete(categoryCountCache.keys().next().value!);
        categoryCountCache.set(categoryContext, { counts: { ...counts }, expires: Date.now() + 30_000 });
        setCategoryAvailability({ context: categoryContext, counts: { ...counts }, loading: offset + 4 < missing.length, failed });
      }
    }
    void loadCategoryCounts();
    return () => { active = false; controller.abort(); };
  }, [submitted, categoryContext, categoryCity, categoryKeyword, categoryCodes, categoriesLoading, categoriesFailed, categoryRetry]);

  useEffect(() => {
    if (!submitted || !selectedCategory || categoryAvailability.context !== categoryContext || categoryAvailability.counts[selectedCategory] !== 0) return;
    const reset = `${categoryContext}:${selectedCategory}`;
    if (categoryReset.current === reset) return;
    categoryReset.current = reset;
    const next = { ...activeSearch, category: undefined };
    if (next.destination || next.keyword) onSearch(next);
    else onHome();
  }, [submitted, selectedCategory, categoryAvailability, categoryContext, activeSearch, onSearch, onHome]);

  useEffect(() => {
    if (submitted) return;
    let active = true;
    const controller = new AbortController();
    setFeaturedProducts([]); setFeaturedLoading(true); setFeaturedError(false);
    async function loadFeatured() {
      const selected = new Map<string, CatalogProduct>();
      try {
        for (let number = 1; number <= 6; number++) {
          const data = await apiGet<ProductPage>('/api/catalog/products', { page: number, limit: 50 }, { signal: controller.signal });
          if (!active) return;
          for (const product of data.products || []) {
            if (featuredProductCodes.some(code => code === product.product_code)) selected.set(product.product_code, product);
          }
          setFeaturedProducts(featuredProductCodes.map(code => selected.get(code)).filter((product): product is CatalogProduct => Boolean(product)));
          if (selected.size === featuredProductCodes.length || !data.has_next) break;
        }
      } catch { if (active) setFeaturedError(true); }
      finally { if (active) setFeaturedLoading(false); }
    }
    void loadFeatured();
    return () => { active = false; controller.abort(); };
  }, [submitted, retry]);

  useEffect(() => {
    const current = ++request.current;
    const controller = new AbortController();
    loadMoreController.current?.abort(); loadMoreController.current = null; loadMoreLock.current = false;
    setLoadingMore(false); setLoadMoreFailed(false);
    setLoading(true); setError(false); setProducts([]); setPage(1);
    apiGet<ProductPage>('/api/catalog/products', { page: 1, limit: 12, city_codes: submitted ? activeSearch.destination?.code : undefined, keyword: submitted ? activeSearch.keyword || undefined : undefined, category_codes: selectedCategory || undefined }, { signal: controller.signal })
      .then(data => { if (request.current === current) { setProducts(data.products || []); setHasNext(Boolean(data.has_next)); } })
      .catch(() => { if (request.current === current) setError(true); })
      .finally(() => { if (request.current === current) setLoading(false); });
    return () => { controller.abort(); loadMoreController.current?.abort(); if (request.current === current) request.current++; };
  }, [submitted, activeSearch, selectedCategory, retry]);

  const productCodes = products.map(product => product.product_code).join(',');
  const priceCache = useRef(new Map<string, { value: StartingPrice; expires: number }>());
  useEffect(() => {
    if (!submitted) { setStartingPrices({}); return; }
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
  }, [submitted, productCodes, priceRetry]);

  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3400); return () => clearTimeout(timer); }, [toast]);

  const loadMore = useCallback(async (retryFailed = false) => {
    if (!submitted || loading || error || !hasNext || loadMoreLock.current || loadMoreFailed && !retryFailed) return;
    loadMoreLock.current = true;
    const current = request.current;
    const controller = new AbortController();
    loadMoreController.current = controller;
    setLoadingMore(true); setLoadMoreFailed(false);
    try {
      const data = await apiGet<ProductPage>('/api/catalog/products', { page: page + 1, limit: 12, city_codes: categoryCity || undefined, keyword: categoryKeyword || undefined, category_codes: selectedCategory || undefined }, { signal: controller.signal });
      if (current !== request.current || controller.signal.aborted) return;
      const known = new Set(products.map(product => product.product_code));
      const added = (data.products || []).filter(product => {
        if (known.has(product.product_code)) return false;
        known.add(product.product_code); return true;
      });
      setProducts(previous => [...previous, ...added]); setPage(page + 1);
      setHasNext(Boolean(data.has_next) && added.length > 0);
    } catch {
      if (current === request.current && !controller.signal.aborted) setLoadMoreFailed(true);
    } finally {
      if (current === request.current && loadMoreController.current === controller) {
        loadMoreController.current = null; loadMoreLock.current = false; setLoadingMore(false);
      }
    }
  }, [submitted, loading, error, hasNext, loadMoreFailed, page, products, categoryCity, categoryKeyword, selectedCategory]);

  useEffect(() => {
    const sentinel = loadMoreSentinel.current;
    if (!submitted || loading || error || loadingMore || loadMoreFailed || !hasNext || !sentinel) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { rootMargin: '320px 0px', threshold: 0 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [submitted, loading, error, loadingMore, loadMoreFailed, hasNext, loadMore]);

  function chooseCategory(code: string, name = '') {
    if (!submitted) { setSelectedCategory(code); return; }
    const next = { ...activeSearch, category: code ? { code, name } : undefined };
    if (!next.destination && !next.keyword && !next.category) onHome();
    else onSearch(next);
  }

  const hotActivities = featuredProducts;
  const currentCategoryCounts = categoryAvailability.context === categoryContext ? categoryAvailability.counts : {};
  const visibleCategories = submitted ? categories.filter(category => currentCategoryCounts[category.category_code] > 0) : categories;
  const categoryCountsLoading = submitted && (categoryAvailability.context !== categoryContext || categoryAvailability.loading);
  const categoryCountsFailed = submitted && categoryAvailability.context === categoryContext && categoryAvailability.failed;

  return <div className={`catalog ${submitted ? '' : 'catalog-home'}`}>
    {submitted ? <header className="cat-list-header">
      <button className="cat-icon-button" aria-label="返回首页" onClick={onHome}><span className="cat-back-icon"><CatalogIcon name="chevron"/></span></button>
      <h1>活动列表</h1><span className="cat-list-header-spacer"/>
    </header> : <header className="cat-header"><div className="cat-header-inner"><button className="cat-brand" onClick={onHome} aria-label="RollingGo 首页"><span><img className="cat-brand-logo" src="/design/rollinggo-logo.svg" alt="RollingGo" width="134" height="30"/><small>您的下一次旅程，从这里开始</small></span></button><nav className="cat-desktop-nav" aria-label="主导航"><button onClick={() => setToast('酒店预订请前往 RollingGo 主站')}>酒店</button><button onClick={() => setToast('机票预订请前往 RollingGo 主站')}>机票</button><button className="active" onClick={onHome}>活动体验</button></nav><div className="cat-header-actions"><span className="cat-currency"><CatalogIcon name="globe" size={16}/> 简体中文</span></div></div></header>}


    <main className={`cat-main ${submitted ? 'cat-list-main' : ''}`}>
      {!submitted && <section className="cat-hero">
        <div className="cat-search-panel">
          <div className="cat-service-tabs" role="tablist" aria-label="旅行服务"><button role="tab" aria-selected={false} onClick={() => setToast('酒店预订请前往 RollingGo 主站')}>酒店</button><button role="tab" aria-selected={false} onClick={() => setToast('机票预订请前往 RollingGo 主站')}>机票</button><button role="tab" aria-selected={true} className="active"><svg className="cat-service-active-surface" viewBox="139 8 204 40" preserveAspectRatio="none" aria-hidden="true"><path d="M343 16C343 11.5817 339.418 8 335 8H178.416C173.871 8 169.716 10.568 167.683 14.6334L156.367 37.2669C153.078 43.8448 146.354 48 139 48H343V16Z" fill="white"/></svg><span>活动</span></button></div>
          <div className="cat-search-fields"><button className="cat-search-field cat-destination-field" aria-label="搜索目的地/活动" onClick={onOpenSearch}><CatalogIcon name="search"/><span><strong className="is-placeholder">搜索目的地/活动</strong></span></button><button className="cat-primary-button cat-search-button" onClick={onOpenSearch}>查询</button></div>
        </div>
      </section>}

      {!submitted && <section className="cat-hot-activities" aria-labelledby="cat-hot-activities-title">
        <h2 id="cat-hot-activities-title">热门活动</h2>
        <div className="cat-hot-rail" aria-label="热门活动列表">
          {hotActivities.map(product => <button key={product.product_code} className="cat-hot-card" data-product-code={product.product_code} aria-label={`查看热门活动：${product.title}`} onClick={() => onOpenProduct(product.product_code)}>
            <ProductImage product={product} className="cat-hot-image" />
            <svg className="cat-hot-curve" viewBox="0 42 260 120" preserveAspectRatio="none" aria-hidden="true"><path d="M61.1757 184.248C148.556 165.715 182.154 98.0807 188.598 49.7449C190.981 31.8754 181.933 14.8671 167.339 4.28471C64.9665 -69.9439 -10.3934 -16.8437 -30.5818 21.8079C-44.2706 85.3455 -45.0833 206.786 61.1757 184.248Z" fill="#00149e"/><path d="M59.1757 184.248C146.537 165.719 173.38 98.1101 177.43 49.7764C178.936 31.8118 169.922 14.8803 155.38 4.22507C54.1972 -69.9155 -12.3988 -16.8334 -32.5818 21.8079C-46.2706 85.3455 -47.0833 206.786 59.1757 184.248Z" fill="#000947"/></svg>
            <span className="cat-hot-copy"><img src="/design/rollinggo-logo.svg" alt="" width="80" height="18"/><strong>{product.title}</strong><span className="cat-hot-cta">立即查看<CatalogIcon name="chevron" size={13}/></span></span>
          </button>)}
          {!hotActivities.length && featuredLoading && Array.from({ length: 3 }, (_, index) => <div key={index} className="cat-hot-skeleton" aria-hidden="true" />)}
        </div>
        {!featuredLoading && featuredError && <button className="cat-hot-retry cat-text-button" onClick={() => setRetry(value => value + 1)}>重新加载热门活动</button>}
        {!featuredLoading && !featuredError && !hotActivities.length && <p className="cat-hot-status">暂无适合展示的热门活动</p>}
      </section>}

      <section className={`cat-results-section ${submitted ? '' : 'cat-home-recommendations'}`} id="cat-results">
        {!submitted && <div className="cat-section-title"><h2>热门推荐</h2></div>}
        {(submitted || categories.length > 0) && <div className="cat-category-row" aria-label="活动类别" aria-busy={categoryCountsLoading}><button aria-pressed={!selectedCategory} className={!selectedCategory ? 'selected' : ''} onClick={() => chooseCategory('')}>全部体验</button>{visibleCategories.map(category => <button key={category.category_code} data-category-code={category.category_code} aria-pressed={selectedCategory === category.category_code} className={selectedCategory === category.category_code ? 'selected' : ''} onClick={() => chooseCategory(category.category_code, category.category_name)}>{categoryNameZh(category.category_name)}</button>)}{categoryCountsLoading && Array.from({ length: 3 }, (_, index) => <span key={index} className="cat-category-skeleton" aria-hidden="true" />)}</div>}
        {categoryCountsFailed && <p className="cat-category-status" role="status">活动分类暂时无法加载。<button onClick={() => categoriesFailed ? setRetry(value => value + 1) : setCategoryRetry(value => value + 1)}>重试</button></p>}
        {loading ? <div className="cat-product-grid" aria-label="正在加载活动">{Array.from({ length: 6 }, (_, index) => <div className="cat-skeleton-card" key={index}><div className="cat-skeleton-photo"/><div className="cat-skeleton-line"/><div className="cat-skeleton-line short"/>{submitted && <div className="cat-skeleton-line price"/>}</div>)}</div> : error ? <div className="cat-empty-state"><div className="cat-empty-icon"><CatalogIcon name="globe" size={32}/></div><h3>精彩体验正在路上</h3><p>暂时无法加载活动，请稍后重试。</p><button className="cat-secondary-button" onClick={() => setRetry(value => value + 1)}>重新加载</button></div> : products.length === 0 ? <div className="cat-empty-state"><div className="cat-empty-icon"><CatalogIcon name="search" size={32}/></div><h3>暂时没有找到相关活动</h3><p>试试其他目的地或活动类别，探索更多精彩。</p><button className="cat-secondary-button" onClick={() => { setSelectedCategory(''); const next = { ...activeSearch, keyword: '', category: undefined }; onSearchChange(next); if (submitted) { if (next.destination) onSearch(next); else onHome(); } }}>查看全部体验</button></div> : <div className="cat-product-grid">{products.map(product => <article className="cat-product-card" key={product.product_code}><div className="cat-product-photo"><button className="cat-photo-link" onClick={() => onOpenProduct(product.product_code)} aria-label={`查看 ${product.title}`}><ProductImage product={product}/></button>{submitted && product.category_name && <span className="cat-product-category">{categoryNameZh(product.category_name)}</span>}</div><button className="cat-product-info" onClick={() => onOpenProduct(product.product_code)}>{submitted && (product.city_name || product.country_name) && <span className="cat-product-location"><CatalogIcon name="pin" size={13}/>{locationLabelZh(product.city_name, product.country_name)}</span>}<h3>{product.title}</h3>{(product.subtitle || (!submitted && (product.city_name || product.country_name))) && <p className="cat-product-subtitle">{product.subtitle || locationLabelZh(product.city_name, product.country_name)}</p>}{submitted && <div className="cat-product-bottom"><div><ProductStartingPrice price={startingPrices[product.product_code]}/></div><span className="cat-product-arrow"><CatalogIcon name="arrow" size={19}/></span></div>}</button></article>)}</div>}
        {submitted && !loading && Object.values(startingPrices).some(price => price.status === 'error') && <button className="cat-text-button cat-price-retry" onClick={() => setPriceRetry(value => value + 1)}>重新加载报价</button>}
        {submitted && loadingMore && <div className="cat-product-grid cat-more-skeletons" aria-label="正在加载活动">{Array.from({ length: 2 }, (_, index) => <div className="cat-skeleton-card" key={index}><div className="cat-skeleton-photo"/><div className="cat-skeleton-line"/><div className="cat-skeleton-line short"/><div className="cat-skeleton-line price"/></div>)}</div>}
        {submitted && !loading && !error && hasNext && !loadMoreFailed && <div className="cat-infinite-sentinel" ref={loadMoreSentinel} aria-hidden="true" />}
        {submitted && loadMoreFailed && <div className="cat-pagination-retry"><button className="cat-secondary-button" onClick={() => void loadMore(true)}>重新加载活动</button></div>}
      </section>

    </main>



    {toast && <div className="cat-toast" role="status">{toast}</div>}
  </div>;
}
