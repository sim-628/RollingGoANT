import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalogRoute, parseSearchRoute, productCodeFromPath, resultsPath, searchPath } from '../src/catalogRoute.ts';

test('a destination search can be reconstructed from its URL after reload', () => {
  const search = { destination: { code: '215', name: '南库塔', countryName: '印度尼西亚' }, keyword: '游船 & 海滩 + 体验' };
  const path = resultsPath(search);
  assert.ok(path.startsWith('/activities?city=215&'));
  assert.deepEqual(parseCatalogRoute(path), { mode: 'results', search });
});

test('going back to home does not turn the previous destination draft into results', () => {
  const results = resultsPath({ destination: { code: '215', name: 'South Kuta' }, keyword: '' });
  assert.equal(parseCatalogRoute(results).mode, 'results');
  assert.deepEqual(parseCatalogRoute('/'), { mode: 'home', search: null });
  assert.equal(parseCatalogRoute(results).mode, 'results');
});

test('empty or malformed city routes fall back to home without throwing', () => {
  for (const path of ['/activities', '/activities?city=', '/activities?city=%20', '/activities?city=%ZZ', '/activities?city=%E0%A4%A', '/activities?city=215&city=216', '/activities?city=..%2Fproduct%2F123']) {
    assert.deepEqual(parseCatalogRoute(path), { mode: 'home', search: null }, path);
  }
  assert.equal(resultsPath({ destination: null, keyword: '' }), null);
});

test('a city code alone remains a valid reloadable search', () => {
  assert.deepEqual(parseCatalogRoute('/activities?city=215'), {
    mode: 'results', search: { destination: { code: '215', name: '215' }, keyword: '' },
  });
});

test('product paths decode safely even for a malformed direct link', () => {
  assert.equal(productCodeFromPath('/product/P%20A'), 'P A');
  assert.equal(productCodeFromPath('/product/%E0%A4%A'), '');
  assert.equal(productCodeFromPath('/activities?city=215'), '');
});

test('category codes and names survive result URL serialization', () => {
  const search = {
    destination: { code: '215', name: '东京', countryName: '日本' },
    keyword: '乐园门票',
    category: { code: '20101', name: '主题乐园' },
  };
  const path = resultsPath(search);
  assert.ok(path.includes('category=20101&categoryName='));
  assert.deepEqual(parseCatalogRoute(path), { mode: 'results', search });
});

test('categories and keywords can search all activities without a destination', () => {
  for (const search of [
    { destination: null, keyword: '游船 & 海滩' },
    { destination: null, keyword: '', category: { code: '20101', name: '主题乐园' } },
  ]) {
    assert.deepEqual(parseCatalogRoute(resultsPath(search)), { mode: 'results', search });
  }
});

test('invalid category criteria cannot turn into an unfiltered activity list', () => {
  for (const path of ['/activities?category=', '/activities?category=..%2Fsecret', '/activities?category=20101&category=20102', '/activities?q=%20']) {
    assert.deepEqual(parseCatalogRoute(path), { mode: 'home', search: null }, path);
  }
  assert.equal(resultsPath({ destination: null, keyword: '', category: { code: '', name: '主题乐园' } }), null);
});

test('a fresh search page can reload and return to home', () => {
  const search = { destination: null, keyword: '' };
  const path = searchPath(search, '/');
  assert.ok(path.startsWith('/search?'));
  assert.deepEqual(parseSearchRoute(path), { search, returnTo: '/' });
  assert.deepEqual(parseSearchRoute('/search'), { search, returnTo: '/' });
});

test('closing search after reload returns to its exact list with category and keyword', () => {
  const search = {
    destination: { code: '215', name: '东京', countryName: '日本' },
    keyword: '海滩 & 游船 + 门票',
    category: { code: '20101', name: '主题乐园' },
  };
  const returnTo = resultsPath(search);
  const openedSearch = searchPath(search, returnTo);
  assert.deepEqual(parseSearchRoute(openedSearch), { search, returnTo });
  assert.deepEqual(parseCatalogRoute(parseSearchRoute(openedSearch).returnTo), { mode: 'results', search });
});

test('search return paths cannot point outside home and valid activity lists', () => {
  for (const returnTo of ['https://example.com', '//example.com', '/search', '/product/10549', '/activities', '/activities?city=%ZZ']) {
    assert.equal(parseSearchRoute(searchPath({ destination: null, keyword: '游船' }, returnTo)).returnTo, '/');
  }
  assert.equal(parseSearchRoute('/search?city=%ZZ'), null);
  assert.equal(parseSearchRoute('/product/10549'), null);
});
