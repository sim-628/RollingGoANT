import type { SearchState } from './types';

export type CatalogRoute =
  | { mode: 'home'; search: null }
  | { mode: 'results'; search: SearchState };

export type SearchRoute = { search: SearchState; returnTo: string };

function validCode(value: string) {
  return /^[a-zA-Z0-9._-]{1,128}$/.test(value);
}

function searchParameters(search: SearchState): URLSearchParams | null {
  const params = new URLSearchParams();
  const destination = search.destination;
  if (destination) {
    const city = destination.code.trim();
    if (!validCode(city)) return null;
    params.set('city', city);
    params.set('name', destination.name.trim() || city);
    if (destination.countryName?.trim()) params.set('country', destination.countryName.trim());
  }
  if (search.keyword.trim()) params.set('q', search.keyword.trim());
  if (search.category) {
    const category = search.category.code.trim();
    if (!validCode(category)) return null;
    params.set('category', category);
    params.set('categoryName', search.category.name.trim() || category);
  }
  return params;
}

function routeParameters(path: string, expectedPath: string): URLSearchParams | null {
  const queryStart = path.indexOf('?');
  const pathname = queryStart < 0 ? path : path.slice(0, queryStart);
  const query = queryStart < 0 ? '' : path.slice(queryStart + 1);
  if (pathname !== expectedPath) return null;
  try {
    // URLSearchParams tolerates broken escapes; reject those instead of displaying them.
    decodeURIComponent(query);
    return new URLSearchParams(query);
  } catch { return null; }
}

function searchFromParameters(params: URLSearchParams): SearchState | null {
  let destination: SearchState['destination'] = null;
  if (params.has('city')) {
    const city = params.get('city')?.trim() || '';
    if (!validCode(city) || params.getAll('city').length !== 1) return null;
    const countryName = params.get('country')?.trim();
    destination = { code: city, name: params.get('name')?.trim() || city, ...(countryName ? { countryName } : {}) };
  }
  let category: SearchState['category'];
  if (params.has('category')) {
    const code = params.get('category')?.trim() || '';
    if (!validCode(code) || params.getAll('category').length !== 1) return null;
    category = { code, name: params.get('categoryName')?.trim() || code };
  }
  return { destination, keyword: params.get('q')?.trim() || '', ...(category ? { category } : {}) };
}

/** Keep committed search criteria in the URL so reload and browser history work. */
export function resultsPath(search: SearchState): string | null {
  const params = searchParameters(search);
  if (!params || !params.has('city') && !params.has('category') && !params.has('q')) return null;
  return `/activities?${params}`;
}

export function parseCatalogRoute(path: string): CatalogRoute {
  const params = routeParameters(path, '/activities');
  const search = params && searchFromParameters(params);
  if (!search || !search.destination && !search.category && !search.keyword) return { mode: 'home', search: null };
  return { mode: 'results', search };
}

function safeReturnPath(returnTo: string): string {
  return parseCatalogRoute(returnTo).mode === 'results' ? returnTo : '/';
}

/** The search page stores both its draft and its exact originating list URL. */
export function searchPath(search: SearchState, returnTo: string): string {
  const params = searchParameters(search) || new URLSearchParams();
  params.set('returnTo', safeReturnPath(returnTo));
  return `/search?${params}`;
}

export function parseSearchRoute(path: string): SearchRoute | null {
  const params = routeParameters(path, '/search');
  if (!params) return null;
  const search = searchFromParameters(params);
  if (!search) return null;
  return { search, returnTo: safeReturnPath(params.get('returnTo') || '/') };
}

export function productCodeFromPath(path: string): string {
  if (!path.startsWith('/product/')) return '';
  try { return decodeURIComponent(path.slice(9).split('?')[0]); }
  catch { return ''; }
}
