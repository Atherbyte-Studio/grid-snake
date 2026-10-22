'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../src/engine.js');

/* ---------- helpers ---------- */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/* Run the engine for `ms` of game time in 16 ms frames. Stops early when the run ends. */
function run(game, ms, frame) {
  frame = frame || 16;
  let t = 0;
  while (t < ms && game.state.phase === 'running') {
    const dt = Math.min(frame, ms - t);
    game.update(dt);
    t += dt;
  }
  return t;
}

/* Feed `ms` of game time in chunks no bigger than the engine's per-update cap. */
function feed(game, ms) {
  const cap = game.tuning.maxDt;
  while (ms > 0 && game.state.phase === 'running') {
    const d = Math.min(ms, cap);
    game.update(d);
    ms -= d;
  }
}
/* Advance exactly one snake step. */
function stepOnce(game) { feed(game, game.interval()); }

function make(opts) {
  const g = Engine.create(Object.assign({ rng: mulberry32(7) }, opts || {}));
  return g;
}

/* ---------- reference: the original Classic rules, copied from the pre-engine game ---------- */

function makeReference(rng, edge) {
  const COLS = 20, ROWS = 20;
  const S = {
    snake: [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }],
    dir: { x: 1, y: 0 }, queue: [], food: null, score: 0, phase: 'running', reason: null
  };
  function spawnFood() {
    const taken = {};
    S.snake.forEach(s => { taken[s.x + ',' + s.y] = 1; });
    const free = [];
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (!taken[x + ',' + y]) free.push({ x, y });
    return free.length ? free[Math.floor(rng() * free.length)] : null;
  }
  S.food = spawnFood();
  function interval() { return Math.max(65, 150 - S.score * 4); }
  function turn(dx, dy) {
    if (S.phase === 'over') return;
    const last = S.queue.length ? S.queue[S.queue.length - 1] : S.dir;
    if (last.x === dx && last.y === dy) return;
    if (last.x === -dx && last.y === -dy) return;
    if (S.queue.length < 2) S.queue.push({ x: dx, y: dy });
  }
  function step() {
    if (S.queue.length) S.dir = S.queue.shift();
    let nx = S.snake[0].x + S.dir.x, ny = S.snake[0].y + S.dir.y;
    if (edge === 'wrap') { nx = (nx + COLS) % COLS; ny = (ny + ROWS) % ROWS; }
    else if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) { S.phase = 'over'; S.reason = 'wall'; return; }
    const eating = S.food && nx === S.food.x && ny === S.food.y;
    const body = eating ? S.snake : S.snake.slice(0, -1);
    for (let i = 0; i < body.length; i++) if (body[i].x === nx && body[i].y === ny) { S.phase = 'over'; S.reason = 'tail'; return; }
    S.snake.unshift({ x: nx, y: ny });
    if (eating) {
      S.score++;
      S.food = spawnFood();
      if (!S.food) { S.phase = 'over'; S.reason = 'cleared'; return; }
    } else S.snake.pop();
  }
  return { S, turn, step, interval };
}

/* =====================================================================
   PHASE 1: engine core, and parity with the original Classic rules
   ===================================================================== */

