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
function feed(g, ms) {
  while (ms > 0 && g.state.phase === 'running') {
    const d = Math.min(ms, g.tuning.maxDt);
    g.update(d);
    ms -= d;
  }
}
function stepOnce(g) { feed(g, g.interval()); }
function make(opts) {
  const g = Engine.create(Object.assign({ mode: 'timeattack', edge: 'wrap', rng: mulberry32(11) }, opts || {}));
  g.start();
  if (g.state.timeLeft !== null) g.state.timeLeft = 1e9;   // keep the clock out of the way unless a test wants it
  return g;
}
/* Put a food directly in front of the head and take one step, so it gets eaten. */
function eatOne(g) {
  const h = g.state.snake[0], d = g.state.dir;
  g.state.food = { x: (h.x + d.x + 20) % 20, y: (h.y + d.y + 20) % 20 };
  stepOnce(g);
  g.state.snake = g.state.snake.slice(0, 4);               // stay short so a straight run in wrap mode never bites the tail
}
function putPickup(g, type, ttl) {
  const h = g.state.snake[0], d = g.state.dir;
  g.state.pickup = { type, x: (h.x + d.x + 20) % 20, y: (h.y + d.y + 20) % 20, ttl: ttl || 8000, life: ttl || 8000 };
}
function events(g) {
  const log = [];
  g.on(e => log.push(Object.assign({}, e)));
  return log;
}

/* ---------- when pick-ups exist ---------- */

test('P3 Classic never spawns pick-ups or effects, however much you eat', () => {
  const g = make({ mode: 'classic' });
  for (let i = 0; i < 60; i++) { eatOne(g); assert.equal(g.state.pickup, null); }
  assert.equal(g.state.effect, null);
  assert.equal(g.state.shield, false);
});

test('P3 a pick-up appears after every 3rd food, one at a time, on a free cell', () => {
  for (const mode of ['timeattack', 'survival']) {
    for (let seed = 1; seed <= 25; seed++) {
      const g = make({ mode, rng: mulberry32(seed), tuning: { survival: { obstaclesPerLevel: 0 } } });
      let onBoard = 0, spawns = 0;
      g.on(e => {
        if (e.type === 'pickupSpawn') { onBoard++; spawns++; }
        if (e.type === 'pickup' || e.type === 'pickupExpire') onBoard--;
        assert.ok(onBoard >= 0 && onBoard <= 1, mode + ' seed ' + seed + ': at most one pick-up on the board');
      });
      eatOne(g); eatOne(g);
      assert.equal(spawns, 0, 'not after 2 foods');
      eatOne(g);
      assert.equal(spawns, 1, 'after 3 foods');
      const S = g.state, p = S.pickup;
      assert.ok(p, 'pick-up exists');
      assert.ok(!S.snake.some(c => c.x === p.x && c.y === p.y), 'not on the snake');
      assert.ok(!(S.food.x === p.x && S.food.y === p.y), 'not on the food');
      for (let i = 0; i < 12; i++) { eatOne(g); assert.equal(onBoard, S.pickup ? 1 : 0); }
    }
  }
});

test('P3 only one pick-up is ever on the board', () => {
  const g = make();
  let spawns = 0;
  g.on(e => { if (e.type === 'pickupSpawn') { spawns++; } });
  putPickup(g, 'bonus', 1e9);
  g.state.pickup.x = 0; g.state.pickup.y = 0;
  const keep = g.state.pickup;
  for (let i = 0; i < 12; i++) eatOne(g);
  assert.equal(g.state.pickup, keep, 'the waiting pick-up is not replaced');
  assert.equal(spawns, 0);
});

