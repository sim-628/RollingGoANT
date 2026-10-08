import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalogRoute, productCodeFromPath, resultsPath } from '../src/catalogRoute.ts';

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
  assert.equal(resultsPath({ destination: null, keyword: '游船' }), null);
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