test('P1 parity: engine matches the original Classic rules step for step (random play, both edge modes)', () => {
  let totalSteps = 0, totalScore = 0;
  for (const edge of ['walls', 'wrap']) {
    for (let seed = 1; seed <= 120; seed++) {
      const ref = makeReference(mulberry32(seed), edge);
      const eng = Engine.create({ mode: 'classic', edge, rng: mulberry32(seed) });
      eng.start();
      const pick = mulberry32(seed * 977);
      for (let i = 0; i < 4000 && ref.S.phase === 'running'; i++) {
        let d = null;
        const r = pick();
        if (r < 0.55) {            // steer toward the food most of the time, so runs get long
          const h = ref.S.snake[0], f = ref.S.food;
          const opts = [];
          if (f.x > h.x) opts.push([1, 0]); if (f.x < h.x) opts.push([-1, 0]);
          if (f.y > h.y) opts.push([0, 1]); if (f.y < h.y) opts.push([0, -1]);
          d = opts.length ? opts[Math.floor(pick() * opts.length)] : null;
        } else if (r < 0.7) d = DIRS[Math.floor(pick() * 4)];
        if (d) { ref.turn(d[0], d[1]); eng.turn(d[0], d[1]); }
        assert.equal(eng.interval(), ref.interval(), 'interval seed ' + seed);
        ref.step();
        stepOnce(eng);
        totalSteps++;
        const s = eng.state;
        assert.deepEqual(s.snake, ref.S.snake, 'snake seed ' + seed + ' step ' + i);
        assert.deepEqual(s.food, ref.S.food, 'food seed ' + seed);
        assert.deepEqual(s.dir, ref.S.dir);
        assert.deepEqual(s.queue, ref.S.queue);
        assert.equal(s.score, ref.S.score);
        assert.equal(s.phase, ref.S.phase, 'phase seed ' + seed + ' step ' + i);
        if (ref.S.phase === 'over') assert.equal(s.reason, ref.S.reason);
      }
      totalScore += ref.S.score;
    }
  }
  assert.ok(totalSteps > 5000, 'enough steps exercised: ' + totalSteps);
  assert.ok(totalScore > 200, 'the bot ate enough food to exercise growth: ' + totalScore);
});

test('P1 Classic speed curve is the original one for scores 0..60', () => {
  const g = make({ mode: 'classic' });
  for (let sc = 0; sc <= 60; sc++) {
    g.state.score = sc;
    assert.equal(g.interval(), Math.max(65, 150 - sc * 4));
  }
});

test('P1 direction input: duplicates and direct reversals are ignored, queue holds two turns', () => {
  const g = make();
  assert.equal(g.turn(1, 0), false, 'same direction');
  assert.equal(g.turn(-1, 0), false, 'reverse of current direction');
  assert.equal(g.turn(0, -1), true);
  assert.equal(g.turn(0, 1), false, 'reverse of the queued direction');
  assert.equal(g.turn(-1, 0), true, 'perpendicular to the queued direction is fine');
  assert.equal(g.turn(0, 1), true, 'valid, but queue is full so it is dropped');
  assert.deepEqual(g.state.queue, [{ x: 0, y: -1 }, { x: -1, y: 0 }]);
});

test('P1 a quick up-then-left double tap never lets the snake reverse into its neck', () => {
  const g = make({ edge: 'wrap' });
  g.start();
  g.turn(0, -1); g.turn(-1, 0);
  for (let i = 0; i < 6; i++) { stepOnce(g); assert.equal(g.state.phase, 'running'); }
});

test('P1 turning is ignored after the run is over', () => {
  const g = make();
  g.start(); g.state.snake[0].x = 19;
  stepOnce(g);
  assert.equal(g.state.phase, 'over');
  assert.equal(g.turn(0, 1), false);
});

test('P1 walls end the run; wrap does not', () => {
  const w = make({ edge: 'walls' }); w.start();
  for (let i = 0; i < 9; i++) stepOnce(w);
  assert.equal(w.state.phase, 'running');
  stepOnce(w);
  assert.equal(w.state.phase, 'over');
  assert.equal(w.state.reason, 'wall');

  const r = make({ edge: 'wrap' }); r.start();
  r.state.food = { x: 0, y: 0 };
  for (let i = 0; i < 25; i++) stepOnce(r);
  assert.equal(r.state.phase, 'running');
  assert.ok(r.state.snake[0].x >= 0 && r.state.snake[0].x < 20);
});

test('P1 self collision ends the run, but stepping into the cell the tail just left is allowed', () => {
  const g = make({ edge: 'wrap' }); g.start();
  g.state.snake = [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 5 }, { x: 7, y: 5 }, { x: 8, y: 5 }];
  g.state.dir = { x: 0, y: 1 }; g.state.queue = [];
  g.state.food = { x: 0, y: 0 };
  g.turn(1, 0);                    // head (5,5) -> (6,5): occupied by the body (not the tail)
  stepOnce(g);
  assert.equal(g.state.phase, 'over');
  assert.equal(g.state.reason, 'tail');

  const h = make({ edge: 'wrap' }); h.start();
  h.state.snake = [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 5 }];   // tail at (6,5)
  h.state.dir = { x: 0, y: 1 }; h.state.queue = []; h.state.food = { x: 0, y: 0 };
  h.turn(1, 0);                    // head moves to (6,5) as the tail leaves it
  stepOnce(h);
  assert.equal(h.state.phase, 'running');
});