test('P3 all four types show up, and a second shield is never offered while one is held', () => {
  const seen = { boost: 0, slow: 0, bonus: 0, shield: 0 };
  for (let seed = 1; seed <= 300; seed++) {
    const g = make({ rng: mulberry32(seed) });
    g.on(e => { if (e.type === 'pickupSpawn') seen[e.kind]++; });
    eatOne(g); eatOne(g); eatOne(g);
  }
  Object.keys(seen).forEach(k => assert.ok(seen[k] > 20, k + ' appeared ' + seen[k] + ' times'));
  assert.ok(seen.boost + seen.bonus > seen.shield, 'weights favour boost and bonus over shield');

  for (let seed = 1; seed <= 300; seed++) {
    const g = make({ rng: mulberry32(seed) });
    g.state.shield = true;
    eatOne(g); eatOne(g); eatOne(g);
    assert.ok(g.state.pickup && g.state.pickup.type !== 'shield', 'seed ' + seed);
  }
});

test('P3 the same seed always produces the same pick-ups', () => {
  const run = seed => {
    const g = make({ rng: mulberry32(seed) });
    const out = [];
    g.on(e => { if (e.type === 'pickupSpawn') out.push([e.kind, e.x, e.y]); });
    for (let i = 0; i < 30; i++) eatOne(g);
    return JSON.stringify(out);
  };
  assert.equal(run(5), run(5));
  assert.notEqual(run(5), run(6));
});

/* ---------- lifetime ---------- */

test('P3 an uncollected pick-up disappears after its lifetime in game time, not before', () => {
  const g = make();
  const log = events(g);
  g.state.pickup = { type: 'boost', x: 0, y: 0, ttl: 8000, life: 8000 };
  g.state.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
  g.state.dir = { x: 0, y: 1 }; g.state.queue = [];
  feed(g, 7900);
  assert.ok(g.state.pickup);
  g.state.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
  g.state.dir = { x: 1, y: 0 };
  feed(g, 150);
  assert.equal(g.state.pickup, null);
  assert.equal(log.filter(e => e.type === 'pickupExpire').length, 1);
});

test('P3 pick-up and effect timers stand still while paused', () => {
  const g = make();
  g.state.pickup = { type: 'bonus', x: 0, y: 0, ttl: 6000, life: 6000 };
  g.state.effect = { type: 'boost', remaining: 5000, total: 5000 };
  g.pause();
  g.update(100); g.update(100);
  assert.equal(g.state.pickup.ttl, 6000);
  assert.equal(g.state.effect.remaining, 5000);
  g.resume();
  feed(g, 1000);
  assert.equal(g.state.pickup.ttl, 5000);
  assert.equal(g.state.effect.remaining, 4000);
});

/* ---------- Bonus Food ---------- */

test('P3 Bonus Food adds bonus points, counts as a bonus, and is not counted as a normal food', () => {
  const g = make();
  const log = events(g);
  putPickup(g, 'bonus');
  stepOnce(g);
  assert.equal(g.state.score, 5);
  assert.equal(g.state.bonusEaten, 1);
  assert.equal(g.state.foods, 0, 'level progress only counts normal food');
  assert.equal(g.state.pickup, null);
  assert.equal(g.state.snake.length, 4, 'bonus does not grow the snake');
  const e = log.find(x => x.type === 'pickup');
  assert.deepEqual([e.kind, e.points], ['bonus', 5]);
});

/* ---------- Speed Boost and Slow Motion ---------- */

test('P3 Speed Boost: faster steps for the set time, double points per food, then back to normal', () => {
  const g = make();
  const log = events(g);
  const normal = g.interval();
  putPickup(g, 'boost');
  stepOnce(g);
  assert.equal(g.state.effect.type, 'boost');
  const P = g.tuning.power;
  assert.equal(g.interval(), Math.max(g.tuning.minInterval, Math.round(normal * P.boostMult)));
  assert.ok(g.interval() < normal);

  const before = g.state.score;
  eatOne(g);
  assert.equal(g.state.score - before, 2, 'food is worth double while boosted');

  g.state.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
  g.state.food = { x: 0, y: 0 };
  let t = 0;
  while (g.state.effect && t < 20000) {
    feed(g, 50); t += 50;
    g.state.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
    g.state.dir = { x: 1, y: 0 };
  }
  assert.ok(t >= P.effectMs - 300 && t <= P.effectMs + 300, 'lasted about ' + t + ' ms');
  assert.equal(g.interval(), normal);
  assert.equal(log.filter(e => e.type === 'effectEnd').length, 1);

  const b2 = g.state.score;
  eatOne(g);
  assert.equal(g.state.score - b2, 1, 'back to single points');
});

