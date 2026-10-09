import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Flame, MapPin, Search, Sparkles, Ticket, Trash2, X } from 'lucide-react';
import { apiGet } from './api';
import { categoryNameZh, countryNameZh, placeNameZh } from './localization';
import { categoryChoices, exactCity, matchingCities, popularCities, validActivityCount } from './searchSuggestions';
import type { CategoryChoice, SearchCategory, SearchCity, SearchProductPage } from './searchSuggestions';
import type { SearchState } from './types';
import './search.css';

type Props = { initialSearch: SearchState; onSearch: (next: SearchState) => void; onClose: () => void };
type CitySuggestions = { cityCode: string; categories: (CategoryChoice & { count: number })[]; failed: boolean };
const recentKey = 'rollinggo.ant.search.recent.v1';
const cityPhotos: Record<string, string> = {
  '巴黎': new URL('./assets/location-paris.png', import.meta.url).href,
  '曼谷': new URL('./assets/location-bangkok.png', import.meta.url).href,
  '巴厘岛': new URL('./assets/location-bali.png', import.meta.url).href,
  '悉尼': new URL('./assets/location-sydney.png', import.meta.url).href,
};
function domesticCity(city: Pick<SearchCity, 'country_name'>) {
  return /china|hong.?kong|maca[ou]|taiwan|中国|香港|澳门|台湾/i.test(city.country_name || '');
}

function recentCodes(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(recentKey) || '[]');
    return Array.isArray(value) ? [...new Set(value.filter((code): code is string => typeof code === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(code)))].slice(0, 6) : [];
  } catch { return []; }
}