test('P1 eating grows the snake by one, scores one point and respawns food on a free cell', () => {
  const g = make({ edge: 'wrap' }); g.start();
  g.state.food = { x: 11, y: 10 };
  stepOnce(g);
  assert.equal(g.state.score, 1);
  assert.equal(g.state.snake.length, 5);
  assert.ok(!g.state.snake.some(s => s.x === g.state.food.x && s.y === g.state.food.y));
});

test('P1 pause freezes the game and resume does not burst extra steps', () => {
  const g = make({ edge: 'wrap' }); g.start();
  feed(g, g.interval() - 1);
  g.pause();
  const before = JSON.stringify(g.state.snake);
  g.update(5000);
  assert.equal(JSON.stringify(g.state.snake), before);
  g.resume();
  assert.equal(g.state.acc, 0);
  feed(g, g.interval() - 1);
  assert.equal(JSON.stringify(g.state.snake), before, 'no step until a full interval has passed again');
  feed(g, 1);
  assert.notEqual(JSON.stringify(g.state.snake), before, 'and then it steps');
});

test('P1 a huge frame (tab was in the background) cannot skip many steps at once', () => {
  const g = make({ edge: 'wrap' }); g.start();
  const h0 = g.state.snake[0].x;
  g.update(60000);
  const moved = (g.state.snake[0].x - h0 + 20) % 20;
  assert.ok(moved <= 2, 'moved ' + moved);
});

test('P1 start only works from ready; resume only from paused', () => {
  const g = make();
  g.resume(); assert.equal(g.state.phase, 'ready');
  g.pause(); assert.equal(g.state.phase, 'ready');
  g.start(); assert.equal(g.state.phase, 'running');
  g.start(); assert.equal(g.state.phase, 'running');
  g.pause(); assert.equal(g.state.phase, 'paused');
  g.pause(); assert.equal(g.state.phase, 'paused');
  g.resume(); assert.equal(g.state.phase, 'running');
});

test('P1 two games never share state (a clean restart is just a new game)', () => {
  const a = make(), b = make();
  a.start(); a.state.score = 9;
  assert.equal(b.state.score, 0);
  assert.equal(b.state.phase, 'ready');
  assert.notEqual(a.state, b.state);
});

/* =====================================================================
   PHASE 2: game modes and levels
   ===================================================================== */

test('P2 unknown mode falls back to Classic; Classic has no clock, no obstacles', () => {
  const g = make({ mode: 'nope' });
  assert.equal(g.mode, 'classic');
  assert.equal(g.state.timeLeft, null);
  assert.deepEqual(g.state.obstacles, []);
});

test('P2 Classic level is a progress marker: 1 + floor(foods / 5), and does not change the speed rule', () => {
  const g = make({ mode: 'classic', edge: 'wrap' }); g.start();
  const levels = [];
  g.on(e => { if (e.type === 'level') levels.push(e.level); });
  for (let i = 0; i < 12; i++) {
    const h = g.state.snake[0];
    g.state.food = { x: (h.x + 1) % 20, y: h.y };
    stepOnce(g);
  }
  assert.equal(g.state.foods, 12);
  assert.equal(g.state.level, 3);
  assert.deepEqual(levels, [2, 3]);
  assert.equal(g.interval(), Math.max(65, 150 - 12 * 4));
});

test('P2 Time Attack: ends after exactly the configured time, never earlier or later', () => {
  const g = make({ mode: 'timeattack', edge: 'wrap' });
  const events = [];
  g.on(e => events.push(e.type));
  g.start();
  assert.equal(g.state.timeLeft, 60000);
  run(g, 59000);
  assert.equal(g.state.phase, 'running');
  assert.equal(g.state.timeLeft, 1000);
  run(g, 2000);
  assert.equal(g.state.phase, 'over');
  assert.equal(g.state.reason, 'time');
  assert.equal(g.state.timeLeft, 0);
  assert.equal(Math.round(g.state.elapsed), 60000);
  assert.equal(events.filter(t => t === 'over').length, 1, 'over fires once');
});

