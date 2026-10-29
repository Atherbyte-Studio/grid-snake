'use strict';
/* The prices the server charges (supabase/wallet_catalog.sql) are the shop's prices (src/shop.js): the file is generated and
 * must be current. Run: node --test tests/wallet_catalog.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Shop = require('../src/shop.js');
const { build } = require('../scripts/gen-wallet-catalog.js');

test('wallet_catalog.sql is current: run node scripts/gen-wallet-catalog.js after changing a price or an item', () => {
  const file = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'wallet_catalog.sql'), 'utf8');
  assert.equal(file, build());
});

test('every shop id is one the database accepts, and every price is a whole number above 0', () => {
  for (const i of Shop.ITEMS) {
    assert.match(i.id, /^(skin|board):[a-z0-9]+$/, i.id);
    assert.ok(Number.isInteger(i.price) && i.price > 0, i.id);
  }
});
