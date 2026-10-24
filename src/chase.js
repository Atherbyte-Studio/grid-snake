/* Grid Snake: Apple Run
 * A comic chase mode. You are the apple; an AI snake hunts you. No DOM, no timers, no global
 * randomness: time only moves when update(dt) is called, random numbers come from opts.rng.
 * The surface matches SnakeEngine (state, on, start, pause, resume, turn, update, interval, snapshot)
 * so the page and the profile/achievement code can treat both the same way.
 *
 * Rules in short
 *  - The apple runs in the direction you choose and never stops. It cannot pass through the snake's
 *    body or (with Walls) the edge: it just bonks and loses a step. Only the snake's HEAD catches it.
 *  - Dash: a burst of speed, then a cooldown.
 *  - Items appear on the board; the apple carries one at a time and drops it with useItem():
 *      peel  - the snake slides three cells and is dizzy afterwards
 *      decoy - a fake apple; the snake goes for it, bites it, and is dizzy
 *  - The snake finds a path to the apple, but it is not very bright: it sometimes wanders off, and it
 *    can tie itself in a knot. It also gets faster and longer as the run goes on.
 *  - Score: one point per second survived, plus bonuses for slips, fooled bites and knots.
 */
var SnakeChase = (function () {
  'use strict';

  var TUNING = {
    cols: 20, rows: 20,
    maxDt: 100,
    chase: {
      appleStep: 150, dashStep: 70, dashMs: 700, dashCooldown: 4500,
      snakeStart: 175, snakeStep: 10, snakeFloor: 95, levelMs: 12000,
      snakeLen: 5, growEveryMs: 8000, maxLen: 22,
      dumbStart: 0.2, dumbStep: 0.03, dumbFloor: 0.03, wanderSteps: 3,
      stunPeel: 2000, stunDecoy: 2200, stunKnot: 1600,
      slideCells: 3, slideStep: 55,
      itemEveryMs: 6000, itemLife: 9000, decoyMs: 5000, peelMs: 20000, maxPeels: 3,
      itemDistance: 4,
      scorePerSecond: 1, slipPoints: 5, foolPoints: 10, knotPoints: 5
    }
  };

  /* Difficulty overrides for Apple Run (pass as opts.tuning). Hard is the original. A slower, less clever snake is easier. */
  var DIFFICULTY = {
    easy:   { chase: { snakeStart: 205, snakeStep: 8, snakeFloor: 125, dumbStart: 0.3, dumbStep: 0.03, dumbFloor: 0.08 } },
    normal: { chase: { snakeStart: 190, snakeStep: 9, snakeFloor: 108, dumbStart: 0.25, dumbStep: 0.03, dumbFloor: 0.05 } },
    hard:   {}
  };

  var DIRS = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function tune(over) {
    var out = JSON.parse(JSON.stringify(TUNING));
    if (over) Object.keys(over).forEach(function (k) {
      if (over[k] && typeof over[k] === 'object' && out[k] && typeof out[k] === 'object') Object.assign(out[k], over[k]);
      else out[k] = over[k];
    });
    return out;
  }

  function create(opts) {
    opts = opts || {};
    var edge = opts.edge === 'wrap' ? 'wrap' : 'walls';
    var T = tune(opts.tuning), C = T.chase;
    var rng = opts.rng || Math.random;
    var COLS = T.cols, ROWS = T.rows;
    var listeners = [];
    if (opts.onEvent) listeners.push(opts.onEvent);

    var apple = { x: 14, y: 15 };
    var S = {
      mode: 'chase', edge: edge, cols: COLS, rows: ROWS,
      phase: 'ready', reason: null,
      apple: apple, food: apple, appleDir: { x: -1, y: 0 }, applePrev: { x: 14, y: 15 },
      snake: [], dir: { x: 1, y: 0 }, snakePrev: [],
      peels: [], decoy: null, pickup: null, item: null,
      dashLeft: 0, dashCd: 0, stun: 0, slideLeft: 0, stunAfterSlide: 0, wanderLeft: 0,
      appleT: 0, snakeT: 0, itemT: 0, nearCd: 0,
      score: 0, foods: 0, level: 1, maxLength: C.snakeLen, elapsed: 0, nextSecond: 1000,
      obstacles: [], goldSegs: [], gold: null, effect: null, shield: false, timeLeft: null,
      bonusEaten: 0, shieldSaves: 0, goldEaten: 0,
      slips: 0, fooled: 0, knots: 0, dashes: 0, bonks: 0, itemsUsed: 0
    };
    for (var i = 0; i < C.snakeLen; i++) S.snake.push({ x: 5 - i, y: 3 });
    S.snakePrev = S.snake.map(function (q) { return { x: q.x, y: q.y }; });

    function emit(type, data) {
      var e = data || {};
      e.type = type;
      for (var k = 0; k < listeners.length; k++) listeners[k](e, S);
    }
    function quip(who, key) { emit('quip', { who: who, key: key }); }

    /* ---------- grid helpers ---------- */

    function step(x, y, d) {                              // the cell one step away, or null past a wall
      var nx = x + d.x, ny = y + d.y;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) {
        if (edge === 'walls') return null;
        nx = (nx + COLS) % COLS; ny = (ny + ROWS) % ROWS;
      }
      return { x: nx, y: ny };
    }
    function same(a, b) { return a && b && a.x === b.x && a.y === b.y; }
    function snakeAt(x, y, skipTail) {
      var n = skipTail ? S.snake.length - 1 : S.snake.length;
      for (var k = 0; k < n; k++) if (S.snake[k].x === x && S.snake[k].y === y) return k;
      return -1;
    }
    function peelAt(x, y) {
      for (var k = 0; k < S.peels.length; k++) if (S.peels[k].x === x && S.peels[k].y === y) return k;
      return -1;
    }
    function wrapDist(a, b) {
      var dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
      if (edge === 'wrap') { dx = Math.min(dx, COLS - dx); dy = Math.min(dy, ROWS - dy); }
      return dx + dy;
    }

    /* ---------- tuning curves ---------- */

    function snakeInterval() {
      if (S.slideLeft > 0) return C.slideStep;
      return clamp(Math.max(C.snakeFloor, C.snakeStart - (S.level - 1) * C.snakeStep), 60, 400);
    }
    function appleInterval() { return clamp(S.dashLeft > 0 ? C.dashStep : C.appleStep, 40, 400); }
    function dumbChance() { return Math.max(C.dumbFloor, C.dumbStart - (S.level - 1) * C.dumbStep); }
    function targetLength() { return Math.min(C.maxLen, C.snakeLen + Math.floor(S.elapsed / C.growEveryMs)); }

    function addScore(n, why) {
      if (!n) return;
      S.score += n;
      emit('score', { score: S.score, points: n, why: why });
    }
    function finish(reason) {
      if (S.phase === 'over') return;
      S.phase = 'over';
      S.reason = reason;
      emit('over', { reason: reason });
    }

    /* ---------- the apple ---------- */

    function stepApple() {
      S.applePrev = { x: apple.x, y: apple.y };
      var n = step(apple.x, apple.y, S.appleDir);
      if (!n) { S.bonks++; emit('bonk', { x: apple.x, y: apple.y }); quip('apple', 'bonk'); return; }
      if (same(n, S.snake[0])) { apple.x = n.x; apple.y = n.y; finish('caught'); quip('snake', 'caught'); return; }
      if (snakeAt(n.x, n.y, false) >= 0) { S.bonks++; emit('bonk', { x: apple.x, y: apple.y }); quip('apple', 'bonk'); return; }
      apple.x = n.x; apple.y = n.y;
      if (S.pickup && same(S.pickup, apple) && !S.item) {
        var p = S.pickup;
        S.item = p.type;
        S.pickup = null;
        emit('pickup', { kind: p.type, x: p.x, y: p.y });
        quip('apple', 'pickup');
      }
    }

    /* ---------- the snake ---------- */

    function target() { return S.decoy || apple; }

    /* Shortest way to the target, going round its own body. Returns a direction or null.
       The search starts at the target, so among equally short ways the snake keeps going straight. */
    function pathDir() {
      var head = S.snake[0], goal = target(), growing = S.snake.length < targetLength();
      var dist = {}, queue = [{ x: goal.x, y: goal.y }], qi = 0;
      dist[goal.x + ',' + goal.y] = 0;
      while (qi < queue.length) {
        var cur = queue[qi++], cd = dist[cur.x + ',' + cur.y];
        for (var k = 0; k < 4; k++) {
          var n = step(cur.x, cur.y, DIRS[k]);
          if (!n) continue;
          var key = n.x + ',' + n.y;
          if (dist[key] !== undefined) continue;
          if (!(n.x === head.x && n.y === head.y) && snakeAt(n.x, n.y, !growing) >= 0) continue;
          dist[key] = cd + 1;
          queue.push(n);
        }
      }
      var best = null, bestD = 1e9, start = dirIndex(S.dir);
      for (var m = 0; m < 4; m++) {
        var d = DIRS[(m + start) % 4], nn = step(head.x, head.y, d);
        if (!nn || snakeAt(nn.x, nn.y, !growing) >= 0) continue;
        var dd = dist[nn.x + ',' + nn.y];
        if (dd !== undefined && dd < bestD) { bestD = dd; best = d; }
      }
      return best;
    }
    function dirIndex(d) { for (var k = 0; k < 4; k++) if (DIRS[k].x === d.x && DIRS[k].y === d.y) return k; return 0; }

    function safeDirs() {
      var head = S.snake[0], growing = S.snake.length < targetLength(), out = [];
      DIRS.forEach(function (d) {
        var n = step(head.x, head.y, d);
        if (n && snakeAt(n.x, n.y, !growing) < 0) out.push(d);
      });
      return out;
    }

    function chooseDir() {
      var safe = safeDirs();
      if (!safe.length) return null;
      if (S.wanderLeft > 0) { S.wanderLeft--; return safe[Math.floor(rng() * safe.length)]; }
      if (rng() < dumbChance()) {                                       // loses the plot for a few steps
        S.wanderLeft = C.wanderSteps - 1;
        quip('snake', 'wander');
        return safe[Math.floor(rng() * safe.length)];
      }
      var d = pathDir();
      if (d) return d;
      var goal = target(), best = null, bestD = 1e9;                    // no clear path: get as close as possible
      safe.forEach(function (c) {
        var n = step(S.snake[0].x, S.snake[0].y, c), dd = wrapDist(n, goal);
        if (dd < bestD) { bestD = dd; best = c; }
      });
      return best;
    }

    function tieKnot() {                                                // no way forward: it turns round, dizzy
      S.knots++;
      S.snake.reverse();
      var a = S.snake[0], b = S.snake[1] || { x: a.x - 1, y: a.y };
      var dx = a.x - b.x, dy = a.y - b.y;
      S.dir = { x: Math.abs(dx) > 1 ? -Math.sign(dx) : Math.sign(dx), y: Math.abs(dy) > 1 ? -Math.sign(dy) : Math.sign(dy) };
      S.stun = C.stunKnot;
      S.snakeT = 0;
      emit('knot', { x: a.x, y: a.y });
      quip('snake', 'knot');
      addScore(C.knotPoints, 'knot');
    }

    function stepSnake() {
      S.snakePrev = S.snake.map(function (q) { return { x: q.x, y: q.y }; });
      var d;
      if (S.slideLeft > 0) {                                            // skidding on a peel: no steering
        d = S.dir;
      } else {
        d = chooseDir();
        if (!d) { tieKnot(); return; }
      }
      var head = S.snake[0], n = step(head.x, head.y, d);
      if (!n || snakeAt(n.x, n.y, S.snake.length >= targetLength()) >= 0) {
        if (S.slideLeft > 0) { S.slideLeft = 0; S.stun = S.stunAfterSlide; }   // the slide ends against something
        else tieKnot();
        return;
      }
      S.dir = d;
      S.snake.unshift({ x: n.x, y: n.y });
      if (S.snake.length > targetLength()) S.snake.pop();                // grows only while shorter than its target
      if (S.snake.length > S.maxLength) S.maxLength = S.snake.length;

      if (same(n, apple)) { finish('caught'); quip('snake', 'caught'); return; }
      if (S.decoy && same(n, S.decoy)) {
        emit('fooled', { x: n.x, y: n.y });
        S.fooled++;
        S.decoy = null;
        S.stun = C.stunDecoy;
        S.snakeT = 0;
        quip('snake', 'fooled');
        addScore(C.foolPoints, 'fooled');
        return;
      }
      var pi = peelAt(n.x, n.y);
      if (pi >= 0 && S.slideLeft === 0) {
        S.peels.splice(pi, 1);
        S.slips++;
        S.slideLeft = C.slideCells;
        S.stunAfterSlide = C.stunPeel;
        emit('slip', { x: n.x, y: n.y });
        quip('snake', 'slip');
        addScore(C.slipPoints, 'slip');
        return;
      }
      if (S.slideLeft > 0) {
        S.slideLeft--;
        if (S.slideLeft === 0) { S.stun = S.stunAfterSlide; S.snakeT = 0; }
      }
    }

    /* ---------- items ---------- */

    function freeCell() {
      var free = [], head = S.snake[0];
      for (var y = 0; y < ROWS; y++) for (var x = 0; x < COLS; x++) {
        if (snakeAt(x, y, false) >= 0 || (x === apple.x && y === apple.y)) continue;
        if (peelAt(x, y) >= 0 || (S.decoy && S.decoy.x === x && S.decoy.y === y)) continue;
        if (wrapDist({ x: x, y: y }, head) < C.itemDistance) continue;
        free.push({ x: x, y: y });
      }
      return free.length ? free[Math.floor(rng() * free.length)] : null;
    }
    function spawnItem() {
      var cell = freeCell();
      if (!cell) return;
      var type = rng() < 0.55 ? 'peel' : 'decoy';
      S.pickup = { type: type, x: cell.x, y: cell.y, ttl: C.itemLife, life: C.itemLife };
      emit('itemSpawn', { kind: type, x: cell.x, y: cell.y });
    }

    function useItem() {
      if (S.phase !== 'running' || !S.item) return false;
      var kind = S.item;
      S.item = null;
      S.itemsUsed++;
      if (kind === 'peel') {
        if (S.peels.length >= C.maxPeels) S.peels.shift();
        S.peels.push({ x: apple.x, y: apple.y, ttl: C.peelMs, life: C.peelMs });
      } else {
        S.decoy = { x: apple.x, y: apple.y, ttl: C.decoyMs, life: C.decoyMs };
        S.wanderLeft = 0;
      }
      emit('use', { kind: kind, x: apple.x, y: apple.y });
      quip('apple', 'use');
      return true;
    }

    function dash() {
      if (S.phase !== 'running' || S.dashCd > 0 || S.dashLeft > 0) return false;
      S.dashLeft = C.dashMs;
      S.dashCd = C.dashCooldown;
      S.dashes++;
      emit('dash', { x: apple.x, y: apple.y });
      quip('apple', 'dash');
      return true;
    }

    /* ---------- time ---------- */

    function tickTimers(dt) {
      S.elapsed += dt;
      if (S.dashLeft > 0) S.dashLeft = Math.max(0, S.dashLeft - dt);
      if (S.dashCd > 0) S.dashCd = Math.max(0, S.dashCd - dt);
      if (S.nearCd > 0) S.nearCd = Math.max(0, S.nearCd - dt);
      if (S.stun > 0) {
        S.stun -= dt;
        if (S.stun <= 0) { S.stun = 0; S.snakeT = 0; quip('snake', 'recover'); }
      }
      if (S.decoy) { S.decoy.ttl -= dt; if (S.decoy.ttl <= 0) { S.decoy = null; emit('decoyExpire', {}); } }
      for (var k = S.peels.length - 1; k >= 0; k--) {
        S.peels[k].ttl -= dt;
        if (S.peels[k].ttl <= 0) { S.peels.splice(k, 1); emit('peelExpire', {}); }
      }
      if (S.pickup) {
        S.pickup.ttl -= dt;
        if (S.pickup.ttl <= 0) { var g = S.pickup; S.pickup = null; emit('itemExpire', { kind: g.type }); }
      } else {
        S.itemT += dt;
        if (S.itemT >= C.itemEveryMs) { S.itemT = 0; spawnItem(); }
      }
      while (S.elapsed >= S.nextSecond && S.phase === 'running') {
        S.nextSecond += 1000;
        addScore(C.scorePerSecond, 'time');
      }
      var lv = 1 + Math.floor(S.elapsed / C.levelMs);
      while (S.level < lv) { S.level++; emit('level', { level: S.level }); quip('snake', 'level'); }
      if (S.nearCd <= 0 && S.phase === 'running' && wrapDist(apple, S.snake[0]) <= 2 && S.stun <= 0) {
        S.nearCd = 3500;
        quip('apple', 'near');
      }
    }

    function update(dt) {
      if (S.phase !== 'running') return;
      dt = Math.min(Math.max(dt || 0, 0), T.maxDt);
      tickTimers(dt);
      S.appleT += dt;
      var iv = appleInterval(), n = 0;
      while (S.appleT >= iv && S.phase === 'running' && n < 6) { S.appleT -= iv; stepApple(); iv = appleInterval(); n++; }
      if (S.phase !== 'running') return;
      if (S.stun > 0) S.snakeT = 0; else S.snakeT += dt;
      iv = snakeInterval(); n = 0;
      while (S.snakeT >= iv && S.phase === 'running' && S.stun <= 0 && n < 6) { S.snakeT -= iv; stepSnake(); iv = snakeInterval(); n++; }
    }

    /* ---------- control ---------- */

    function turn(dx, dy) {
      if (S.phase === 'over') return false;
      if (Math.abs(dx) + Math.abs(dy) !== 1) return false;
      S.appleDir = { x: dx, y: dy };                                    // the apple has no neck: it may turn straight back
      return true;
    }
    function start() { if (S.phase !== 'ready') return; S.phase = 'running'; S.appleT = 0; S.snakeT = 0; emit('start'); quip('apple', 'start'); }
    function pause() { if (S.phase !== 'running') return; S.phase = 'paused'; emit('pause'); }
    function resume() { if (S.phase !== 'paused') return; S.phase = 'running'; emit('resume'); }

    function snapshot() {
      return {
        mode: 'chase', edge: edge, phase: S.phase, reason: S.reason,
        score: S.score, foods: 0, level: S.level, length: S.snake.length, maxLength: S.maxLength,
        elapsed: S.elapsed, timeLeft: null, bonusEaten: 0, shieldSaves: 0, goldEaten: 0,
        slips: S.slips, fooled: S.fooled, knots: S.knots, dashes: S.dashes
      };
    }

    return {
      state: S, mode: 'chase', edge: edge, golden: false, tuning: T,
      on: function (fn) { listeners.push(fn); },
      start: start, pause: pause, resume: resume, turn: turn, dash: dash, useItem: useItem,
      update: update, interval: snakeInterval, appleInterval: appleInterval, snapshot: snapshot
    };
  }

  return { TUNING: TUNING, DIFFICULTY: DIFFICULTY, create: create };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeChase;