test('P2 Time Attack: the timer ignores frame size and does not run while paused', () => {
  for (const frame of [8, 16, 33, 100]) {
    const g = make({ mode: 'timeattack', edge: 'wrap' }); g.start();
    run(g, 100000, frame);
    assert.equal(g.state.reason, 'time', 'frame ' + frame);
  }
  const big = make({ mode: 'timeattack', edge: 'wrap' }); big.start();
  big.update(5000);
  assert.equal(big.state.timeLeft, 60000 - 100, 'one update never consumes more than maxDt');

  const g = make({ mode: 'timeattack', edge: 'wrap' }); g.start();
  run(g, 10000);
  g.pause();
  const left = g.state.timeLeft;
  g.update(30000);
  assert.equal(g.state.timeLeft, left);
  g.resume();
  run(g, 1000);
  assert.equal(g.state.timeLeft, left - 1000);
});

test('P2 Time Attack: no snake step happens after time is up', () => {
  const g = make({ mode: 'timeattack', edge: 'wrap', tuning: { timeattack: { duration: 1000 } } });
  g.start();
  run(g, 5000);
  const snap = JSON.stringify(g.state.snake);
  g.update(5000);
  assert.equal(JSON.stringify(g.state.snake), snap);
  assert.equal(g.state.phase, 'over');
});

test('P2 Time Attack: the clock keeps its time when the run ends early by a crash', () => {
  const g = make({ mode: 'timeattack', edge: 'walls' }); g.start();
  run(g, 5000);
  assert.equal(g.state.reason, 'wall');
  assert.ok(g.state.timeLeft > 50000);
});

test('P2 Time Attack: level rises every 4 foods and speed steps up with it, within the control cap', () => {
  const g = make({ mode: 'timeattack', edge: 'wrap' }); g.start();
  const T = g.tuning.timeattack;
  const seen = [];
  for (let i = 0; i < 60; i++) {
    const h = g.state.snake[0];
    g.state.food = { x: (h.x + 1) % 20, y: h.y };
    g.state.timeLeft = 1e9;
    stepOnce(g);
    g.state.snake = g.state.snake.slice(0, 4);     // keep it short so a straight run in wrap mode never bites its tail
    seen.push({ foods: g.state.foods, level: g.state.level, iv: g.interval() });
  }
  seen.forEach(s => {
    assert.equal(s.level, 1 + Math.floor(s.foods / T.foodsPerLevel));
    assert.equal(s.iv, Math.max(T.floor, T.start - (s.level - 1) * T.step));
    assert.ok(s.iv >= g.tuning.minInterval && s.iv <= g.tuning.maxInterval);
  });
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].iv <= seen[i - 1].iv, 'speed never drops as levels rise');
  assert.equal(seen[seen.length - 1].iv, T.floor, 'reaches the floor and stays there');
});

test('P2 Survival: level changes exactly every levelMs and the speed follows the table', () => {
  const g = make({ mode: 'survival', edge: 'wrap', tuning: { survival: { obstaclesPerLevel: 0 } } });
  g.start();
  const V = g.tuning.survival;
  const levels = [];
  g.on(e => { if (e.type === 'level') levels.push([e.level, Math.round(g.state.elapsed)]); });
  run(g, V.levelMs * 3 + 100);
  assert.deepEqual(levels.map(l => l[0]), [2, 3, 4]);
  levels.forEach((l, i) => {
    assert.ok(l[1] >= (i + 1) * V.levelMs && l[1] < (i + 1) * V.levelMs + 100, 'level ' + l[0] + ' at ' + l[1]);
  });
  assert.equal(g.interval(), Math.max(V.floor, V.start - 3 * V.step));
});

test('P2 Survival: speed is capped no matter how long the run lasts', () => {
  const g = make({ mode: 'survival', edge: 'wrap', tuning: { survival: { obstaclesPerLevel: 0 } } });
  g.start();
  let fastest = Infinity;
  for (let i = 0; i < 60 * 60 * 10; i++) {          // ten minutes of game time
    g.update(16);
    fastest = Math.min(fastest, g.interval());
    if (g.state.phase !== 'running') break;
  }
  assert.ok(g.state.level > 25);
  assert.equal(fastest, g.tuning.survival.floor);
  assert.ok(fastest >= g.tuning.minInterval);
});

