/* Grid Snake engine
 * Pure game rules. No DOM, no timers, and no global randomness: time only moves when
 * update(dt) is called, and random numbers come from opts.rng. That makes pausing a
 * matter of not calling update(), and makes every rule testable in Node.
 */
var SnakeEngine = (function () {
  'use strict';

  /* Every difficulty number lives here, so balance changes happen in one place. */
  var TUNING = {
    cols: 20,
    rows: 20,
    maxDt: 100,          // longest slice of real time one update() will use (ms)
    minInterval: 60,     // fastest allowed step, after any effect (ms per cell)
    maxInterval: 260,    // slowest allowed step (ms per cell)
    // Classic keeps the original rule: speed rises with every point. Level is only a progress marker.
    classic:    { start: 150, step: 4, floor: 65, foodsPerLevel: 5 },
    // Time Attack: speed steps up once per level, one level every few foods.
    timeattack: { duration: 60000, start: 135, step: 7, floor: 80, foodsPerLevel: 4 },
    // Survival: a level every levelMs of play. Each level is faster and adds obstacles.
    survival:   { start: 140, step: 8, floor: 80, levelMs: 20000,
                  obstaclesPerLevel: 1, maxObstacles: 10, clearance: 6, lookahead: 8 },
    // Golden apple (optional, off by default): after every Nth point a golden apple appears and waits
    // `lifetime` ms. Eating it adds `balls` golden segments and `points` to the score. Those points do
    // not count towards the next apple: only points from normal food and pick-ups do.
    golden: { every: 10, balls: 5, points: 5, lifetime: 5000 },
    // Power-ups (Time Attack and Survival only). One pick-up on the board at a time.
    power: {
      everyFoods: 3,        // a pick-up appears after every Nth food
      lifetime: 8000,       // how long a pick-up waits on the board (ms of game time)
      bonusLifetime: 6000,
      effectMs: 5000,       // Speed Boost and Slow Motion duration
      boostMult: 0.72,      // step time multiplier while boosted (lower is faster)
      slowMult: 1.5,        // step time multiplier during slow motion
      boostFoodMult: 2,     // points per food while boosted
      bonusPoints: 5,
      weights: { boost: 3, slow: 2, bonus: 3, shield: 2 }
    }
  };

  var MODES = {
    classic:    { id: 'classic',    label: 'Classic',     timed: false, powerups: false, obstacles: false },
    timeattack: { id: 'timeattack', label: 'Time Attack', timed: true,  powerups: true,  obstacles: false },
    survival:   { id: 'survival',   label: 'Survival',    timed: false, powerups: true,  obstacles: true  }
  };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function tune(over) {
    var out = {};
    Object.keys(TUNING).forEach(function (k) {
      var v = TUNING[k];
      out[k] = (v && typeof v === 'object') ? Object.assign({}, v) : v;
    });
    if (over) {
      Object.keys(over).forEach(function (k) {
        if (over[k] && typeof over[k] === 'object' && out[k] && typeof out[k] === 'object') Object.assign(out[k], over[k]);
        else out[k] = over[k];
      });
    }
    return out;
  }

  function create(opts) {
    opts = opts || {};
    var mode = MODES[opts.mode] ? opts.mode : 'classic';
    var M = MODES[mode];
    var edge = opts.edge === 'wrap' ? 'wrap' : 'walls';
    var T = tune(opts.tuning);
    var rng = opts.rng || Math.random;
    var golden = !!opts.golden;
    var COLS = T.cols, ROWS = T.rows;
    var listeners = [];
    if (opts.onEvent) listeners.push(opts.onEvent);

    var cx = Math.floor(COLS / 2), cy = Math.floor(ROWS / 2);
    var S = {
      mode: mode, edge: edge, cols: COLS, rows: ROWS,
      phase: 'ready', reason: null,
      snake: [{ x: cx, y: cy }, { x: cx - 1, y: cy }, { x: cx - 2, y: cy }, { x: cx - 3, y: cy }],
      dir: { x: 1, y: 0 }, queue: [],
      food: null, obstacles: [],
      pickup: null, effect: null, shield: false, sincePickup: 0,
      gold: null, goldNext: T.golden.every, grow: 0, goldSegs: [false, false, false, false], goldEaten: 0, goldPts: 0,
      score: 0, foods: 0, level: 1, maxLength: 4,
      bonusEaten: 0, shieldSaves: 0,
      elapsed: 0, timeLeft: M.timed ? T.timeattack.duration : null,
      acc: 0
    };

    /* Event payloads must not use the key "type": it holds the event name. */
    function emit(type, data) {
      var e = data || {};
      e.type = type;
      for (var i = 0; i < listeners.length; i++) listeners[i](e, S);
    }

    /* ---------- helpers ---------- */

    function randomFree(filter) {
      var taken = {}, i;
      for (i = 0; i < S.snake.length; i++) taken[S.snake[i].x + ',' + S.snake[i].y] = 1;
      for (i = 0; i < S.obstacles.length; i++) taken[S.obstacles[i].x + ',' + S.obstacles[i].y] = 1;
      if (S.food) taken[S.food.x + ',' + S.food.y] = 1;
      if (S.pickup) taken[S.pickup.x + ',' + S.pickup.y] = 1;
      if (S.gold) taken[S.gold.x + ',' + S.gold.y] = 1;
      var free = [];
      for (var y = 0; y < ROWS; y++) {
        for (var x = 0; x < COLS; x++) {
          if (!taken[x + ',' + y] && (!filter || filter(x, y))) free.push({ x: x, y: y });
        }
      }
      return free.length ? free[Math.floor(rng() * free.length)] : null;
    }

    function obstacleAt(x, y) {
      for (var i = 0; i < S.obstacles.length; i++) if (S.obstacles[i].x === x && S.obstacles[i].y === y) return i;
      return -1;
    }

    function bodyAt(x, y, eating) {
      var n = eating ? S.snake.length : S.snake.length - 1;   // the tail moves away unless we grow
      for (var i = 0; i < n; i++) if (S.snake[i].x === x && S.snake[i].y === y) return true;
      return false;
    }

    /* ---------- difficulty ---------- */

    function levelFor() {
      if (mode === 'survival') return 1 + Math.floor(S.elapsed / T.survival.levelMs);
      var per = (mode === 'timeattack' ? T.timeattack : T.classic).foodsPerLevel;
      return 1 + Math.floor(S.foods / per);
    }

    function baseInterval() {
      if (mode === 'classic') return Math.max(T.classic.floor, T.classic.start - S.score * T.classic.step);
      var c = mode === 'timeattack' ? T.timeattack : T.survival;
      return Math.max(c.floor, c.start - (S.level - 1) * c.step);
    }

    function interval() {
      var m = 1;
      if (S.effect) m = S.effect.type === 'boost' ? T.power.boostMult : T.power.slowMult;
      return clamp(Math.round(baseInterval() * m), T.minInterval, T.maxInterval);
    }

    function addObstacles(n) {
      var V = T.survival, added = 0;
      for (var k = 0; k < n && S.obstacles.length < V.maxObstacles; k++) {
        var head = S.snake[0];
        var cell = randomFree(function (x, y) {
          if (Math.abs(x - head.x) + Math.abs(y - head.y) < V.clearance) return false;
          if (S.dir.x !== 0 && y === head.y) {
            var ax = ((x - head.x) * S.dir.x + COLS) % COLS;
            if (ax > 0 && ax <= V.lookahead) return false;
          }
          if (S.dir.y !== 0 && x === head.x) {
            var ay = ((y - head.y) * S.dir.y + ROWS) % ROWS;
            if (ay > 0 && ay <= V.lookahead) return false;
          }
          for (var i = 0; i < S.obstacles.length; i++) {
            if (Math.abs(S.obstacles[i].x - x) + Math.abs(S.obstacles[i].y - y) <= 1) return false;
          }
          return true;
        });
        if (!cell) break;
        S.obstacles.push(cell);
        added++;
      }
      return added;
    }

    function checkLevel() {
      var lv = levelFor();
      while (S.level < lv) {
        S.level++;
        var added = M.obstacles ? addObstacles(T.survival.obstaclesPerLevel) : 0;
        emit('level', { level: S.level, obstacles: added });
      }
    }

    /* ---------- one step of the snake ---------- */

    function finish(reason) {
      if (S.phase === 'over') return;
      S.phase = 'over';
      S.reason = reason;
      emit('over', { reason: reason });
    }

    /* The Shield absorbs one fatal hit. A wall wraps you to the far side, an obstacle is smashed,
       and your own tail lets you pass through. Whatever is in the landing cell is handled the same way. */
    function absorb(hit, nx, ny) {
      if (!S.shield) return false;
      S.shield = false;
      S.shieldSaves++;
      var i = obstacleAt(nx, ny);
      if (i >= 0) S.obstacles.splice(i, 1);
      emit('shield', { hit: hit, x: nx, y: ny, smashed: i >= 0 });
      return true;
    }

    function pickType() {
      var W = T.power.weights, types = [], total = 0;
      Object.keys(W).forEach(function (k) {
        if (k === 'shield' && S.shield) return;          // never offer a second shield
        if (W[k] > 0) { types.push(k); total += W[k]; }
      });
      if (!types.length) return null;
      var r = rng() * total;
      for (var i = 0; i < types.length; i++) {
        r -= W[types[i]];
        if (r < 0) return types[i];
      }
      return types[types.length - 1];
    }

    function maybeSpawnPickup() {
      S.sincePickup++;
      if (S.pickup || S.sincePickup < T.power.everyFoods) return;
      var type = pickType();
      var cell = type ? randomFree() : null;
      if (!cell) return;
      S.sincePickup = 0;
      var life = type === 'bonus' ? T.power.bonusLifetime : T.power.lifetime;
      S.pickup = { type: type, x: cell.x, y: cell.y, ttl: life, life: life };
      emit('pickupSpawn', { kind: type, x: cell.x, y: cell.y });
    }

    function collect() {
      var p = S.pickup, P = T.power, points = 0;
      S.pickup = null;
      if (p.type === 'boost' || p.type === 'slow') {
        S.effect = { type: p.type, remaining: P.effectMs, total: P.effectMs };   // a new speed effect replaces the old one
      } else if (p.type === 'shield') {
        S.shield = true;
      } else {
        points = P.bonusPoints;
        S.score += points;
        S.bonusEaten++;
      }
      emit('pickup', { kind: p.type, points: points, x: p.x, y: p.y });
      if (points) checkGold();
    }

    /* ---------- golden apple ---------- */

    function checkGold() {
      var G = T.golden, base = S.score - S.goldPts;                  // golden points do not count
      if (!golden || S.phase === 'over' || base < S.goldNext) return;
      S.goldNext = (Math.floor(base / G.every) + 1) * G.every;       // one apple per crossing, never queued
      if (S.gold) return;
      var cell = randomFree();
      if (!cell) return;
      S.gold = { x: cell.x, y: cell.y, ttl: G.lifetime, life: G.lifetime };
      emit('goldSpawn', { x: cell.x, y: cell.y });
    }

    function eatGold(x, y) {
      var G = T.golden;
      S.gold = null;
      S.score += G.points;
      S.goldPts += G.points;
      S.goldEaten++;
      S.grow += G.balls - 1;                  // this step already adds the first ball
      emit('gold', { x: x, y: y, points: G.points, balls: G.balls });
      checkGold();
    }

    function eat(x, y) {
      var pts = (S.effect && S.effect.type === 'boost') ? T.power.boostFoodMult : 1;
      S.score += pts;
      S.foods++;
      emit('food', { points: pts, x: x, y: y });
      S.food = randomFree();
      if (!S.food) { finish('cleared'); return; }
      if (mode !== 'survival') checkLevel();
      if (M.powerups) maybeSpawnPickup();
      checkGold();
    }

    function step() {
      if (S.queue.length) S.dir = S.queue.shift();
      var head = S.snake[0];
      var nx = head.x + S.dir.x, ny = head.y + S.dir.y;
      var crossed = nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS;
      if (crossed) { nx = (nx + COLS) % COLS; ny = (ny + ROWS) % ROWS; }
      var hit = (crossed && edge === 'walls') ? 'wall' : null;
      var eating = !!S.food && nx === S.food.x && ny === S.food.y;
      var goldHit = !!S.gold && nx === S.gold.x && ny === S.gold.y;
      var growing = eating || goldHit || S.grow > 0;           // the tail stays put while the snake grows
      if (!hit) {
        if (obstacleAt(nx, ny) >= 0) hit = 'obstacle';
        else if (bodyAt(nx, ny, growing)) hit = 'tail';
      }
      if (hit && !absorb(hit, nx, ny)) { finish(hit); return; }
      S.snake.unshift({ x: nx, y: ny });
      if (growing) S.goldSegs.push(goldHit || (!eating && S.grow > 0));   // new segments are added at the tail end
      if (!eating && !goldHit && S.grow > 0) S.grow--;
      if (eating) {
        eat(nx, ny);
        if (S.phase === 'over') return;
      } else if (!growing) {
        S.snake.pop();
      }
      if (goldHit) eatGold(nx, ny);
      if (S.snake.length > S.maxLength) S.maxLength = S.snake.length;
      if (S.pickup && S.pickup.x === nx && S.pickup.y === ny) collect();
    }

    /* ---------- time ---------- */

    function tickTimers(dt) {
      S.elapsed += dt;
      if (M.timed) S.timeLeft = Math.max(0, S.timeLeft - dt);
      if (M.powerups) {
        if (S.pickup) {
          S.pickup.ttl -= dt;
          if (S.pickup.ttl <= 0) { var gone = S.pickup; S.pickup = null; emit('pickupExpire', { kind: gone.type }); }
        }
        if (S.effect) {
          S.effect.remaining -= dt;
          if (S.effect.remaining <= 0) { var ended = S.effect.type; S.effect = null; emit('effectEnd', { effect: ended }); }
        }
      }
      if (S.gold) {
        S.gold.ttl -= dt;
        if (S.gold.ttl <= 0) { S.gold = null; emit('goldExpire', {}); }
      }
      if (mode === 'survival') checkLevel();
    }

    function update(dt) {
      if (S.phase !== 'running') return;
      dt = Math.min(Math.max(dt || 0, 0), T.maxDt);
      if (M.timed) dt = Math.min(dt, S.timeLeft);
      tickTimers(dt);
      S.acc += dt;
      var iv = interval(), n = 0;
      while (S.acc >= iv && S.phase === 'running' && n < 5) {
        S.acc -= iv;
        step();
        iv = interval();
        n++;
      }
      if (S.phase === 'running' && M.timed && S.timeLeft <= 0) finish('time');
    }

    /* ---------- control ---------- */

    function turn(dx, dy) {
      if (S.phase === 'over') return false;
      var last = S.queue.length ? S.queue[S.queue.length - 1] : S.dir;
      if (last.x === dx && last.y === dy) return false;       // already heading that way
      if (last.x === -dx && last.y === -dy) return false;     // a direct reversal would hit the neck
      if (S.queue.length < 2) S.queue.push({ x: dx, y: dy });
      return true;
    }

    function start() {
      if (S.phase !== 'ready') return;
      S.phase = 'running';
      S.acc = 0;
      emit('start');
    }
    function pause() {
      if (S.phase !== 'running') return;
      S.phase = 'paused';
      emit('pause');
    }
    function resume() {
      if (S.phase !== 'paused') return;
      S.phase = 'running';
      S.acc = 0;
      emit('resume');
    }

    function snapshot() {
      return {
        mode: mode, edge: edge, phase: S.phase, reason: S.reason,
        score: S.score, foods: S.foods, level: S.level,
        length: S.snake.length, maxLength: S.maxLength,
        elapsed: S.elapsed, timeLeft: S.timeLeft,
        bonusEaten: S.bonusEaten, shieldSaves: S.shieldSaves, goldEaten: S.goldEaten
      };
    }

    S.food = randomFree();

    return {
      state: S, mode: mode, edge: edge, golden: golden, tuning: T,
      on: function (fn) { listeners.push(fn); },
      start: start, pause: pause, resume: resume,
      turn: turn, update: update, interval: interval, snapshot: snapshot
    };
  }

  return { TUNING: TUNING, MODES: MODES, create: create };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeEngine;
