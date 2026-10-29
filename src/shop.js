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
    { id: 'board:desert',   rarity: 'rare',  price: 1000,  desc: 'A warm sandy board for late-night runs.' },
    { id: 'skin:cyber',     rarity: 'rare',  price: 500,  desc: 'Neon circuit lines on the body and a glowing visor.' },
    { id: 'board:neon',     rarity: 'epic',  price: 1800,  desc: 'A dark board with a glowing purple grid.' },
    { id: 'skin:galaxy',    rarity: 'rare',  price: 800,  desc: 'A twinkling night-sky body with a star halo.' },
    { id: 'skin:dragon',    rarity: 'epic',  price: 1500, desc: 'Gold scales, spines and a pair of horns.' },
    { id: 'board:meadow',   rarity: 'epic',  price: 1500,  desc: 'Grass-green tiles with tufts, for an easy-going board.' },
    { id: 'skin:shemagh',   rarity: 'rare',  price: 750,  desc: 'A red and white check wrapped around the head, with a checked body band.' },
    { id: 'board:autumn',   rarity: 'epic',  price: 2000,  desc: 'Warm brown tiles with fallen leaves scattered across the board.' },
    { id: 'skin:royal',     rarity: 'legendary', price: 5000, desc: 'A violet body with gold rails, jewels and a crown.' },

    /* Football, history and legends (skins). Colours and shapes only: no club badges or real logos. */
    { id: 'skin:madrid',    rarity: 'epic',      price: 2500, desc: 'White kit with gold trim and a royal purple dot, for the capital\'s champions.' },
    { id: 'skin:barca',     rarity: 'epic',      price: 2500, desc: 'Blue and garnet stripes from nose to tail, with a golden captain\'s band.' },
    { id: 'skin:argentina', rarity: 'epic',      price: 2000, desc: 'Sky-blue and white stripes with a golden sun band.' },
    { id: 'skin:brazil',    rarity: 'epic',      price: 2000, desc: 'Samba green and yellow with a deep blue rail.' },
    { id: 'skin:pharaoh',   rarity: 'epic',      price: 3000, desc: 'Gold and lapis stripes under a pharaoh\'s royal headcloth.' },
    { id: 'skin:roman',     rarity: 'epic',      price: 2600, desc: 'A legionary in crimson with a golden helmet and a crest.' },
    { id: 'skin:viking',    rarity: 'epic',      price: 2800, desc: 'Iron-grey and leather with a horned helmet.' },
    { id: 'skin:samurai',   rarity: 'epic',      price: 3000, desc: 'Black lacquer armour, red lacing and a golden crescent helmet.' },
    { id: 'skin:ottoman',   rarity: 'legendary', price: 5500, desc: 'Deep red and gold with a tasselled fez.' },
    { id: 'skin:saladin',   rarity: 'legendary', price: 6500, desc: 'A green and gold knight under a yellow and crimson turban.' },

    /* Football stars: their face on the snake's head, their number on its body, a big picture on the shop card. */
    { id: 'skin:messi',       rarity: 'legendary', price: 9000,  desc: 'The Flea: an Albiceleste snake with LM10 on its body and his face on the head.' },
    { id: 'skin:ronaldo',     rarity: 'legendary', price: 9000,  desc: 'The Don: gold and purple with CR7 on its body and his face on the head.' },
    { id: 'skin:karim',       rarity: 'legendary', price: 10000, desc: 'The golden Karim: a crowned dragon of gold and pearl with his face on the head.' },
    { id: 'skin:mbappe',      rarity: 'legendary', price: 8000,  desc: 'Le Roi: a sky-blue snake with KM on its body and his face on the head.' },
    { id: 'skin:haaland',     rarity: 'legendary', price: 7500,  desc: 'The Nordic Giant: a red snake with EH9 on its body and his face on the head.' },
    { id: 'skin:neymar',      rarity: 'legendary', price: 7500,  desc: 'The Samba King: yellow and green with NJR10 on its body and his face on the head.' },
    { id: 'skin:benzema',     rarity: 'legendary', price: 7000,  desc: 'The Karim: a pearl-white snake with KB9 on its body and his face on the head.' },
    { id: 'skin:salah',       rarity: 'legendary', price: 7000,  desc: 'The Egyptian King: a red snake with M10 on its body and his face on the head.' },
    { id: 'skin:vinicius',    rarity: 'legendary', price: 6500,  desc: 'The Speed Demon: a cream snake with VJR on its body and his face on the head.' },
    { id: 'skin:bellingham',  rarity: 'legendary', price: 6500,  desc: 'The Generation King: a cream snake with JB on its body and his face on the head.' },
    { id: 'skin:lewandowski', rarity: 'legendary', price: 6000,  desc: 'The Goal Machine: white and red with RL9 on its body and his face on the head.' },
    { id: 'skin:debruyne',    rarity: 'legendary', price: 6000,  desc: 'The Ginger Master: a sky-blue snake with KDB on its body and his face on the head.' },
    { id: 'skin:griezmann',   rarity: 'legendary', price: 6000,  desc: 'Grizou: a sky-blue snake with AG7 on its body and his face on the head.' },

    /* Maps: each one has its own texture. */
    { id: 'board:chess',    rarity: 'epic',      price: 1600, desc: 'A grandmaster\'s checkered board in ivory and ebony.' },
    { id: 'board:snow',     rarity: 'epic',      price: 1800, desc: 'A frozen field with drifts of fresh snow.' },
    { id: 'board:dunes',    rarity: 'epic',      price: 2000, desc: 'Wind-carved golden sand dunes.' },
    { id: 'board:matrix',   rarity: 'epic',      price: 2200, desc: 'Falling green code on a black screen.' },
    { id: 'board:stars',    rarity: 'epic',      price: 2800, desc: 'Deep space with a purple nebula and a thousand stars.' },
    { id: 'board:pitch',    rarity: 'epic',      price: 3000, desc: 'A mown football pitch with the halfway line, centre circle and penalty boxes.' },
    { id: 'board:mosaic',   rarity: 'legendary', price: 5500, desc: 'Turquoise tiles with golden eight-point stars, in the Islamic art style.' },
    { id: 'board:roman',    rarity: 'legendary', price: 6000, desc: 'Veined marble flagstones from an ancient Roman forum.' },
    { id: 'board:alhambra', rarity: 'legendary', price: 7000, desc: 'Blue and ochre zellige tiles inspired by Andalusian palaces.' },
    { id: 'board:lava',     rarity: 'legendary', price: 8000, desc: 'Black volcanic rock split by glowing lava cracks.' }
  ];

  /* A price outside its rarity band is a mistake in the catalogue, not a player problem. */
  function inBand(item) {
    var r = RARITY[item.rarity];
    return !!r && item.price >= r.min && item.price <= r.max;
  }

  return { RARITY: RARITY, ITEMS: ITEMS, inBand: inBand };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeShop;
