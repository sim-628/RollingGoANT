import { categoryNameZh, countryNameZh, placeNameZh } from './localization';

export type SearchCity = { city_code: string; city_name: string; country_name?: string };
export type SearchCategory = { category_code: string; category_name: string; sub_categories?: { sub_category_code: string; sub_category_name: string }[] };
export type SuggestionProduct = { category_code?: string; category_name?: string };
export type SearchProductPage = { total: number; products: SuggestionProduct[] };
export type CategoryChoice = { code: string; name: string };

export function normalizedSearch(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase();
}

export function matchingCities(cities: SearchCity[], query: string): SearchCity[] {
  const needle = normalizedSearch(query);
  if (!needle) return [];
  return cities.map((city, index) => {
    const names = [city.city_name, placeNameZh(city.city_name)].map(normalizedSearch);
    const countries = [city.country_name || '', countryNameZh(city.country_name)].map(normalizedSearch);
    const rank = names.some(name => name === needle) ? 0
      : names.some(name => name.startsWith(needle)) ? 1
      : names.some(name => name.includes(needle)) ? 2
      : countries.some(name => name.includes(needle)) ? 3 : 4;
    return { city, rank, index };
  }).filter(item => item.rank < 4).sort((a, b) => a.rank - b.rank || a.index - b.index).map(item => item.city);
}

export function popularCities(cities: SearchCity[]) {
  const names = ['东京', '大阪', '曼谷', '新加坡', '香港', '首尔', '上海', '北京', '杭州', '巴黎', '伦敦', '悉尼'];
  return names.flatMap(name => {
    const city = cities.find(item => placeNameZh(item.city_name) === name);
    return city ? [city] : [];
  });
}

export function exactCity(cities: SearchCity[], query: string) {
  const needle = normalizedSearch(query);
  if (!needle) return undefined;
  return cities.find(city => [city.city_name, placeNameZh(city.city_name)].some(name => normalizedSearch(name) === needle));
}

/** Candidate types come from actual products; each count is fetched separately. */
export function categoryChoices(products: SuggestionProduct[], categories: SearchCategory[]): CategoryChoice[] {
  const allowed = new Map<string, string>();
  for (const category of categories) {
    allowed.set(String(category.category_code), category.category_name);
    for (const sub of category.sub_categories || []) allowed.set(String(sub.sub_category_code), sub.sub_category_name);
  }
  const choices = new Map<string, CategoryChoice>();
  for (const product of products) {
    const code = String(product.category_code || '');
    const name = allowed.get(code);
    if (!name || /abandoned/i.test(name) || categoryNameZh(name) === '其他体验') continue;
    choices.set(code, { code, name });
    if (choices.size === 3) break;
  }
  return [...choices.values()];
}

export function validActivityCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
