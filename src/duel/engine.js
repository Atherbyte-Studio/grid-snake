/* Grid Snake Duel: the round engine (DuelEngine + RoundManager)
 * Two snakes on one 30 x 30 arena, one round of 90 seconds. Pure rules: no DOM, no timers, no global
 * randomness. Time moves only through update(dt); everything happens on a fixed tick (both snakes take
 * exactly one step per tick), and random numbers come from the round's seed. The same seed and the same
 * moves always give the same round, which is what tests use (and what an online match would need later).
 *
 * Controllers decide the moves. The engine asks each one once per tick: controller.next(round, index)
 * returns a direction or null (keep going). The human controller below queues key presses; the AI is in
 * src/duel/ai.js. Both use the same rules: the engine checks every move the same way.
 *
 * One tick, in this order (both snakes are resolved from the same picture, so update order never matters):
 *  1. The event updates. A head standing on a cell whose warning just ran out is hit.
 *  2. Each controller gives its move (a reversal is ignored; the snake keeps its heading).
 *  3. Each head's next cell is worked out: past the edge or into a wall = crash; a portal moves it to the
 *     linked portal (a blocked exit = crash); an active hazard there = crash.
 *  4. Bodies: every snake's tail leaves its cell this tick unless that snake is growing. Entering any body
 *     cell, your own or the rival's, is a crash. Both heads entering the same cell, or swapping cells, is a
 *     head-on crash for both.
 *  5. The survivors move and eat. Food is +1, the Core +3.
 * A round ends at the first crash. If one snake crashed, the other wins. If both crashed in the same tick,
 * the higher round score wins, and equal scores are a draw. At 90 s the higher score wins; equal scores go
 * to 15 s of sudden-death overtime (the first point wins), then the round is a draw.
 */
