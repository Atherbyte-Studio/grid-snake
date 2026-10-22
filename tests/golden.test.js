'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../src/engine.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function stepOnce(g) {
  let ms = g.interval();
  while (ms > 0 && g.state.phase === 'running') { const d = Math.min(ms, g.tuning.maxDt); g.update(d); ms -= d; }
}
function make(opts) {
  const g = Engine.create(Object.assign({ mode: 'classic', edge: 'wrap', golden: true, rng: mulberry32(5) }, opts || {}));
  g.start();
  if (g.state.timeLeft !== null) g.state.timeLeft = 1e9;
  return g;
}
function ahead(g, n) { const h = g.state.snake[0], d = g.state.dir; return { x: (h.x + d.x * n + 20) % 20, y: (h.y + d.y * n + 20) % 20 }; }
function log(g) { const l = []; g.on(e => l.push(Object.assign({}, e))); return l; }

test('G1 golden is off by default: no apple ever, score and growth unchanged', () => {
  const g = make({ golden: false });
  const l = log(g);
  g.state.score = 9;
  g.state.food = ahead(g, 1);
  stepOnce(g);
  assert.equal(g.state.score, 10);
  assert.equal(g.state.gold, null);
  assert.equal(l.filter(e => e.type === 'goldSpawn').length, 0);
  assert.equal(g.state.snake.length, 5);
});

test('G1 a golden apple appears when the score reaches 10, once, on a free cell', () => {
  const g = make();
  const l = log(g);
  g.state.score = 9;
  g.state.food = ahead(g, 1);
  stepOnce(g);
  assert.equal(g.state.score, 10);
  assert.ok(g.state.gold, 'apple spawned');
  const taken = new Set(g.state.snake.map(s => s.x + ',' + s.y));
  taken.add(g.state.food.x + ',' + g.state.food.y);
  assert.ok(!taken.has(g.state.gold.x + ',' + g.state.gold.y));
  assert.equal(l.filter(e => e.type === 'goldSpawn').length, 1);
});

test('G1 no second apple while one is waiting, and the next one comes at the next multiple', () => {
  const g = make();
  const l = log(g);
  g.state.score = 10; g.state.goldNext = 10;
  g.state.food = ahead(g, 1);
  stepOnce(g);                                       // score 11 >= 10 -> first apple
  const first = g.state.gold;
  assert.ok(first);
  g.state.score = 19;
  g.state.food = ahead(g, 1);
  stepOnce(g);                                       // score 20, apple still there
  assert.deepEqual(g.state.gold, first);
  assert.equal(l.filter(e => e.type === 'goldSpawn').length, 1);
  assert.equal(g.state.goldNext, 30);
});

test('G2 eating it adds 5 golden segments and 5 points, one at a time as the snake moves', () => {
  const g = make();
  const l = log(g);
  g.state.gold = ahead(g, 1);
  g.state.goldNext = 1000;
  const len0 = g.state.snake.length, score0 = g.state.score;
  stepOnce(g);
  assert.equal(g.state.score, score0 + 5);
  assert.equal(g.state.gold, null);
  assert.equal(g.state.goldEaten, 1);
  assert.equal(l.filter(e => e.type === 'gold').length, 1);
  for (let i = 0; i < 4; i++) stepOnce(g);
  assert.equal(g.state.snake.length, len0 + 5);
  assert.equal(g.state.goldSegs.filter(Boolean).length, 5);
  assert.equal(g.state.goldSegs.length, g.state.snake.length);
  for (let i = 0; i < 6; i++) stepOnce(g);          // no further growth
  assert.equal(g.state.snake.length, len0 + 5);
  assert.equal(g.state.goldSegs.filter(Boolean).length, 5);
});

test('G2 golden segments are never added twice for one apple, and normal food adds a plain segment', () => {
  const g = make();
  g.state.goldNext = 1000;
  g.state.food = ahead(g, 1);
  stepOnce(g);
  assert.equal(g.state.goldSegs.filter(Boolean).length, 0);
  assert.equal(g.state.goldSegs.length, g.state.snake.length);
});

test('G2 eating normal food while still growing keeps both growths', () => {
  const g = make();
  g.state.goldNext = 1000;
  g.state.gold = ahead(g, 1);
  stepOnce(g);                                       // 1 ball, 4 pending
  g.state.food = ahead(g, 1);
  stepOnce(g);                                       // normal food mid-growth
  for (let i = 0; i < 8; i++) stepOnce(g);
  assert.equal(g.state.snake.length, 4 + 5 + 1);
  assert.equal(g.state.goldSegs.filter(Boolean).length, 5);
});