test('P3 Slow Motion: slower steps for the set time, never past the slowest allowed step', () => {
  const g = make();
  const normal = g.interval();
  putPickup(g, 'slow');
  stepOnce(g);
  g.state.food = { x: 0, y: 0 };
  assert.equal(g.state.effect.type, 'slow');
  assert.ok(g.interval() > normal);
  assert.ok(g.interval() <= g.tuning.maxInterval);
  feed(g, 5000 - 1);
  g.state.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
  assert.ok(g.state.effect, 'still active just before the end');
  feed(g, 200);
  assert.equal(g.state.effect, null);
  assert.equal(g.interval(), normal);
});

test('P3 picking the same effect again refreshes its timer instead of stacking', () => {
  const g = make();
  putPickup(g, 'boost'); stepOnce(g);
  g.state.effect.remaining = 800;
  const iv = g.interval();
  putPickup(g, 'boost'); stepOnce(g);
  assert.equal(g.state.effect.remaining, g.tuning.power.effectMs);
  assert.equal(g.interval(), iv, 'speed does not stack');
});

test('P3 a Slow pick-up replaces an active Boost (and the other way round)', () => {
  const g = make();
  putPickup(g, 'boost'); stepOnce(g);
  putPickup(g, 'slow'); stepOnce(g);
  assert.equal(g.state.effect.type, 'slow');
  putPickup(g, 'boost'); stepOnce(g);
  assert.equal(g.state.effect.type, 'boost');
});

test('P3 control cap: with any mode, level and effect the step time stays within the allowed range', () => {
  for (const mode of ['timeattack', 'survival']) {
    const g = make({ mode });
    for (let lv = 1; lv <= 150; lv++) {
      g.state.level = lv;
      for (const eff of [null, 'boost', 'slow']) {
        g.state.effect = eff ? { type: eff, remaining: 1000, total: 1000 } : null;
        const iv = g.interval();
        assert.ok(iv >= g.tuning.minInterval && iv <= g.tuning.maxInterval, mode + ' L' + lv + ' ' + eff + ' -> ' + iv);
      }
    }
  }
});

/* ---------- Shield ---------- */

test('P3 Shield absorbs one wall hit by wrapping you through, then the next wall hit is fatal', () => {
  const g = make({ edge: 'walls' });
  const log = events(g);
  g.state.shield = true;
  g.state.snake = [{ x: 19, y: 10 }, { x: 18, y: 10 }, { x: 17, y: 10 }, { x: 16, y: 10 }];
  g.state.food = { x: 5, y: 5 };
  stepOnce(g);
  assert.equal(g.state.phase, 'running');
  assert.deepEqual(g.state.snake[0], { x: 0, y: 10 });
  assert.equal(g.state.shield, false);
  assert.equal(g.state.shieldSaves, 1);
  const e = log.find(x => x.type === 'shield');
  assert.equal(e.hit, 'wall');

  g.state.snake = [{ x: 19, y: 12 }, { x: 18, y: 12 }, { x: 17, y: 12 }, { x: 16, y: 12 }];
  stepOnce(g);
  assert.equal(g.state.phase, 'over');
  assert.equal(g.state.reason, 'wall');
});

