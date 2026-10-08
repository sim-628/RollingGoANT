import type { SearchState } from './types';

export type CatalogRoute =
  | { mode: 'home'; search: null }
  | { mode: 'results'; search: SearchState };

function validCityCode(value: string) {
  return /^[a-zA-Z0-9._-]{1,128}$/.test(value);
}

/** Keep committed search criteria in the URL so reload and browser history work. */
export function resultsPath(search: SearchState): string | null {
  const destination = search.destination;
  const city = destination?.code.trim() || '';
  if (!destination || !validCityCode(city)) return null;
  const params = new URLSearchParams({ city, name: destination.name.trim() || city });
  if (destination.countryName?.trim()) params.set('country', destination.countryName.trim());
  if (search.keyword.trim()) params.set('q', search.keyword.trim());
  return `/activities?${params}`;
}

export function parseCatalogRoute(path: string): CatalogRoute {
  const queryStart = path.indexOf('?');
  const pathname = queryStart < 0 ? path : path.slice(0, queryStart);
  const query = queryStart < 0 ? '' : path.slice(queryStart + 1);
  if (pathname !== '/activities') return { mode: 'home', search: null };
  try {
    // URLSearchParams tolerates broken escapes; reject those instead of displaying them.
    decodeURIComponent(query);
    const params = new URLSearchParams(query);
    const city = params.get('city')?.trim() || '';
    if (!validCityCode(city) || params.getAll('city').length !== 1) return { mode: 'home', search: null };
    const countryName = params.get('country')?.trim();
    return {
      mode: 'results',
      search: {
        destination: { code: city, name: params.get('name')?.trim() || city, ...(countryName ? { countryName } : {}) },
        keyword: params.get('q')?.trim() || '',
      },
    };
  } catch { return { mode: 'home', search: null }; }
}

export function productCodeFromPath(path: string): string {
  if (!path.startsWith('/product/')) return '';
  try { return decodeURIComponent(path.slice(9).split('?')[0]); }
  catch { return ''; }
}