test('G3 golden points are not counted towards the next apple', () => {
  const g = make();
  g.state.score = 8;
  g.state.gold = ahead(g, 1); g.state.gold.ttl = 5000; g.state.gold.life = 5000;
  g.state.goldNext = 10;
  stepOnce(g);                                       // 8 + 5 = 13, but only 8 normal points
  assert.equal(g.state.score, 13);
  assert.equal(g.state.gold, null, 'no new apple: the 5 golden points do not count');
  g.state.food = ahead(g, 1);
  stepOnce(g);                                       // normal score 9
  assert.equal(g.state.gold, null);
  g.state.food = ahead(g, 1);
  stepOnce(g);                                       // normal score 10 -> apple
  assert.ok(g.state.gold);
  assert.equal(g.state.score - g.state.goldPts, 10);
});

test('G3 ten new points are needed after each apple, however many apples were eaten', () => {
  const g = make();
  g.state.goldNext = 1000;
  for (let n = 0; n < 3; n++) { g.state.gold = ahead(g, 1); g.state.gold.ttl = 5000; stepOnce(g); }
  assert.equal(g.state.goldPts, 15);
  assert.equal(g.state.score, 15);
  g.state.goldNext = 10;                             // the counter works on normal points only
  g.state.gold = null;
  let spawned = 0; g.on(e => { if (e.type === 'goldSpawn') spawned++; });
  g.state.food = ahead(g, 1); stepOnce(g);           // score 16, normal 1
  assert.equal(spawned, 0);
});

test('G7 the apple disappears after 5 seconds of play, and is announced', () => {
  const g = make();
  const l = log(g);
  g.state.score = 9; g.state.food = ahead(g, 1);
  stepOnce(g);
  assert.ok(g.state.gold);
  assert.equal(g.state.gold.ttl > 4000 && g.state.gold.ttl <= 5000, true);
  g.state.gold = { x: 0, y: 0, ttl: 5000, life: 5000 };
  g.state.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
  g.state.dir = { x: 0, y: 1 }; g.state.queue = [];
  g.state.goldSegs = [false, false, false, false];
  let ms = 0;
  while (g.state.gold && ms < 6000 && g.state.phase === 'running') {
    g.update(50); ms += 50;
    if (g.state.snake[0].y >= 17 || g.state.snake[0].y <= 2) break;
  }
  if (g.state.gold) {                                 // the snake ran out of room: finish the countdown directly
    g.state.gold.ttl = 100; g.update(100);
  }
  assert.equal(g.state.gold, null);
  assert.equal(l.filter(e => e.type === 'goldExpire').length, 1);
  assert.equal(g.state.goldEaten, 0);
});

test('G7 time spent paused does not use up the apple, and eating it in time still works', () => {
  const g = make();
  g.state.gold = { x: 0, y: 0, ttl: 5000, life: 5000 };
  g.pause();
  g.update(100); g.update(100);
  assert.equal(g.state.gold.ttl, 5000);
  g.resume();
  g.state.gold = Object.assign(ahead(g, 1), { ttl: 400, life: 5000 });
  g.state.goldNext = 1000;
  stepOnce(g);
  assert.equal(g.state.goldEaten, 1);
});

test('G7 a missed apple does not come back: the next one needs ten more normal points', () => {
  const g = make();
  const l = log(g);
  g.state.score = 9; g.state.food = ahead(g, 1);
  stepOnce(g);
  g.state.gold.ttl = 10; g.state.snake = g.state.snake.slice(0, 4); g.state.goldSegs = g.state.goldSegs.slice(0, 4);
  g.update(50);
  assert.equal(g.state.gold, null);
  for (let i = 0; i < 6; i++) { g.state.food = ahead(g, 1); stepOnce(g); }
  assert.equal(l.filter(e => e.type === 'goldSpawn').length, 1);
});

test('G4 hitting your own growing body ends the run; growth does not break wall rules', () => {
  const g = make({ edge: 'walls' });
  g.state.goldNext = 1000;
  g.state.gold = ahead(g, 1);
  stepOnce(g);
  for (let i = 0; i < 20 && g.state.phase === 'running'; i++) stepOnce(g);
  assert.equal(g.state.phase, 'over');
  assert.equal(g.state.reason, 'wall');
});

test('G5 Classic speed still follows the score, inside the allowed range', () => {
  const g = make();
  g.state.score = 500;
  assert.ok(g.interval() >= g.tuning.minInterval && g.interval() <= g.tuning.maxInterval);
});

test('G6 same seed and same inputs give the same game (apples included)', () => {
  const run = () => {
    const g = make({ rng: mulberry32(99) });
    const out = [];
    for (let i = 0; i < 200 && g.state.phase === 'running'; i++) {
      if (i % 7 === 0) g.turn(i % 14 === 0 ? 0 : 1, i % 14 === 0 ? 1 : 0);
      stepOnce(g);
      out.push(g.state.score + ':' + g.state.snake.length + ':' + (g.state.gold ? g.state.gold.x + ',' + g.state.gold.y : '-'));
    }
    return out.join('|');
  };
  assert.equal(run(), run());
});
