import './bottom-bar.css';

const rollingBadge = new URL('./assets/bottom-rolling.png', import.meta.url).href;

function HomeIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M10.2366 1.2812C11.2881.5172 12.7119.5172 13.7634 1.2812L21.6493 7.0106C22.7008 7.7746 23.1408 9.1287 22.7391 10.3647L19.727 19.6353C19.3253 20.8713 18.1735 21.7082 16.8738 21.7082H7.1262C5.8265 21.7082 4.6747 20.8713 4.273 19.6353L1.2609 10.3647C.8592 9.1287 1.2992 7.7746 2.3507 7.0106L10.2366 1.2812Z" stroke="currentColor" strokeWidth="2"/><path d="M8 13C8.513 13.6667 10.0315 15 12.0015 15C13.9714 15 15.488 13.6667 16 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
}

function MineIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2 12C2 6.4772 6.4772 2 12 2H22V12C22 17.5228 17.5228 22 12 22C6.4772 22 2 17.5228 2 12Z" stroke="currentColor" strokeWidth="2"/><path d="M8 15C8.513 15.6667 10.032 17 12.001 17C13.971 17 15.488 15.6667 16 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
}

export default function BottomBar() {
  return <nav className="ant-bottom-bar" aria-label="主导航">
      <svg className="ant-bottom-bar-surface" viewBox="0 0 375 72" preserveAspectRatio="none" fill="none" aria-hidden="true"><path d="M187 6C194.421 6 201.116 9.10982 205.853 14.0972C208.933 17.3401 212.874 20 217.347 20H375V72H0V20H156.653C161.126 20 165.067 17.3401 168.147 14.0972C172.884 9.10982 179.579 6 187 6Z" fill="white"/></svg>
      <a className="ant-bottom-bar-item" href="https://rollinggo.cn/pages/reservationLink/index"><HomeIcon/><span>首页</span></a>
      <a className="ant-bottom-bar-item ant-bottom-bar-rolling" href="https://rollinggo.cn/pages/chat/index"><img src={rollingBadge} alt="" width="44" height="44"/><span>Rolling</span></a>
      <a className="ant-bottom-bar-item" href="https://rollinggo.cn/pages/user-center/index"><MineIcon/><span>我的</span></a>
    </nav>;
}
