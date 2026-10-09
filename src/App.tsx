import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, Compass, FileCheck2, MapPin, ShieldCheck } from 'lucide-react';
import Catalog from './Catalog';
import SearchPage from './SearchPage';
import ProductDetail from './ProductDetail';
import Booking from './Booking';
import BottomBar from './BottomBar';
import type { BookingSelection, SearchState } from './types';
import { formatMoney } from './api';
import { parseCatalogRoute, parseSearchRoute, productCodeFromPath, resultsPath, searchPath } from './catalogRoute';

export interface OrderResult {
  mode?: 'validated';
  draft_id?: string;
  quote?: { total_amount?: string; currency?: string };
  total_amount?: string;
  currency?: string;
  [key: string]: unknown;
}
function route() { return window.location.hash.slice(1) || '/'; }
function go(path: string, catalogReturnTo?: string) {
  window.location.hash = path;
  window.history.replaceState(catalogReturnTo ? { catalogReturnTo } : null, '');
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function productOriginFromHistory() {
  const returnTo: unknown = window.history.state?.catalogReturnTo;
  const catalogRoute = parseCatalogRoute(typeof returnTo === 'string' ? returnTo : '/');
  return { path: catalogRoute.mode === 'results' ? String(returnTo) : '/', search: catalogRoute.search };
}
const emptySearch: SearchState = { destination: null, keyword: '' };

export default function App() {
  const [path, setPath] = useState(route);
  const [search, setSearch] = useState<SearchState>(() => parseSearchRoute(route())?.search || parseCatalogRoute(route()).search || emptySearch);
  const [productOrigin, setProductOrigin] = useState(productOriginFromHistory);
  const [booking, setBooking] = useState<BookingSelection | null>(null);
  const [order, setOrder] = useState<OrderResult | null>(null);
  useEffect(() => {
    const changed = () => {
      const nextPath = route();
      const nextCatalogRoute = parseCatalogRoute(nextPath);
      setPath(nextPath);
      if (nextCatalogRoute.mode === 'results') setSearch(nextCatalogRoute.search);
      const nextSearchRoute = parseSearchRoute(nextPath);
      if (nextSearchRoute) setSearch(nextSearchRoute.search);
      if (productCodeFromPath(nextPath)) setProductOrigin(productOriginFromHistory());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  const catalogRoute = useMemo(() => parseCatalogRoute(path), [path]);
  const searchRoute = useMemo(() => parseSearchRoute(path), [path]);
  const productCode = productCodeFromPath(path);
  const showBottomBar = path === '/' || catalogRoute.mode === 'results';
  const activeSearch = catalogRoute.mode === 'results' ? catalogRoute.search : emptySearch;
  const submitSearch = (next: SearchState) => {
    const nextPath = resultsPath(next);
    if (!nextPath) return;
    setSearch(next);
    go(nextPath);
  };
  const openProduct = (code: string) => {
    const origin = catalogRoute.mode === 'results' ? path : '/';
    go(`/product/${encodeURIComponent(code)}`, origin);
  };
  const openSearch = () => go(searchPath(catalogRoute.mode === 'results' ? activeSearch : search, catalogRoute.mode === 'results' ? path : '/'));
  return <div className="site-stage"><div className={`mobile-app${showBottomBar ? ' with-bottom-bar' : ''}`}>
    {searchRoute ? <SearchPage key={path} initialSearch={searchRoute.search} onSearch={submitSearch} onClose={() => go(searchRoute.returnTo)} />
      : productCode ? <ProductDetail productCode={productCode} search={productOrigin.search || search} onBack={() => go(productOrigin.path)} onBook={selection => { setBooking(selection); setOrder(null); go('/booking', productOrigin.path); }} />
      : path === '/booking' && booking ? <Booking selection={booking} onBack={() => go(`/product/${encodeURIComponent(booking.product.product_code)}`, productOrigin.path)} onComplete={(result, finalSelection) => { setBooking(finalSelection); setOrder(result); go('/cashier'); }} />
      : (path === '/cashier' || path === '/confirmation') && order && booking ? <Confirmation booking={booking} order={order} onHome={() => go('/')} />
      : <Catalog key={path} mode={catalogRoute.mode} search={search} activeSearch={activeSearch} onSearchChange={setSearch} onSearch={submitSearch} onOpenSearch={openSearch} onHome={() => go('/')} onOpenProduct={openProduct} />}
    {showBottomBar && <BottomBar />}
  </div></div>;
}

function Confirmation({ booking, order, onHome }: { booking: BookingSelection; order: OrderResult; onHome: () => void }) {
  const price = order.quote?.total_amount || order.total_amount || booking.total;
  const currency = order.quote?.currency || order.currency || booking.currency;
  return <main className="confirmation-page">
    <header className="simple-topbar"><button aria-label="返回活动首页" className="icon-button" onClick={onHome}><ArrowLeft size={22} /></button><span>收银台</span><span className="ant-badge">DEMO</span></header>
    <div className="success-circle"><Check size={36} strokeWidth={3} /></div>
    <h1>预订信息已确认</h1>
    <p className="confirmation-note">已到达演示收银台，可订状态与当前报价已确认。</p>
    <section className="surface-card receipt-card"><div className="receipt-heading"><FileCheck2 size={21} /><b>你的日游安排</b></div>
      <h2>{booking.product.title}</h2><p>{booking.package.package_name}</p>
      <div className="receipt-row"><span>出行日期</span><strong>{booking.date}</strong></div>
      <div className="receipt-row"><span>预订规格</span><strong>{booking.skus.filter(s => s.count > 0).map(s => `${s.title} × ${s.count}`).join('、')}</strong></div>
      <div className="receipt-row"><span>预订草稿</span><strong>{order.draft_id || '—'}</strong></div>
      <div className="receipt-total"><span>预订总额</span><strong>{formatMoney(price, currency)}</strong></div>
    </section>
    <section className="handoff-note"><ShieldCheck size={21} /><div><b>本次演示到此结束</b><p>尚未生成正式订单或收取费用。支付及后续功能沿用 RollingGo 现有流程。</p></div></section>
    <button className="primary-button full-width" onClick={onHome}><Compass size={18} />继续探索目的地</button>
    <p className="receipt-location"><MapPin size={14} />{searchLocation(booking)}</p>
  </main>;
}
function searchLocation(booking: BookingSelection) { return booking.product.address || 'RollingGo · 当地体验'; }