export default function SearchPage({ initialSearch, onSearch, onClose }: Props) {
  const [query, setQuery] = useState(initialSearch.keyword || '');
  const [cities, setCities] = useState<SearchCity[]>([]);
  const [categories, setCategories] = useState<SearchCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [categoryFailed, setCategoryFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [recent, setRecent] = useState(recentCodes);
  const [suggestions, setSuggestions] = useState<CitySuggestions[]>([]);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [region, setRegion] = useState<'domestic' | 'international'>(initialSearch.destination && domesticCity({ country_name: initialSearch.destination.countryName }) ? 'domestic' : 'international');
  const heading = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const cache = useRef(new Map<string, { expires: number; value: CitySuggestions }>());
  const trimmed = query.trim();
  const matches = useMemo(() => matchingCities(cities, trimmed).slice(0, 8), [cities, trimmed]);
  const matchCodes = matches.slice(0, 2).map(city => String(city.city_code)).join(',');
  const hot = useMemo(() => popularCities(cities), [cities]);
  const recentCities = recent.flatMap(code => { const city = cities.find(item => String(item.city_code) === code); return city ? [city] : []; });
  const regionCities = useMemo(() => cities.filter(city => domesticCity(city) === (region === 'domestic')), [cities, region]);
  const featuredCities = useMemo(() => Object.keys(cityPhotos).flatMap(name => {
    const city = regionCities.find(item => placeNameZh(item.city_name) === name);
    return city ? [city] : [];
  }), [regionCities]);
  const cityChips = useMemo(() => {
    const seen = new Set(featuredCities.map(city => String(city.city_code)));
    const result: SearchCity[] = [];
    for (const city of [...hot.filter(city => regionCities.includes(city)), ...regionCities]) {
      const code = String(city.city_code);
      if (seen.has(code)) continue;
      seen.add(code); result.push(city);
      if (result.length === 12) break;
    }
    return result;
  }, [hot, regionCities, featuredCities]);

  useEffect(() => {
    heading.current?.focus();
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); onClose(); } };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setFailed(false); setCategoryFailed(false);
    apiGet<SearchCity[]>('/api/catalog/cities', {}, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setCities(Array.isArray(data) ? data : []); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    apiGet<SearchCategory[]>('/api/catalog/categories', {}, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setCategories(Array.isArray(data) ? data : []); })
      .catch(() => { if (!controller.signal.aborted) setCategoryFailed(true); });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    const controller = new AbortController();
    setSuggestions([]);
    if (!trimmed || !matchCodes || !categories.length) { setSuggestionLoading(false); return () => controller.abort(); }
    setSuggestionLoading(true);
    const timer = setTimeout(async () => {
      const results = await Promise.all(matchCodes.split(',').map(async cityCode => {
        const cached = cache.current.get(cityCode);
        if (cached && cached.expires > Date.now()) return cached.value;
        let group: CitySuggestions = { cityCode, categories: [], failed: false };
        try {
          const page = await apiGet<SearchProductPage>('/api/catalog/products', { city_codes: cityCode, page: 1, limit: 12 }, { signal: controller.signal });
          const choices = categoryChoices(page.products || [], categories);
          const counts = await Promise.all(choices.map(async choice => {
            const result = await apiGet<SearchProductPage>('/api/catalog/products', { city_codes: cityCode, category_codes: choice.code, page: 1, limit: 1 }, { signal: controller.signal });
            const count = validActivityCount(result.total);
            if (count === null) throw new Error('Invalid activity count');
            return { ...choice, count };
          }));
          group = { cityCode, categories: counts.filter(item => item.count > 0), failed: false };
          if (!controller.signal.aborted) {
            if (cache.current.size >= 30) cache.current.delete(cache.current.keys().next().value!);
            cache.current.set(cityCode, { value: group, expires: Date.now() + 30_000 });
          }
        } catch { group.failed = true; }
        return group;
      }));
      if (!controller.signal.aborted) { setSuggestions(results); setSuggestionLoading(false); }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [trimmed, matchCodes, categories, retry]);

  function choose(city: SearchCity, category?: CategoryChoice) {
    const code = String(city.city_code);
    const nextRecent = [code, ...recent.filter(item => item !== code)].slice(0, 6);
    try { localStorage.setItem(recentKey, JSON.stringify(nextRecent)); } catch { /* Search works when browser storage is unavailable. */ }
    setRecent(nextRecent);
    onSearch({ destination: { code, name: city.city_name, countryName: city.country_name }, keyword: '', ...(category ? { category } : {}) });
  }
  function searchKeyword() {
    if (trimmed) onSearch({ destination: null, keyword: trimmed });
  }
  function submit() {
    if (!trimmed || composing.current) return;
    const city = exactCity(cities, trimmed);
    if (city) choose(city);
    else searchKeyword();
  }

  return <div className="ant-search-page">
    <header className="ant-search-header"><button className="ant-search-close" aria-label="关闭地点选择" onClick={onClose}><ArrowLeft size={24} /></button><h1 ref={heading} tabIndex={-1}>选择目的地</h1></header>
    <div className="ant-search-bar-row">
      <form className="ant-search-form" role="search" onSubmit={event => { event.preventDefault(); submit(); }}>
        <button type="submit" className="ant-search-submit" aria-label="提交搜索" disabled={!trimmed}><Search size={19} /></button>
        <input ref={input} aria-label="搜索目的地/活动" placeholder="搜索城市/国家/地区" autoComplete="off" maxLength={128} value={query} onChange={event => setQuery(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); } }} />
        {query && <button type="button" className="ant-search-clear" aria-label="清除搜索" onClick={() => { setQuery(''); input.current?.focus(); }}><X size={14} /></button>}
      </form>
    </div>
    <main className="ant-search-main">
      {!trimmed ? <>
        <div className="ant-search-summary">
        {initialSearch.destination && <section className="ant-search-chip-section ant-search-current-section"><h2>当前选择</h2><button className="ant-search-current" onClick={() => onSearch({ destination: initialSearch.destination, keyword: '' })}><MapPin size={17} fill="currentColor" />{placeNameZh(initialSearch.destination.name)}</button></section>}
        <section className="ant-search-chip-section ant-search-history"><div className="ant-search-section-heading"><h2>历史选择</h2><button aria-label="清空历史选择" disabled={!recent.length} onClick={() => { setRecent([]); try { localStorage.removeItem(recentKey); } catch { /* Optional local history. */ } }}><Trash2 size={18}/></button></div>{recentCities.length ? <div className="ant-search-chips">{recentCities.map(city => <button key={city.city_code} data-city-code={city.city_code} onClick={() => choose(city)}>{placeNameZh(city.city_name)}</button>)}</div> : <p className="ant-search-hint">暂无历史选择</p>}</section>
        </div>
        <div className="ant-search-region-tabs" role="tablist" aria-label="目的地区域"><button role="tab" aria-selected={region === 'domestic'} onClick={() => setRegion('domestic')}>国内·港澳台</button><button role="tab" aria-selected={region === 'international'} onClick={() => setRegion('international')}>国际</button></div>
        <section className="ant-search-hot-cities"><h2><Flame size={20} fill="currentColor" aria-hidden="true"/>热门城市</h2>
          {featuredCities.length > 0 && <div className="ant-search-city-cards">{featuredCities.map(city => <button key={city.city_code} data-city-code={city.city_code} onClick={() => choose(city)}><img src={cityPhotos[placeNameZh(city.city_name)]} alt=""/><span>{placeNameZh(city.city_name)}</span></button>)}</div>}
          <div className="ant-search-chips ant-search-city-grid">{cityChips.map(city => <button key={city.city_code} data-city-code={city.city_code} onClick={() => choose(city)}>{placeNameZh(city.city_name)}</button>)}</div>
          {!loading && !failed && !regionCities.length && <p className="ant-search-hint">该地区暂无可选目的地，可搜索其他城市或活动。</p>}
        </section>
      </> : <div className="ant-search-results">
        {matches.map(city => <div key={city.city_code} className="ant-search-city-group">
          <button className="ant-search-suggestion ant-search-city" data-city-code={city.city_code} onClick={() => choose(city)}><MapPin className="ant-search-place-icon" size={23}/><span><strong>{placeNameZh(city.city_name)}</strong><small>{countryNameZh(city.country_name)}</small></span><ArrowUpRight size={16} className="ant-search-row-arrow" /></button>
          {suggestions.find(group => group.cityCode === String(city.city_code))?.categories.map(category => <button className="ant-search-suggestion ant-search-category" key={category.code} data-category-code={category.code} onClick={() => choose(city, category)}><Ticket className="ant-search-type-icon" size={22}/><span><strong>{placeNameZh(city.city_name)}<span className="ant-search-category-name"> · {categoryNameZh(category.name)}</span></strong><small>{category.count}个活动</small></span></button>)}
        </div>)}
        <button className="ant-search-suggestion ant-search-keyword" onClick={searchKeyword}><Search size={22}/><span><strong>搜索“{trimmed}”</strong><small>查看相关活动</small></span><ArrowUpRight size={16} className="ant-search-row-arrow" /></button>
        {!loading && !failed && matches.length === 0 && <p className="ant-search-hint">没有匹配的目的地，可搜索相关活动或换个城市名称。</p>}
        {suggestionLoading && <p className="ant-search-status" role="status"><Sparkles size={15}/>正在查找当地体验…</p>}
        {(suggestions.some(group => group.failed) || categoryFailed && matches.length > 0) && <p className="ant-search-status">活动分类暂时无法加载。<button onClick={() => setRetry(value => value + 1)}>重试</button></p>}
      </div>}
      {loading && <p className="ant-search-status ant-search-page-status" role="status">正在加载目的地…</p>}
      {failed && <div className="ant-search-error ant-search-page-status" role="alert"><p>目的地暂时无法加载，请稍后重试。</p><button onClick={() => setRetry(value => value + 1)}>重新加载</button></div>}
    </main>
  </div>;
}