var SnakeDuel = (function () {
  'use strict';

  var node = typeof module !== 'undefined' && module.exports && typeof require === 'function';
  var Maps = node ? require('./maps.js') : SnakeDuelMaps;
  var Events = node ? require('./events.js') : SnakeDuelEvents;

  var TUNING = {
    stepMs: 120,          // one tick: both snakes move one cell (about 8 cells a second)
    roundMs: 90000,
    overtimeMs: 15000,
    announceMs: 8000,     // the event's name is shown at 8 s...
    eventMs: 10500,       // ...and it begins at 10.5 s
    foods: 3,             // food on the board at once
    foodPoints: 1,
    coreGrow: 2,          // extra segments from the Core (food adds one)
    fairSpawn: 4,         // new food is at most this many steps nearer to one head than the other, when possible
    minFoodDist: 3,
    inputBuffer: 2,
    maxDt: 100
  };
  var DIRS = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];

  /* The same 32-bit generator as the Worker's replay (mulberry32). */
  function seededRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* LocalHumanController: key presses wait in a short line, one is used per tick. */
  function humanController() {
    var queue = [], round = null, me = 0;
    return {
      kind: 'human',
      bind: function (r, i) { round = r; me = i; queue = []; },
      turn: function (dx, dy) {
        if (!round || Math.abs(dx) + Math.abs(dy) !== 1) return false;
        var s = round.state.snakes[me];
        if (!s.alive || round.state.phase === 'over') return false;
        var last = queue.length ? queue[queue.length - 1] : s.dir;
        if (last.x === dx && last.y === dy) return false;
        if (last.x === -dx && last.y === -dy) return false;           // a reversal would bite the neck
        if (queue.length < TUNING.inputBuffer) queue.push({ x: dx, y: dy });
        return true;
      },
      heading: function () { var s = round.state.snakes[me]; return queue.length ? queue[queue.length - 1] : s.dir; },
      next: function () { return queue.length ? queue.shift() : null; }
    };
  }

  function createRound(opts) {
    opts = opts || {};
    var T = Object.assign({}, TUNING, opts.tuning || {});
    var map = Maps.build(opts.map);
    var N = map.size, STEP = T.stepMs;
    var rng = seededRng(opts.seed == null ? 1 : opts.seed);
    var listeners = [];
    if (opts.onEvent) listeners.push(opts.onEvent);
    var controllers = opts.controllers || [humanController(), humanController()];

    var S = {
      size: N, map: { id: map.id, name: map.name, walls: map.walls },
      phase: 'ready', tick: 0, elapsed: 0, acc: 0,
      timeLeft: T.roundMs, overtime: false, otLeft: 0,
      snakes: map.spawns.map(function (sp, i) {
        return { id: i, body: sp.body.map(function (c) { return { x: c.x, y: c.y }; }), dir: { x: sp.dir.x, y: sp.dir.y },
                 alive: true, reason: null, score: 0, grow: 0, foods: 0, cores: 0, ported: false };
      }),
      foods: [],
      eventId: opts.event || null, event: null, eventPhase: opts.event ? 'pending' : 'none',
      result: null
    };
    var announceTick = Math.round(T.announceMs / STEP), eventTick = Math.round(T.eventMs / STEP);
    var otBase = null;

    function emit(type, data) {
      var e = data || {};
      e.type = type;
      for (var i = 0; i < listeners.length; i++) listeners[i](e, S);
    }

    /* ---------- the board ---------- */
    function inside(x, y) { return x >= 0 && y >= 0 && x < N && y < N; }
    function isWall(x, y) { return !inside(x, y) || map.walls[y * N + x] === 1; }
    function segAt(x, y) {
      for (var i = 0; i < 2; i++) { var b = S.snakes[i].body; for (var k = 0; k < b.length; k++) if (b[k].x === x && b[k].y === y) return true; }
      return false;
    }
    function foodAt(x, y) { for (var i = 0; i < S.foods.length; i++) if (S.foods[i].x === x && S.foods[i].y === y) return i; return -1; }
    function live() { return S.eventPhase === 'live' && S.event; }
    function lethal(x, y) { return live() ? S.event.lethal(x, y, env) : null; }
    function warn(x, y) { return live() ? S.event.warn(x, y, env) : 0; }
    function portalAt(x, y) { return live() ? S.event.portalAt(x, y, env) : null; }
    function coreAt(x, y) { return !!(live() && S.event.coreAt(x, y, env)); }
    function eventBlocks(x, y) { return !!(live() && (S.event.noSpawn(x, y, env) || S.event.lethal(x, y, env))); }
    function open(x, y) { return !isWall(x, y) && !segAt(x, y) && foodAt(x, y) < 0 && !eventBlocks(x, y); }

    /* Steps from each head to every cell, round walls (bodies ignored: they move). */
    function distFrom(h) {
      var d = new Int16Array(N * N).fill(-1), q = [h.y * N + h.x], qi = 0;
      d[q[0]] = 0;
      while (qi < q.length) {
        var c = q[qi++], cx = c % N, cy = (c - cx) / N;
        for (var k = 0; k < 4; k++) {
          var nx = cx + DIRS[k].x, ny = cy + DIRS[k].y;
          if (isWall(nx, ny)) continue;
          var ni = ny * N + nx;
          if (d[ni] >= 0) continue;
          d[ni] = d[c] + 1; q.push(ni);
        }
      }
      return d;
    }
    function headDists() { return [distFrom(S.snakes[0].body[0]), distFrom(S.snakes[1].body[0])]; }
    function nearHead(x, y, r) {
      for (var i = 0; i < 2; i++) { var h = S.snakes[i].body[0]; if (Math.abs(h.x - x) + Math.abs(h.y - y) <= r) return true; }
      return false;
    }

    /* New food: a free cell, not next to a head, and (when there is one) about as near to one snake as the other. */
    function spawnFood() {
      var D = headDists(), fair = [], any = [];
      for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
        if (!open(x, y) || nearHead(x, y, T.minFoodDist - 1) || coreAt(x, y)) continue;
        var i = y * N + x, a = D[0][i], b = D[1][i];
        if (a < 0 || b < 0) continue;                                 // a sealed-off pocket
        any.push({ x: x, y: y });
        if (Math.abs(a - b) <= T.fairSpawn) fair.push({ x: x, y: y });
      }
      var pool = fair.length ? fair : any;
      if (!pool.length) return null;
      var c = pool[Math.floor(rng() * pool.length)];
      S.foods.push(c);
      return c;
    }
    function relocate(x, y) {
      var i = foodAt(x, y);
      if (i < 0) return;
      S.foods.splice(i, 1);
      spawnFood();
    }

    /* What events can see and do. Only public board facts. */
    var env = {
      size: N, step: STEP, rng: rng, mirror: Maps.mirror,
      get tick() { return S.tick; },
      isWall: isWall, segAt: segAt, open: open, nearHead: nearHead, relocate: relocate, emit: emit,
      spawnZone: function (x, y) { return nearHead(x, y, 4); },
      noSpawnOther: function (x, y) { return foodAt(x, y) >= 0; },
      headDist: function (x, y) { var D = headDists(), i = y * N + x; return [D[0][i] < 0 ? 999 : D[0][i], D[1][i] < 0 ? 999 : D[1][i]]; }
    };

    /* ---------- one tick ---------- */
    function validDir(s, d) {
      if (!d || Math.abs(d.x) + Math.abs(d.y) !== 1) return s.dir;
      if (d.x === -s.dir.x && d.y === -s.dir.y) return s.dir;         // no reversing into the neck
      return { x: d.x, y: d.y };
    }

    function step() {
      S.tick++;
      S.elapsed += STEP;
      if (S.eventPhase === 'pending' && S.tick >= announceTick) {
        S.event = Events.create(S.eventId);
        S.eventPhase = 'announce';
        emit('announce', { event: S.eventId, name: S.event.name, tag: S.event.tag });
      }
      if (S.eventPhase === 'announce' && S.tick >= eventTick) {
        S.eventPhase = 'live';
        S.event.begin(env);
        emit('eventStart', { event: S.eventId });
      }
      if (live()) S.event.tick(env);

      var snakes = S.snakes, crash = [null, null];
      // 1. a warning that ran out under a head
      for (var i = 0; i < 2; i++) { var h0 = snakes[i].body[0], l0 = lethal(h0.x, h0.y); if (l0) crash[i] = l0; }
      var stuck = [!!crash[0], !!crash[1]];

      // 2. moves
      var dirs = [0, 1].map(function (k) {
        var c = controllers[k], d = c && c.next ? c.next(api, k) : null;
        return validDir(snakes[k], d);
      });

      // 3. where each head goes
      var land = [null, null], grows = [snakes[0].grow > 0, snakes[1].grow > 0], ported = [false, false];
      for (i = 0; i < 2; i++) {
        if (crash[i]) continue;
        var h = snakes[i].body[0], nx = h.x + dirs[i].x, ny = h.y + dirs[i].y;
        if (isWall(nx, ny)) { crash[i] = 'wall'; continue; }
        var p = portalAt(nx, ny);
        if (p) {
          if (!p.open) { crash[i] = 'portal'; continue; }
          nx = p.exit.x; ny = p.exit.y; ported[i] = true;
        }
        var lz = lethal(nx, ny);
        if (lz) { crash[i] = lz; land[i] = { x: nx, y: ny }; continue; }
        land[i] = { x: nx, y: ny };
        grows[i] = foodAt(nx, ny) >= 0 || coreAt(nx, ny) || snakes[i].grow > 0;
      }

      // 4. bodies (tails leave unless growing; a snake hit in step 1 does not move, so its whole body stays)
      function occupied(x, y) {
        for (var j = 0; j < 2; j++) {
          var b = snakes[j].body, n = (grows[j] || stuck[j]) ? b.length : b.length - 1;
          for (var k = 0; k < n; k++) if (b[k].x === x && b[k].y === y) return j;
        }
        return -1;
      }
      for (i = 0; i < 2; i++) {
        if (!land[i] || crash[i]) continue;
        var who = occupied(land[i].x, land[i].y);
        if (who >= 0) crash[i] = who === i ? 'tail' : 'body';
      }
      if (land[0] && land[1] && !crash[0] && !crash[1] && land[0].x === land[1].x && land[0].y === land[1].y) {
        crash[0] = crash[1] = 'headon';
      }

      // 5. survivors move and eat
      for (i = 0; i < 2; i++) {
        var s = snakes[i];
        if (crash[i]) continue;
        var L = land[i];
        s.body.unshift({ x: L.x, y: L.y });
        s.dir = dirs[i];
        s.ported = ported[i];
        if (ported[i]) emit('portal', { who: i, x: L.x, y: L.y });
        var fi = foodAt(L.x, L.y);
        if (fi >= 0) {
          S.foods.splice(fi, 1);
          s.score += T.foodPoints; s.foods++;
          emit('food', { who: i, x: L.x, y: L.y, points: T.foodPoints });
        } else if (coreAt(L.x, L.y)) {
          var pts = S.event.takeCore(env);
          s.score += pts; s.cores++; s.grow += T.coreGrow;
          emit('core', { who: i, x: L.x, y: L.y, points: pts });
        } else if (s.grow > 0) {
          s.grow--;
        } else {
          s.body.pop();
        }
      }
      while (S.foods.length < T.foods && spawnFood()) {}
      if (live()) S.event.after(env);

      // the round's end
      var dead = [!!crash[0], !!crash[1]];
      for (i = 0; i < 2; i++) if (dead[i]) {
        snakes[i].alive = false; snakes[i].reason = crash[i];
        emit('crash', { who: i, reason: crash[i], x: (land[i] || snakes[i].body[0]).x, y: (land[i] || snakes[i].body[0]).y });
      }
      if (dead[0] || dead[1]) {
        if (dead[0] && dead[1]) {
          var a = snakes[0].score, b = snakes[1].score;
          finish(a === b ? -1 : (a > b ? 0 : 1), crash[0] === 'headon' ? 'headon' : 'double');
        } else finish(dead[0] ? 1 : 0, 'crash');
        return;
      }
      if (!S.overtime) {
        S.timeLeft = Math.max(0, S.timeLeft - STEP);
        if (S.timeLeft <= 0) {
          var s0 = snakes[0].score, s1 = snakes[1].score;
          if (s0 !== s1) { finish(s0 > s1 ? 0 : 1, 'time'); return; }
          S.overtime = true; S.otLeft = T.overtimeMs; otBase = [s0, s1];
          emit('overtime', {});
        }
      } else {
        var g0 = snakes[0].score - otBase[0], g1 = snakes[1].score - otBase[1];
        if (g0 !== g1) { finish(g0 > g1 ? 0 : 1, 'overtime'); return; }
        S.otLeft = Math.max(0, S.otLeft - STEP);
        if (S.otLeft <= 0) { finish(-1, 'time'); return; }
      }
    }

    function finish(winner, reason) {
      if (S.phase === 'over') return;
      S.phase = 'over';
      S.result = { winner: winner, draw: winner < 0, reason: reason, scores: [S.snakes[0].score, S.snakes[1].score],
                   crashes: [S.snakes[0].reason, S.snakes[1].reason], ticks: S.tick, overtime: S.overtime };
      emit('over', Object.assign({}, S.result));
    }

    function update(dt) {
      if (S.phase !== 'running') return;
      S.acc += Math.min(Math.max(+dt || 0, 0), T.maxDt);
      var n = 0;
      while (S.acc >= STEP && S.phase === 'running' && n < 5) { S.acc -= STEP; step(); n++; }
    }
    function start() { if (S.phase !== 'ready') return; S.phase = 'running'; S.acc = 0; emit('start'); }
    function pause() { if (S.phase !== 'running') return; S.phase = 'paused'; emit('pause'); }
    function resume() { if (S.phase !== 'paused') return; S.phase = 'running'; S.acc = 0; emit('resume'); }

    var api = {
      state: S, tuning: T, size: N,
      on: function (fn) { listeners.push(fn); },
      start: start, pause: pause, resume: resume, update: update,
      tick: function () { if (S.phase === 'running') step(); },        // one tick at once (tests)
      isWall: isWall, segAt: segAt, lethal: lethal, warn: warn, portalAt: portalAt, coreAt: coreAt, foodAt: foodAt,
      eventView: function () { return live() ? S.event.view(env) : null; },
      eventStatus: function () { return live() ? S.event.status(env) : ''; },
      timeLeft: function () { return S.overtime ? S.otLeft : S.timeLeft; }
    };

    while (S.foods.length < T.foods && spawnFood()) {}
    controllers.forEach(function (c, i) { if (c && c.bind) c.bind(api, i); });
    return api;
  }

  return { TUNING: TUNING, DIRS: DIRS, seededRng: seededRng, humanController: humanController, createRound: createRound };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeDuel;