test('P2 Survival: each level adds obstacles on free cells, away from the head and its path, never touching each other', () => {
  let checked = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const g = Engine.create({ mode: 'survival', edge: 'wrap', rng: mulberry32(seed), tuning: { survival: { levelMs: 150 } } });
    g.start();
    const V = g.tuning.survival;
    g.on(e => {
      if (e.type !== 'level') return;
      const S = g.state, h = S.snake[0];
      assert.equal(S.obstacles.length, Math.min(V.maxObstacles, (e.level - 1) * V.obstaclesPerLevel));
      if (!e.obstacles) return;
      const o = S.obstacles[S.obstacles.length - 1];
      assert.ok(Math.abs(o.x - h.x) + Math.abs(o.y - h.y) >= V.clearance, 'clearance');
      assert.ok(!S.snake.some(s => s.x === o.x && s.y === o.y), 'not on the snake');
      assert.ok(!(S.food.x === o.x && S.food.y === o.y), 'not on the food');
      if (S.dir.x !== 0 && o.y === h.y) assert.ok(((o.x - h.x) * S.dir.x + 20) % 20 > V.lookahead, 'not in the head\'s path');
      S.obstacles.forEach((a, i) => S.obstacles.forEach((b, j) => {
        if (i < j) assert.ok(Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 1, 'obstacles are not adjacent');
      }));
      checked++;
    });
    for (let i = 0; i < 3000 && g.state.phase === 'running'; i++) g.update(16);
    assert.ok(g.state.obstacles.length <= V.maxObstacles);
  }
  assert.ok(checked > 150, 'enough obstacle spawns were inspected: ' + checked);
});

test('P2 Survival: obstacles stop at the configured maximum', () => {
  const g = make({ mode: 'survival', edge: 'wrap', tuning: { survival: { levelMs: 500, maxObstacles: 4 } } });
  g.start();
  for (let i = 0; i < 2000 && g.state.phase === 'running'; i++) {
    g.update(16);
    g.state.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
    g.state.obstacles = g.state.obstacles.filter(o => o.y !== 10);
  }
  assert.ok(g.state.level > 10);
  assert.ok(g.state.obstacles.length <= 4);
});

test('P2 Survival: hitting an obstacle ends the run with reason "obstacle"', () => {
  const g = make({ mode: 'survival', edge: 'wrap' }); g.start();
  g.state.obstacles = [{ x: 11, y: 10 }];
  g.state.food = { x: 0, y: 0 };
  stepOnce(g);
  assert.equal(g.state.phase, 'over');
  assert.equal(g.state.reason, 'obstacle');
});

test('P2 Classic and Time Attack never create obstacles', () => {
  for (const mode of ['classic', 'timeattack']) {
    const g = make({ mode, edge: 'wrap' }); g.start();
    for (let i = 0; i < 40; i++) {
      const h = g.state.snake[0];
      g.state.food = { x: (h.x + 1) % 20, y: h.y };
      if (g.state.timeLeft !== null) g.state.timeLeft = 1e9;
      stepOnce(g);
    }
    assert.deepEqual(g.state.obstacles, [], mode);
  }
});

test('P2 the interval stays inside the control cap in every mode and level', () => {
  for (const mode of Object.keys(Engine.MODES)) {
    const g = make({ mode });
    for (let lv = 1; lv <= 200; lv++) {
      g.state.level = lv; g.state.score = lv * 3;
      const iv = g.interval();
      assert.ok(iv >= g.tuning.minInterval && iv <= g.tuning.maxInterval, mode + ' level ' + lv + ' -> ' + iv);
    }
  }
});

test('P2 tuning overrides apply per game and never leak into the defaults', () => {
  const before = JSON.stringify(Engine.TUNING);
  const g = make({ mode: 'timeattack', tuning: { timeattack: { duration: 5000 }, minInterval: 70 } });
  assert.equal(g.state.timeLeft, 5000);
  assert.equal(g.tuning.minInterval, 70);
  assert.equal(JSON.stringify(Engine.TUNING), before);
  assert.equal(make({ mode: 'timeattack' }).state.timeLeft, 60000);
});
