/* Grid Snake Duel: battlefield events
 * One event per round. Each event is a small object with the same surface, so the round engine never
 * needs to know which one is running, and a new event is one more entry in FACTORIES.
 *
 * Fairness rules every event follows
 *  - Everything is point-symmetric (x,y <-> 29-x,29-y) or chosen to be equally far from both snakes.
 *  - A hazard is always shown (warn) before it can hurt (lethal). warn() returns the ticks left, which is
 *    exactly what the screen shows, so the AI never knows more than the player.
 *  - Hazards only hurt a HEAD that moves into them (or a head standing on a cell the moment it turns
 *    lethal after its warning). Bodies are never cut.
 *  - Nothing appears on a snake: a vanishing cell, a portal or a moving wall waits until the cell is free.
 *  - Random choices use env.rng (the round's seed), so a round can be replayed exactly.
 *
 * Surface: begin(env), tick(env) before the snakes move, after(env) after they move,
 *          lethal(x,y) -> reason or null, warn(x,y) -> ticks until lethal (0 = no warning),
 *          portalAt(x,y) -> { exit, open } or null, coreAt(x,y), takeCore(env) -> points,
 *          noSpawn(x,y), status() -> short text for the HUD, view() -> what the renderer draws.
 */
var SnakeDuelEvents = (function () {
  'use strict';

  var INFO = {
    vanish: { name: 'Vanishing Grid', tag: 'The edges fall away, ring by ring. Hold the middle.' },
    portal: { name: 'Portal Shift', tag: 'Two linked portals. They move. A blocked exit is a dead end.' },
    laser:  { name: 'Laser Sweep', tag: 'Laser bands sweep the arena. Find the safe lanes.' },
    walls:  { name: 'Moving Walls', tag: 'Walls patrol fixed tracks. Read their path, use their cover.' },
    core:   { name: 'The Core', tag: 'A Core worth 3 points appears in the centre. Contest it.' }
  };
  var IDS = Object.keys(INFO);

  /* All times in ticks (one tick = one snake step, see SnakeDuel.TUNING.stepMs = 120 ms). */
  var T = {
    vanish: { every: 110, warn: 34, rings: 5 },
    portal: { preview: 25, every: 150, minGap: 10, clearance: 3 },
    laser:  { band: 3, warn: 17, active: 8, rest: 50, gap: 3 },
    walls:  { preview: 25, len: 4, every: 4, pairs: 2 },
    core:   { warn: 25, respawn: 80, points: 3, region: 4 }
  };

  function key(x, y) { return x + ',' + y; }
  function shuffle(a, rng) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

  /* ---------- the five events ---------- */

  /* Vanishing Grid: ring r is every cell whose distance to the nearest edge is r. Waves remove rings 0..4. */
  function vanish() {
    var V = T.vanish, gone = {}, warned = {}, wave = -1, nextWave = 0, waveAt = 0;
    function ring(x, y, n) { return Math.min(x, y, n - 1 - x, n - 1 - y); }
    return {
      begin: function () { nextWave = 0; },
      tick: function (env) {
        var n = env.size, t = env.tick;
        if (wave + 1 < V.rings && t >= nextWave) {
          wave++; waveAt = t + V.warn; nextWave = t + V.every;
          for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
            if (ring(x, y, n) === wave && !env.isWall(x, y)) warned[key(x, y)] = waveAt;
          }
        }
        Object.keys(warned).forEach(function (k) {             // a warned cell drops once its time is up and it is empty
          if (t < warned[k]) return;
          var p = k.split(','), x = +p[0], y = +p[1];
          if (env.segAt(x, y)) return;
          gone[k] = 1; delete warned[k];
          env.relocate(x, y);
        });
      },
      after: function () {},
      lethal: function (x, y) { return gone[key(x, y)] ? 'void' : null; },
      warn: function (x, y, env) { var w = warned[key(x, y)]; return w === undefined ? 0 : Math.max(1, w - env.tick); },
      portalAt: function () { return null; }, coreAt: function () { return false; }, takeCore: function () { return 0; },
      noSpawn: function (x, y) { var k = key(x, y); return !!(gone[k] || warned[k]); },
      status: function (env) {
        if (wave + 1 >= V.rings) return 'The arena has stopped shrinking';
        return 'Next ring falls in ' + Math.max(0, Math.ceil((nextWave + V.warn - env.tick) * env.step / 1000)) + ' s';
      },
      view: function () { return { kind: 'vanish', gone: gone, warned: warned }; }
    };
  }

  /* Portal Shift: one linked pair at mirrored cells. It moves every `every` ticks; the new spot is shown first. */
  function portal() {
    var P = T.portal, cur = null, next = null, nextAt = 0, moveAt = 0;
    function pick(env) {
      var n = env.size, cands = [];
      for (var y = 1; y < n - 1; y++) for (var x = 1; x < n - 1; x++) {
        var m = env.mirror(x, y);
        if (x * n + y >= m.x * n + m.y) continue;                     // each pair once
        if (Math.abs(x - m.x) + Math.abs(y - m.y) < P.minGap) continue;
        if (!env.open(x, y) || !env.open(m.x, m.y) || env.isWall(x, y) || env.isWall(m.x, m.y)) continue;
        if (env.nearHead(x, y, P.clearance) || env.nearHead(m.x, m.y, P.clearance)) continue;
        if (cur && (key(x, y) === key(cur[0].x, cur[0].y) || key(x, y) === key(cur[1].x, cur[1].y))) continue;
        var free = 0;                                                  // a portal needs room around it
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) { if (!env.isWall(x + d[0], y + d[1])) free++; });
        if (free < 3) continue;
        cands.push([{ x: x, y: y }, m]);
      }
      return cands.length ? cands[Math.floor(env.rng() * cands.length)] : null;
    }
    function occupied(env, pair) { return env.segAt(pair[0].x, pair[0].y) || env.segAt(pair[1].x, pair[1].y); }
    return {
      begin: function (env) { next = pick(env); moveAt = env.tick + P.preview; },
      tick: function (env) {
        if (next && env.tick >= moveAt && !occupied(env, next)) {          // a portal never opens under a snake
          cur = next; next = null; nextAt = env.tick + P.every - P.preview;
          env.relocate(cur[0].x, cur[0].y); env.relocate(cur[1].x, cur[1].y);
          env.emit('portalShift', {});
        }
        if (!next && cur && env.tick >= nextAt) { next = pick(env); moveAt = env.tick + P.preview; }
      },
      after: function () {},
      lethal: function () { return null; },
      warn: function () { return 0; },
      portalAt: function (x, y, env) {
        if (!cur) return null;
        for (var i = 0; i < 2; i++) if (cur[i].x === x && cur[i].y === y) {
          var e = cur[1 - i];
          return { exit: e, open: !env.segAt(e.x, e.y) };
        }
        return null;
      },
      coreAt: function () { return false; }, takeCore: function () { return 0; },
      noSpawn: function (x, y) {
        var all = (cur || []).concat(next || []);
        for (var i = 0; i < all.length; i++) if (all[i].x === x && all[i].y === y) return true;
        return false;
      },
      status: function (env) {
        if (!cur) return 'Portals opening';
        if (next) return 'Portals move in ' + Math.max(0, Math.ceil((moveAt - env.tick) * env.step / 1000)) + ' s';
        return 'Portals open';
      },
      view: function (env) {
        var open = cur ? [!env.segAt(cur[1].x, cur[1].y), !env.segAt(cur[0].x, cur[0].y)] : null;
        return { kind: 'portal', cur: cur, next: next, open: open };
      }
    };
  }

  /* Laser Sweep: the arena is cut into bands three cells thick. A sweep fires them in order, each band warned
     before it fires. Sweeps alternate rows and columns and run edges-to-centre, then centre-to-edges; a band and its
     mirror always fire together, and two mirrored safe lanes cross every band, so both sides face the same sweep. */
  function laser() {
    var L = T.laser, sweep = -1, axis = 'row', inward = true, lanes = [], startAt = 0, steps = 0, done = false;
    function newSweep(env) {
      sweep++;
      axis = sweep % 2 === 0 ? 'row' : 'col';
      inward = Math.floor(sweep / 2) % 2 === 0;
      steps = Math.ceil(Math.ceil(env.size / L.band) / 2);
      var c = 2 + Math.floor(env.rng() * (env.size / 2 - L.gap - 4));   // a lane in the first half, mirrored in the second
      lanes = [[c, c + L.gap - 1], [env.size - c - L.gap, env.size - 1 - c]];
      startAt = env.tick;
    }
    function orderOf(x, y, n) {
      var v = axis === 'row' ? y : x, b = Math.floor(v / L.band), last = Math.ceil(n / L.band) - 1, k = Math.min(b, last - b);
      return inward ? k : steps - 1 - k;
    }
    function inLane(x, y) {
      var v = axis === 'row' ? x : y;
      return (v >= lanes[0][0] && v <= lanes[0][1]) || (v >= lanes[1][0] && v <= lanes[1][1]);
    }
    function endAt() { return startAt + (steps - 1) * L.active + L.warn + L.active; }
    /* Step k is warned from startAt + k*active, fires L.warn ticks later, for L.active ticks. */
    function phaseAt(x, y, env) {
      if (sweep < 0 || inLane(x, y)) return null;
      var t = env.tick, k = orderOf(x, y, env.size), warnAt = startAt + k * L.active, fireAt = warnAt + L.warn, offAt = fireAt + L.active;
      if (t >= warnAt && t < fireAt) return { warn: fireAt - t };
      if (t >= fireAt && t < offAt) return { fire: true };
      return null;
    }
    return {
      begin: function (env) { newSweep(env); },
      tick: function (env) {
        if (env.tick >= endAt() + L.rest) newSweep(env);
        done = env.tick >= endAt();
      },
      after: function () {},
      lethal: function (x, y, env) { var p = phaseAt(x, y, env); return p && p.fire ? 'laser' : null; },
      warn: function (x, y, env) { var p = phaseAt(x, y, env); return p && p.warn ? p.warn : 0; },
      portalAt: function () { return null; }, coreAt: function () { return false; }, takeCore: function () { return 0; },
      noSpawn: function (x, y, env) { return !!phaseAt(x, y, env); },
      status: function (env) {
        if (done) return 'Next sweep in ' + Math.max(0, Math.ceil((endAt() + L.rest - env.tick) * env.step / 1000)) + ' s';
        return (inward ? 'Sweep closing in' : 'Sweep spreading out') + ' · stay in a safe lane';
      },
      view: function (env) {
        var cells = [];
        for (var y = 0; y < env.size; y++) for (var x = 0; x < env.size; x++) {
          var p = phaseAt(x, y, env);
          if (p) cells.push({ x: x, y: y, fire: !!p.fire, warn: p.warn || 0 });
        }
        return { kind: 'laser', cells: cells, lanes: lanes, axis: axis, active: sweep >= 0 && !done };
      }
    };
  }

  /* Moving Walls: bars four cells long patrol straight tracks and turn round at the ends. Mirrored pairs.
     A bar never moves into a snake: if its next cells are taken, it waits. Its next step is always shown. */
  function walls() {
    var W = T.walls, bars = [], shownAt = 0, live = false;
    function cellsOf(b, pos) {
      var out = [];
      for (var i = 0; i < W.len; i++) out.push(b.axis === 'x' ? { x: pos, y: b.fixed + i } : { x: b.fixed + i, y: pos });
      return out;
    }
    function trackFree(env, b) {
      for (var p = b.min; p <= b.max; p++) {
        var cs = cellsOf(b, p);
        for (var i = 0; i < cs.length; i++) if (env.isWall(cs[i].x, cs[i].y) || env.spawnZone(cs[i].x, cs[i].y)) return false;
      }
      return true;
    }
    function overlaps(a, b) {
      var A = {}, hit = false;
      for (var p = a.min; p <= a.max; p++) cellsOf(a, p).forEach(function (c) { A[key(c.x, c.y)] = 1; });
      for (var q = b.min; q <= b.max; q++) cellsOf(b, q).forEach(function (c) { if (A[key(c.x, c.y)]) hit = true; });
      return hit;
    }
    function mirrorBar(b, n) {
      return { axis: b.axis, fixed: n - b.fixed - W.len, min: n - 1 - b.max, max: n - 1 - b.min, pos: n - 1 - b.pos, dir: -b.dir };
    }
    function build(env) {
      var n = env.size;
      for (var tries = 0; tries < 200 && bars.length < W.pairs * 2; tries++) {
        var axis = env.rng() < 0.5 ? 'x' : 'y';
        var fixed = 2 + Math.floor(env.rng() * (n / 2 - W.len - 2));
        var len = 6 + Math.floor(env.rng() * 6), min = 3 + Math.floor(env.rng() * (n - len - 6));
        var b = { axis: axis, fixed: fixed, min: min, max: min + len, pos: min, dir: 1 };
        var m = mirrorBar(b, n);
        if (!trackFree(env, b) || !trackFree(env, m) || overlaps(b, m)) continue;
        if (bars.some(function (o) { return overlaps(o, b) || overlaps(o, m); })) continue;
        bars.push(b, m);
      }
    }
    function at(x, y) {
      if (!live) return -1;
      for (var i = 0; i < bars.length; i++) {
        var b = bars[i], along = b.axis === 'x' ? x : y, across = b.axis === 'x' ? y : x;
        if (along === b.pos && across >= b.fixed && across < b.fixed + W.len) return i;
      }
      return -1;
    }
    function nextPos(b) { var p = b.pos + b.dir; return (p < b.min || p > b.max) ? b.pos - b.dir : p; }
    return {
      begin: function (env) { build(env); shownAt = env.tick + W.preview; },
      tick: function (env) {
        if (!live && env.tick >= shownAt) {
          var clear = bars.every(function (b) { return cellsOf(b, b.pos).every(function (c) { return !env.segAt(c.x, c.y); }); });
          if (clear) { live = true; bars.forEach(function (b) { cellsOf(b, b.pos).forEach(function (c) { env.relocate(c.x, c.y); }); }); }
        }
      },
      after: function (env) {
        if (!live || env.tick % W.every !== 0) return;
        bars.forEach(function (b) {
          var p = nextPos(b), cs = cellsOf(b, p);
          if (cs.some(function (c) { return env.segAt(c.x, c.y); })) return;   // a snake is in the way: wait
          b.dir = p > b.pos ? 1 : -1;
          b.pos = p;
          cs.forEach(function (c) { env.relocate(c.x, c.y); });
        });
      },
      lethal: function (x, y) { return at(x, y) >= 0 ? 'wall' : null; },
      warn: function (x, y, env) {                                     // where the bars will appear, then the cells a bar enters next
        if (!live) {
          for (var j = 0; j < bars.length; j++) {
            var a = bars[j], al = a.axis === 'x' ? x : y, ac = a.axis === 'x' ? y : x;
            if (al === a.pos && ac >= a.fixed && ac < a.fixed + W.len) return Math.max(1, shownAt - env.tick);
          }
          return 0;
        }
        var left = W.every - (env.tick % W.every);
        for (var i = 0; i < bars.length; i++) {
          var b = bars[i], p = nextPos(b), along = b.axis === 'x' ? x : y, across = b.axis === 'x' ? y : x;
          if (along === p && across >= b.fixed && across < b.fixed + W.len) return left;
        }
        return 0;
      },
      portalAt: function () { return null; }, coreAt: function () { return false; }, takeCore: function () { return 0; },
      noSpawn: function (x, y) {
        for (var i = 0; i < bars.length; i++) {
          var b = bars[i], along = b.axis === 'x' ? x : y, across = b.axis === 'x' ? y : x;
          if (along >= b.min && along <= b.max && across >= b.fixed && across < b.fixed + W.len) return true;
        }
        return false;
      },
      status: function (env) { return live ? 'Walls on patrol' : 'Walls arrive in ' + Math.max(0, Math.ceil((shownAt - env.tick) * env.step / 1000)) + ' s'; },
      view: function () {
        return { kind: 'walls', live: live, bars: bars.map(function (b) {
          return { cells: cellsOf(b, b.pos), next: cellsOf(b, nextPos(b)), track: { axis: b.axis, fixed: b.fixed, min: b.min, max: b.max, len: W.len } };
        }) };
      }
    };
  }

  /* The Core: worth 3. It appears near the centre on the free cell most equally far from both heads, is marked
     before it appears, and comes back a while after it is taken. */
  function core() {
    var C = T.core, spot = null, live = false, showAt = 0, taken = 0;
    function place(env) {
      var n = env.size, c0 = n / 2 - 0.5, best = null, bestV = 1e9;
      for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
        if (Math.abs(x - c0) > C.region || Math.abs(y - c0) > C.region) continue;
        if (!env.open(x, y) || env.noSpawnOther(x, y)) continue;
        var d = env.headDist(x, y), v = Math.abs(d[0] - d[1]) * 10 + Math.abs(x - c0) + Math.abs(y - c0) + env.rng() * 0.5;
        if (v < bestV) { bestV = v; best = { x: x, y: y }; }
      }
      return best;
    }
    return {
      begin: function (env) { spot = place(env); showAt = env.tick + C.warn; },
      tick: function (env) {
        if (!spot) { if (env.tick >= showAt) { spot = place(env); showAt = env.tick + C.warn; } return; }
        if (!live && env.tick >= showAt && !env.segAt(spot.x, spot.y)) { live = true; env.relocate(spot.x, spot.y); env.emit('coreSpawn', { x: spot.x, y: spot.y }); }
      },
      after: function () {},
      lethal: function () { return null; },
      warn: function () { return 0; },
      portalAt: function () { return null; },
      coreAt: function (x, y) { return live && spot && spot.x === x && spot.y === y; },
      takeCore: function (env) {
        live = false; taken++; spot = null; showAt = env.tick + C.respawn;
        return C.points;
      },
      noSpawn: function (x, y) { return !!(spot && spot.x === x && spot.y === y); },
      status: function (env) {
        if (live) return 'The Core is live: +' + C.points;
        if (spot) return 'Core appears in ' + Math.max(0, Math.ceil((showAt - env.tick) * env.step / 1000)) + ' s';
        return 'Core returns in ' + Math.max(0, Math.ceil((showAt - env.tick) * env.step / 1000)) + ' s';
      },
      view: function (env) { return { kind: 'core', spot: spot, live: live, warn: spot && !live ? Math.max(0, showAt - env.tick) : 0, taken: taken }; }
    };
  }

  var FACTORIES = { vanish: vanish, portal: portal, laser: laser, walls: walls, core: core };

  function create(id) {
    var f = FACTORIES[id];
    if (!f) throw new Error('unknown duel event: ' + id);
    var ev = f();
    ev.id = id; ev.name = INFO[id].name; ev.tag = INFO[id].tag;
    return ev;
  }

  /* The events for a match: a shuffled pool, never repeating until every event has been used. */
  function order(rng, count) {
    var out = [];
    while (out.length < count) {
      var pool = shuffle(IDS.slice(), rng);
      if (out.length && pool[0] === out[out.length - 1]) pool.push(pool.shift());   // no repeat across a refill
      out = out.concat(pool);
    }
    return out.slice(0, count);
  }

  return { IDS: IDS, INFO: INFO, TUNING: T, create: create, order: order };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeDuelEvents;
