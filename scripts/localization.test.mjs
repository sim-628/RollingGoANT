import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { categoryNameZh, countryNameZh, locationLabelZh, placeNameZh } from '../src/localization.ts';

// Public catalog label snapshot, not product contents, prices, or credentials.
const fixture = JSON.parse(await readFile(new URL('./localization-fixtures.json', import.meta.url), 'utf8'));
const chinese = value => /\p{Script=Han}/u.test(value) && !/\p{Script=Latin}/u.test(value);

test('all live destination and product city labels have specific Chinese translations', () => {
  assert.equal(fixture.destinationCount, 457);
  assert.equal(fixture.productCount, 3114);
  for (const raw of fixture.cityNames) {
    const display = placeNameZh(raw);
    if (!raw) { assert.equal(display, ''); continue; }
    assert.ok(chinese(display), `Untranslated city: ${raw} → ${display}`);
    assert.notEqual(display, '当地目的地', `Missing city mapping: ${raw}`);
  }
});

test('all current countries and country name variants render Chinese', () => {
  for (const { name, code } of fixture.countries) {
    const display = countryNameZh(name, code);
    if (!name && !code) { assert.equal(display, ''); continue; }
    assert.ok(chinese(display), `Untranslated country: ${name} → ${display}`);
    assert.notEqual(display, '其他地区', `Missing country mapping: ${name}`);
  }
});

test('all main categories, subcategories, and product category variants render Chinese', () => {
  const intentionallyGeneric = new Set(['Abandoned', 'Abandoned(too)', 'Others']);
  for (const raw of fixture.categoryNames) {
    const display = categoryNameZh(raw);
    assert.ok(chinese(display), `Untranslated category: ${raw} → ${display}`);
    if (!intentionallyGeneric.has(raw)) assert.notEqual(display, '其他体验', `Missing category mapping: ${raw}`);
  }
});

test('known spelling variants and accents retain the correct place', () => {
  assert.equal(placeNameZh(' South Kuta '), '南库塔');
  assert.equal(placeNameZh('sOUTH kUTA'), '南库塔');
  assert.equal(placeNameZh('Muğla'), '穆拉');
  assert.equal(placeNameZh('Mugla'), '穆拉');
  assert.equal(placeNameZh('Đăk R’Lấp District'), '得热勒县');
  assert.equal(placeNameZh('上海'), '上海');
  assert.equal(categoryNameZh('spa & massage'), '水疗与按摩');
  assert.equal(categoryNameZh('Theme Parks'), '主题乐园');
  assert.equal(categoryNameZh('theme parks'), '主题乐园');
  assert.equal(categoryNameZh('THEME PARK'), '主题乐园');
  assert.equal(categoryNameZh('公共交通（非API）'), '公共交通');
});

test('unknown names remain Chinese without inventing a precise translation', () => {
  assert.equal(placeNameZh('A future supplier destination'), '当地目的地');
  assert.equal(countryNameZh('A future supplier region', '99999'), '其他地区');
  assert.equal(countryNameZh(undefined, 'GB'), '英国');
  assert.equal(categoryNameZh('Future-category'), '其他体验');
  assert.equal(placeNameZh(undefined), '');
  assert.equal(countryNameZh(undefined), '');
  assert.equal(categoryNameZh(undefined), '当地体验');
});

test('card location labels handle missing places and avoid duplicated city-country labels', () => {
  assert.equal(locationLabelZh('South Kuta', 'Indonesia'), '南库塔 · 印度尼西亚');
  assert.equal(locationLabelZh('Singapore', 'Singapore'), '新加坡');
  assert.equal(locationLabelZh('Hong Kong', 'Hong Kong', 'HK'), '香港');
  assert.equal(locationLabelZh(undefined, 'Japan'), '日本');
  assert.equal(locationLabelZh(undefined, undefined), '当地体验');
});