test('P3 Shield lets you pass through your own tail once', () => {
  const g = make({ edge: 'walls' });
  g.state.shield = true;
  g.state.snake = [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 5 }, { x: 7, y: 5 }, { x: 8, y: 5 }];
  g.state.dir = { x: 0, y: 1 }; g.state.queue = []; g.state.food = { x: 0, y: 0 };
  g.turn(1, 0);
  stepOnce(g);
  assert.equal(g.state.phase, 'running');
  assert.equal(g.state.shield, false);
  assert.equal(g.state.shieldSaves, 1);
  assert.equal(g.state.snake.length, 6, 'length unchanged');
  for (let i = 0; i < 4; i++) { stepOnce(g); assert.equal(g.state.phase, 'running', 'keeps going after passing through'); }
});

test('P3 Shield smashes an obstacle in Survival', () => {
  const g = make({ mode: 'survival', tuning: { survival: { obstaclesPerLevel: 0 } } });
  g.state.shield = true;
  g.state.obstacles = [{ x: 11, y: 10 }, { x: 3, y: 3 }];
  g.state.food = { x: 0, y: 0 };
  stepOnce(g);
  assert.equal(g.state.phase, 'running');
  assert.deepEqual(g.state.obstacles, [{ x: 3, y: 3 }]);
  assert.equal(g.state.shield, false);
  g.state.obstacles.push({ x: 12, y: 10 });
  stepOnce(g);
  assert.equal(g.state.phase, 'over');
  assert.equal(g.state.reason, 'obstacle');
});

test('P3 Shield through a wall also clears whatever is in the landing cell', () => {
  const g = make({ mode: 'survival', edge: 'walls', tuning: { survival: { obstaclesPerLevel: 0 } } });
  g.state.shield = true;
  g.state.snake = [{ x: 19, y: 10 }, { x: 18, y: 10 }, { x: 17, y: 10 }, { x: 16, y: 10 }];
  g.state.obstacles = [{ x: 0, y: 10 }];
  g.state.food = { x: 5, y: 5 };
  stepOnce(g);
  assert.equal(g.state.phase, 'running');
  assert.deepEqual(g.state.obstacles, []);
});

test('P3 Shield is not spent by safe moves, eating, or wrap-around edges', () => {
  const g = make({ edge: 'wrap' });
  g.state.shield = true;
  for (let i = 0; i < 30; i++) stepOnce(g);
  eatOne(g);
  assert.equal(g.state.shield, true);
  assert.equal(g.state.shieldSaves, 0);
});

test('P3 picking up a Shield turns it on, and it stays until it is used', () => {
  const g = make();
  putPickup(g, 'shield');
  stepOnce(g);
  assert.equal(g.state.shield, true);
  feed(g, 30000);
  assert.equal(g.state.shield, true);
});

test('P3 Shield still lets a Time Attack run end on time', () => {
  const g = make({ tuning: { timeattack: { duration: 3000 } } });
  g.state.timeLeft = 3000;
  g.state.shield = true;
  feed(g, 10000);
  assert.equal(g.state.reason, 'time');
});

test('P3 the engine reports every power-up event with its payload', () => {
  const g = make();
  const log = events(g);
  putPickup(g, 'bonus'); stepOnce(g);
  putPickup(g, 'boost'); stepOnce(g);
  g.state.effect.remaining = 10;
  feed(g, 50);
  const types = log.map(e => e.type);
  assert.ok(types.includes('pickup'));
  assert.ok(types.includes('effectEnd'));
  assert.equal(log.find(e => e.type === 'effectEnd').effect, 'boost');
});

test('P3 a restart (new game) carries nothing over: no effect, no shield, no pick-up', () => {
  const a = make();
  a.state.shield = true; a.state.effect = { type: 'boost', remaining: 5000, total: 5000 };
  putPickup(a, 'bonus');
  const b = Engine.create({ mode: 'timeattack', edge: 'wrap' });
  assert.equal(b.state.shield, false);
  assert.equal(b.state.effect, null);
  assert.equal(b.state.pickup, null);
  assert.equal(b.state.shieldSaves, 0);
  assert.equal(b.state.bonusEaten, 0);
});
