import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Compass, FileCheck2, MapPin, ShieldCheck } from 'lucide-react';
import Catalog from './Catalog';
import ProductDetail from './ProductDetail';
import Booking from './Booking';
import type { BookingSelection, SearchState } from './types';
import { formatMoney } from './api';

export interface OrderResult {
  mode?: 'validated';
  draft_id?: string;
  quote?: { total_amount?: string; currency?: string };
  total_amount?: string;
  currency?: string;
  [key: string]: unknown;
}
function route() { return window.location.hash.slice(1) || '/'; }
function go(path: string) { window.location.hash = path; window.scrollTo({ top: 0, behavior: 'instant' }); }

export default function App() {
  const [path, setPath] = useState(route);
  const [search, setSearch] = useState<SearchState>({ destination: null, startDate: '', endDate: '', adults: null, keyword: '' });
  const [booking, setBooking] = useState<BookingSelection | null>(null);
  const [order, setOrder] = useState<OrderResult | null>(null);
  useEffect(() => {
    const changed = () => { setPath(route()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  const productCode = path.startsWith('/product/') ? decodeURIComponent(path.slice(9)) : '';
  return <div className="site-stage"><div className="mobile-app">
    {productCode ? <ProductDetail productCode={productCode} search={search} onBack={() => go('/')} onBook={selection => { setBooking(selection); setOrder(null); go('/booking'); }} />
      : path === '/booking' && booking ? <Booking selection={booking} onBack={() => go(`/product/${encodeURIComponent(booking.product.product_code)}`)} onComplete={result => { setOrder(result); go('/cashier'); }} />
      : (path === '/cashier' || path === '/confirmation') && order && booking ? <Confirmation booking={booking} order={order} onHome={() => go('/')} />
      : <Catalog search={search} onSearchChange={setSearch} onOpenProduct={code => go(`/product/${encodeURIComponent(code)}`)} />}
    <div className="desktop-signature" aria-hidden="true"><span>RollingGo <b>ANT</b></span><span>让每一天，都值得出发。</span></div>
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
