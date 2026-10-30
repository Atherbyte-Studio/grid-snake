/* Grid Snake Duel: arenas
 * Fixed 30 x 30 battlefields with walls, corridors and choke points. Every arena is point-symmetric
 * (cell x,y mirrors to 29-x,29-y) and so are the two spawns, so neither side starts with a better
 * position. No DOM. Each arena is written as rectangles for one half; the mirror half is added here.
 */
var SnakeDuelMaps = (function () {
  'use strict';

  var SIZE = 30;
  var START_LEN = 4;
  /* Player 0 starts top-left heading right, player 1 is its mirror (bottom-right heading left). */
  var SPAWNS = [
    { head: { x: 6, y: 4 }, dir: { x: 1, y: 0 } },
    { head: { x: SIZE - 1 - 6, y: SIZE - 1 - 4 }, dir: { x: -1, y: 0 } }
  ];

  /* rects: [x, y, w, h] for one half (mirrored automatically). Spawn rows 3-5 (and their mirror) stay clear. */
  var ARENAS = [
    { id: 'crossroads', name: 'Crossroads', desc: 'Four blocks and a cross of corridors through the middle.',
      rects: [[8, 8, 5, 5], [17, 8, 5, 5]] },
    { id: 'pillars', name: 'Pillars', desc: 'A field of pillars: short cuts everywhere, cover nowhere.',
      rects: (function () {
        var r = [];
        [5, 11, 17, 23].forEach(function (x) { [9, 14, 19].forEach(function (y) { if (y <= 14) r.push([x, y, 2, 2]); }); });
        return r;
      })() },
    { id: 'gates', name: 'Twin Gates', desc: 'Two long walls with narrow gates guard the centre.',
      rects: [[0, 11, 3, 1], [6, 11, 12, 1], [21, 11, 9, 1], [13, 14, 4, 2]] },
    { id: 'chambers', name: 'Chambers', desc: 'Rooms and doorways: the shortest way is rarely the open one.',
      rects: [[0, 9, 7, 1], [9, 13, 1, 4], [13, 0, 1, 6], [12, 12, 6, 1]] }
  ];

  function mirror(x, y) { return { x: SIZE - 1 - x, y: SIZE - 1 - y }; }
  function idx(x, y) { return y * SIZE + x; }

  /* The arena as a wall grid (1 = wall) plus the spawn bodies. */
  function build(id) {
    var A = null;
    for (var i = 0; i < ARENAS.length; i++) if (ARENAS[i].id === id) A = ARENAS[i];
    if (!A) A = ARENAS[0];
    var walls = new Uint8Array(SIZE * SIZE);
    A.rects.forEach(function (r) {
      for (var y = r[1]; y < r[1] + r[3]; y++) for (var x = r[0]; x < r[0] + r[2]; x++) {
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
        var m = mirror(x, y);
        walls[idx(x, y)] = 1;
        walls[idx(m.x, m.y)] = 1;
      }
    });
    var spawns = SPAWNS.map(function (s) {
      var body = [];
      for (var k = 0; k < START_LEN; k++) body.push({ x: s.head.x - s.dir.x * k, y: s.head.y - s.dir.y * k });
      return { body: body, dir: { x: s.dir.x, y: s.dir.y } };
    });
    return { id: A.id, name: A.name, desc: A.desc, size: SIZE, walls: walls, spawns: spawns };
  }

  return { SIZE: SIZE, START_LEN: START_LEN, ARENAS: ARENAS, ids: ARENAS.map(function (a) { return a.id; }), build: build, mirror: mirror };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeDuelMaps;
