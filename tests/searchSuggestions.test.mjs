import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source = (await readFile(new URL('../src/searchSuggestions.ts', import.meta.url), 'utf8'))
  .replace("'./localization'", JSON.stringify(new URL('../src/localization.ts', import.meta.url).href));
const { normalizedSearch, matchingCities, popularCities, exactCity, categoryChoices, validActivityCount } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);

const cities = [
  { city_code: '19190', city_name: 'Hangzhou', country_name: 'Mainland China' },
  { city_code: '28', city_name: 'Tokyo', country_name: 'Japan' },
  { city_code: '99', city_name: 'Kyoto', country_name: 'Japan' },
];
test('Chinese and original city names resolve the same supplier destination', () => {
  assert.equal(matchingCities(cities, '杭州')[0].city_code, '19190');
  assert.equal(matchingCities(cities, 'hangzhou')[0].city_code, '19190');
  assert.equal(matchingCities(cities, '东京')[0].city_code, '28');
  assert.deepEqual(matchingCities(cities, '日本').map(c => c.city_code), ['28', '99']);
  assert.deepEqual(matchingCities(cities, ''), []);
});
test('exact destination matches precede partial matches', () => {
  const more = [{ city_code: '1', city_name: 'Tokyo Bay', country_name: 'Japan' }, ...cities];
  assert.equal(matchingCities(more, 'Tokyo')[0].city_code, '28');
  assert.equal(normalizedSearch('  Zürich  '), 'zurich');
});
test('hot destination choices cannot invent unavailable directory entries', () => {
  assert.deepEqual(popularCities(cities).map(city => city.city_code), ['28', '19190']);
});
test('submitting a country or partial match never silently chooses its first city', () => {
  assert.equal(exactCity(cities, 'Japan'), undefined);
  assert.equal(exactCity(cities, '中国'), undefined);
  assert.equal(exactCity(cities, 'Hang'), undefined);
  assert.equal(exactCity(cities, '杭州').city_code, '19190');
  assert.equal(exactCity(cities, '  TOKYO ').city_code, '28');
});
test('category suggestions use known real product codes and omit abandoned types', () => {
  const categories = [{ category_code: '1', category_name: 'Attractions', sub_categories: [
    { sub_category_code: '118', sub_category_name: 'Playgrounds' },
    { sub_category_code: '999', sub_category_name: 'Abandoned' },
  ] }];
  assert.deepEqual(categoryChoices([{ category_code: '118' }, { category_code: '118' }, { category_code: '999' }, { category_code: 'unknown' }], categories), [{ code: '118', name: 'Playgrounds' }]);
});
test('counts require a precise nonnegative total, not page length or coercion', () => {
  assert.equal(validActivityCount(41), 41);
  assert.equal(validActivityCount(0), 0);
  for (const value of [-1, 1.5, '41', null, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.equal(validActivityCount(value), null);
});
