/* Grid Snake shop catalogue
 * What the shop sells, its rarity and its price. No DOM and no storage: src/profile.js keeps what is owned,
 * and the page draws the cards. Coins come from play: a run pays one coin per point it scores when it ends,
 * and each achievement tier pays its own reward (see src/tracker.js and src/achievements.js).
 * id is kind:key (skin:jordan, board:neon). Rarity sets the price band; prices apply only to new purchases.
 * Items a player already owns stay owned when a price changes.
 */
var SnakeShop = (function () {
  'use strict';

  var RARITY = {
    basic:     { name: 'Basic',     min: 100,  max: 250 },
    rare:      { name: 'Rare',      min: 500,  max: 1000 },
    epic:      { name: 'Epic',      min: 1500, max: 3000 },
    legendary: { name: 'Legendary', min: 5000, max: 10000 }
  };

  var ITEMS = [
    { id: 'skin:palestine', rarity: 'basic', price: 150,  desc: 'A black and white keffiyeh wrapped around the head.' },
    { id: 'skin:jordan',    rarity: 'basic', price: 200,  desc: 'A red and white keffiyeh wrapped around the head.' },
    { id: 'board:desert',   rarity: 'basic', price: 200,  desc: 'A warm sandy board for late-night runs.' },
    { id: 'skin:cyber',     rarity: 'rare',  price: 500,  desc: 'Neon circuit lines on the body and a glowing visor.' },
    { id: 'board:neon',     rarity: 'rare',  price: 500,  desc: 'A dark board with a glowing purple grid.' },
    { id: 'skin:galaxy',    rarity: 'rare',  price: 800,  desc: 'A twinkling night-sky body with a star halo.' },
    { id: 'skin:dragon',    rarity: 'epic',  price: 1500, desc: 'Gold scales, spines and a pair of horns.' },
    { id: 'board:meadow',   rarity: 'basic', price: 250,  desc: 'Grass-green tiles with tufts, for an easy-going board.' },
    { id: 'skin:shemagh',   rarity: 'rare',  price: 750,  desc: 'A red and white check wrapped around the head, with a checked body band.' },
    { id: 'board:autumn',   rarity: 'rare',  price: 750,  desc: 'Warm brown tiles with fallen leaves scattered across the board.' },
    { id: 'skin:royal',     rarity: 'legendary', price: 5000, desc: 'A violet body with gold rails, jewels and a crown.' }
  ];

  /* A price outside its rarity band is a mistake in the catalogue, not a player problem. */
  function inBand(item) {
    var r = RARITY[item.rarity];
    return !!r && item.price >= r.min && item.price <= r.max;
  }

  return { RARITY: RARITY, ITEMS: ITEMS, inBand: inBand };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeShop;
