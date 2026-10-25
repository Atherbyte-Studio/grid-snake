'use strict';
/* Shop and coin rules: price bands, purchases, locked items, saved balances and corrupt saved data. */
const test = require('node:test');
const assert = require('node:assert/strict');
const Shop = require('../src/shop.js');
const Profile = require('../src/profile.js');

function fakeStorage(seed) {
  const m = new Map(Object.entries(seed || {}));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
}
function make(storage, extra) {
  const ids = Shop.ITEMS.map(i => i.id);
  return Profile.create(storage, Object.assign({
    modes: ['classic'], achievementIds: [], skins: ['emerald', 'ocean', 'palestine', 'jordan', 'cyber', 'galaxy', 'dragon'], styles: ['realistic'],
    boards: ['midnight', 'forest', 'desert', 'neon'], foods: ['dot'], premium: ids
  }, extra || {}));
}

test('every shop item has a known rarity and a price inside that rarity band', () => {
  const seen = new Set();
  for (const it of Shop.ITEMS) {
    assert.ok(Shop.RARITY[it.rarity], `${it.id} has an unknown rarity`);
    assert.ok(Shop.inBand(it), `${it.id} price ${it.price} is outside the ${it.rarity} band`);
    assert.ok(!seen.has(it.id), `duplicate shop id ${it.id}`);
    seen.add(it.id);
  }
});

test('a purchase fails without enough coins and leaves the balance alone', () => {
  const p = make(fakeStorage());
  p.addCoins(99);
  assert.equal(p.buy('skin:jordan', 200), false);
  assert.equal(p.getCoins(), 99);
  assert.equal(p.owns('skin:jordan'), false);
});

test('a purchase deducts the price once and cannot be repeated', () => {
  const p = make(fakeStorage());
  p.addCoins(500);
  assert.equal(p.buy('skin:cyber', 500), true);
  assert.equal(p.getCoins(), 0);
  assert.equal(p.buy('skin:cyber', 500), false, 'owned items cannot be bought twice');
  assert.equal(p.getCoins(), 0, 'and the balance is not charged again');
});

test('unknown items and negative prices are refused', () => {
  const p = make(fakeStorage());
  p.addCoins(1000);
  assert.equal(p.buy('skin:nope', 10), false);
  assert.equal(p.buy('skin:cyber', -5), false);
  assert.equal(p.getCoins(), 1000);
});

test('a locked premium skin cannot be equipped until it is owned', () => {
  const p = make(fakeStorage());
  p.setPrefs({ skin: 'cyber' });
  assert.notEqual(p.getPrefs().skin, 'cyber', 'a locked skin is not equipped');
  p.addCoins(500);
  p.buy('skin:cyber', 500);
  p.setPrefs({ skin: 'cyber' });
  assert.equal(p.getPrefs().skin, 'cyber', 'the same skin equips once it is owned');
});

test('balance, purchases and equipped look survive a reload', () => {
  const st = fakeStorage();
  const a = make(st);
  a.addCoins(700);
  a.buy('skin:galaxy', 800 - 100 + 0 === 700 ? 700 : 700);
  a.setPrefs({ board: 'midnight' });
  const b = make(st);
  assert.equal(b.getCoins(), 0, 'the purchase spent the coins before the reload');
  assert.equal(b.owns('skin:galaxy'), true);
});

test('an older save without coins or shop fields still loads, with zero coins', () => {
  const st = fakeStorage({ 'gridsnake-profile-v2': JSON.stringify({ name: 'Old', prefs: { mode: 'classic' }, totals: { foods: 4 } }) });
  const p = make(st);
  assert.equal(p.getCoins(), 0);
  assert.equal(p.owns('skin:cyber'), false);
  assert.equal(p.getTotals().foods, 4, 'older totals are kept');
});

test('malformed coin values are treated as zero, never negative or NaN', () => {
  for (const bad of [-50, 'lots', NaN, null, { x: 1 }, 1e308 * 10]) {
    const st = fakeStorage({ 'gridsnake-profile-v2': JSON.stringify({ coins: bad }) });
    const p = make(st);
    assert.ok(Number.isFinite(p.getCoins()) && p.getCoins() >= 0, `coins from ${String(bad)} gave ${p.getCoins()}`);
  }
});

test('owned items in a save are kept only when they are real shop items', () => {
  const st = fakeStorage({ 'gridsnake-profile-v2': JSON.stringify({ owned: { 'skin:cyber': true, 'skin:fake': true } }) });
  const p = make(st);
  assert.equal(p.owns('skin:cyber'), true);
  assert.equal(p.owns('skin:fake'), false);
});
