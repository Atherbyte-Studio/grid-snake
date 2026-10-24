'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Chase = require('../src/chase.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* A calm, predictable game: the snake never wanders, items never spawn by themselves. */
function make(opts) {
  const tuning = Object.assign({ chase: Object.assign({ dumbStart: 0, dumbFloor: 0, itemEveryMs: 1e9 }, (opts && opts.chase) || {}) });
  const g = Chase.create({ edge: 'wrap', rng: mulberry32(3), tuning, ...(opts && opts.edge ? { edge: opts.edge } : {}) });
  g.start();
  return g;
}
function feed(g, ms) { while (ms > 0 && g.state.phase === 'running') { const d = Math.min(ms, 50); g.update(d); ms -= d; } }
function logEvents(g) { const l = []; g.on(e => l.push(Object.assign({}, e))); return l; }
function place(g, snake, dir, apple) {
  const s = g.state;
  s.snake = snake.map(q => ({ x: q[0], y: q[1] })); s.snakePrev = s.snake.map(q => ({ ...q }));
  s.dir = { x: dir[0], y: dir[1] };
  if (apple) { s.apple.x = apple[0]; s.apple.y = apple[1]; }
  s.maxLength = Math.max(s.maxLength, s.snake.length);
}

test('C1 the surface matches the other engine and the game starts in Ready', () => {
  const g = Chase.create({});
  ['state', 'mode', 'edge', 'golden', 'tuning', 'on', 'start', 'pause', 'resume', 'turn', 'update', 'interval', 'snapshot', 'dash', 'useItem']
    .forEach(k => assert.ok(k in g, k));
  assert.equal(g.mode, 'chase');
  assert.equal(g.state.phase, 'ready');
  g.update(1000);
  assert.equal(g.state.elapsed, 0, 'nothing moves before Start');
  assert.equal(g.state.score, 0);
});

test('C2 the apple keeps running in its direction and may turn any way, even straight back', () => {
  const g = make();
  place(g, [[1, 1], [0, 1], [19, 1], [18, 1], [17, 1]], [1, 0], [10, 10]);
  g.turn(1, 0);
  feed(g, g.appleInterval() * 3);
  assert.equal(g.state.apple.x, 13);
  assert.equal(g.turn(-1, 0), true, 'straight back is allowed');
  feed(g, g.appleInterval() * 2);
  assert.equal(g.state.apple.x, 11);
  assert.equal(g.turn(1, 1), false, 'diagonals are not directions');
});

test('C3 walls make the apple bonk (no move, no death); wrap carries it to the other side', () => {
  const a = make({ edge: 'walls' });
  place(a, [[1, 1], [0, 1], [19, 1], [18, 1], [17, 1]], [1, 0], [19, 10]);
  const l = logEvents(a);
  a.turn(1, 0);
  feed(a, a.appleInterval() * 2 + 1);
  assert.equal(a.state.apple.x, 19);
  assert.equal(a.state.phase, 'running');
  assert.ok(l.filter(e => e.type === 'bonk').length >= 1);
  const w = make({ edge: 'wrap' });
  place(w, [[1, 1], [0, 1], [19, 1], [18, 1], [17, 1]], [1, 0], [19, 10]);
  w.turn(1, 0);
  feed(w, w.appleInterval() + 1);
  assert.equal(w.state.apple.x, 0);
});

test('C4 the snake body blocks the apple (bonk) but only the HEAD catches it', () => {
  const g = make();
  place(g, [[5, 4], [5, 5], [5, 6], [5, 7], [5, 8]], [0, -1], [4, 6]);
  g.state.stun = 1e9;                                   // keep the snake still
  const l = logEvents(g);
  g.turn(1, 0);
  feed(g, g.appleInterval() + 1);
  assert.deepEqual([g.state.apple.x, g.state.apple.y], [4, 6], 'blocked by the body');
  assert.equal(g.state.phase, 'running');
  assert.ok(l.some(e => e.type === 'bonk'));
  place(g, [[5, 4], [5, 5], [5, 6], [5, 7], [5, 8]], [0, -1], [4, 4]);
  g.state.appleT = 0;
  g.turn(1, 0);
  feed(g, g.appleInterval() + 1);
  assert.equal(g.state.phase, 'over', 'stepping into the head ends the run');
  assert.equal(g.state.reason, 'caught');
});

test('C5 the snake moving onto the apple ends the run with a "caught" event', () => {
  const g = make();
  place(g, [[5, 5], [4, 5], [3, 5], [2, 5], [1, 5]], [1, 0], [6, 5]);
  g.turn(0, 0);
  g.state.appleDir = { x: 0, y: 0 };                    // the apple stands still this time
  const l = logEvents(g);
  feed(g, 500);
  assert.equal(g.state.phase, 'over');
  assert.equal(g.state.reason, 'caught');
  assert.equal(l.filter(e => e.type === 'over').length, 1);
});

test('C6 Dash: faster steps for a short time, then a cooldown, and no stacking', () => {
  const g = make();
  place(g, [[1, 1], [0, 1], [19, 1], [18, 1], [17, 1]], [1, 0], [2, 10]);
  g.state.stun = 1e9;
  g.turn(1, 0);
  const normal = g.appleInterval();
  assert.equal(g.dash(), true);
  assert.ok(g.appleInterval() < normal);
  assert.equal(g.dash(), false, 'cannot dash while dashing');
  feed(g, g.tuning.chase.dashMs + 10);
  assert.equal(g.appleInterval(), normal, 'back to normal speed');
  assert.equal(g.dash(), false, 'cooldown');
  feed(g, g.tuning.chase.dashCooldown);
  assert.equal(g.dash(), true, 'ready again');
  assert.equal(g.state.dashes, 2);
});

test('C7 an item is picked up by walking onto it, only one is carried, and using it empties the slot', () => {
  const g = make();
  place(g, [[1, 1], [0, 1], [19, 1], [18, 1], [17, 1]], [1, 0], [10, 10]);
  g.state.stun = 1e9;
  g.state.pickup = { type: 'peel', x: 11, y: 10, ttl: 9000, life: 9000 };
  g.turn(1, 0);
  feed(g, g.appleInterval() + 1);
  assert.equal(g.state.item, 'peel');
  assert.equal(g.state.pickup, null);
  g.state.pickup = { type: 'decoy', x: 12, y: 10, ttl: 9000, life: 9000 };
  feed(g, g.appleInterval() + 1);
  assert.equal(g.state.item, 'peel', 'hands full: the second item stays on the board');
  assert.ok(g.state.pickup);
  assert.equal(g.useItem(), true);
  assert.equal(g.state.item, null);
  assert.equal(g.state.peels.length, 1);
  assert.equal(g.useItem(), false, 'nothing to use');
});

test('C8 a banana peel makes the snake slide three cells, then it is dizzy; +5 points, peel gone', () => {
  const g = make();
  place(g, [[3, 5], [2, 5], [1, 5], [0, 5], [19, 5]], [1, 0], [9, 5]);
  g.state.appleDir = { x: 0, y: 0 };
  g.state.peels.push({ x: 4, y: 5, ttl: 20000, life: 20000 });
  const l = logEvents(g);
  const s0 = g.state.score;
  feed(g, g.interval() + 1);
  assert.equal(g.state.slips, 1);
  assert.equal(g.state.peels.length, 0);
  assert.equal(g.state.score, s0 + g.tuning.chase.slipPoints);
  feed(g, g.tuning.chase.slideStep * 3 + 5);
  assert.deepEqual([g.state.snake[0].x, g.state.snake[0].y], [7, 5], 'slid 3 more cells in a straight line');
  assert.ok(g.state.stun > 0, 'dizzy afterwards');
  const at = g.state.snake[0].x;
  feed(g, 800);
  assert.equal(g.state.snake[0].x, at, 'does not move while dizzy');
  assert.ok(l.some(e => e.type === 'slip'));
});

test('C9 a decoy attracts the snake, it bites it (fooled), is dizzy, and earns 10 points', () => {
  const g = make();
  place(g, [[3, 5], [2, 5], [1, 5], [0, 5], [19, 5]], [1, 0], [3, 15]);
  g.state.appleDir = { x: 0, y: 0 };
  g.state.decoy = { x: 9, y: 5, ttl: 5000, life: 5000 };
  const l = logEvents(g);
  const s0 = g.state.score;
  feed(g, 6 * g.interval() + 20);
  assert.equal(g.state.fooled, 1);
  assert.equal(g.state.decoy, null);
  assert.ok(g.state.stun > 0);
  assert.ok(g.state.score >= s0 + g.tuning.chase.foolPoints);
  assert.ok(l.some(e => e.type === 'fooled'));
  assert.equal(g.state.phase, 'running', 'the real apple is untouched');
});

test('C10 a decoy only lasts a few seconds, then the snake goes for the apple again', () => {
  const g = make();
  place(g, [[3, 5], [2, 5], [1, 5], [0, 5], [19, 5]], [1, 0], [3, 15]);
  g.state.appleDir = { x: 0, y: 0 };
  g.state.stun = 1e9;
  g.state.decoy = { x: 9, y: 5, ttl: 5000, life: 5000 };
  const l = logEvents(g);
  feed(g, 5100);
  assert.equal(g.state.decoy, null);
  assert.ok(l.some(e => e.type === 'decoyExpire'));
});

test('C11 the snake goes round its own body and never steps into it (random games)', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const g = Chase.create({ edge: seed % 2 ? 'wrap' : 'walls', rng: mulberry32(seed) });
    g.start();
    const rnd = mulberry32(seed * 7);
    let t = 0;
    while (g.state.phase === 'running' && t < 120000) {
      if (rnd() < 0.05) { const d = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(rnd() * 4)]; g.turn(d[0], d[1]); }
      if (rnd() < 0.01) g.dash();
      if (rnd() < 0.02) g.useItem();
      g.update(33); t += 33;
      const S = g.state, seen = new Set();
      S.snake.forEach(q => {
        assert.ok(q.x >= 0 && q.y >= 0 && q.x < 20 && q.y < 20, 'in bounds');
        const k = q.x + ',' + q.y;
        assert.ok(!seen.has(k), 'no overlapping segments, seed ' + seed + ' t ' + t);
        seen.add(k);
      });
      if (S.slideLeft === 0 && S.phase === 'running') {
        for (let i = 1; i < S.snake.length; i++) {
          const dx = Math.abs(S.snake[i].x - S.snake[i - 1].x), dy = Math.abs(S.snake[i].y - S.snake[i - 1].y);
          assert.ok((dx + dy === 1) || (dx === 19 && dy === 0) || (dy === 19 && dx === 0), 'segments are neighbours');
        }
      }
      assert.ok(!seen.has(S.apple.x + ',' + S.apple.y) || S.phase === 'over', 'the apple is never inside the body');
    }
  }
});

test('C12 with a sharp snake and an apple that stands still, it always arrives (path finding works, with walls and wrap)', () => {
  for (const edge of ['walls', 'wrap']) {
    for (let seed = 1; seed <= 8; seed++) {
      const g = Chase.create({ edge, rng: mulberry32(seed), tuning: { chase: { dumbStart: 0, dumbFloor: 0, itemEveryMs: 1e9 } } });
      g.start();
      g.state.appleDir = { x: 0, y: 0 };
      feed(g, 60000);
      assert.equal(g.state.reason, 'caught', edge + ' seed ' + seed);
    }
  }
});

test('C13 a snake with nowhere to go ties itself in a knot: it turns round, is dizzy, scores 5, and nothing breaks', () => {
  const g = make({ chase: { snakeLen: 9, maxLen: 9 } });
  place(g, [[4, 5], [4, 4], [3, 4], [3, 5], [3, 6], [4, 6], [5, 6], [5, 5], [5, 4]], [0, 1], [15, 15]);
  g.state.appleDir = { x: 0, y: 0 };
  const l = logEvents(g);
  const s0 = g.state.score;
  feed(g, g.interval() + 10);
  assert.equal(g.state.phase, 'running');
  assert.equal(g.state.knots, 1);
  assert.ok(l.some(e => e.type === 'knot'));
  assert.deepEqual([g.state.snake[0].x, g.state.snake[0].y], [5, 4], 'the old tail is now the head');
  assert.equal(g.state.snake.length, 9);
  assert.ok(g.state.stun > 0);
  assert.equal(g.state.score, s0 + g.tuning.chase.knotPoints);
  feed(g, g.state.stun + 600);                           // and it carries on afterwards
  assert.equal(g.state.phase, 'running');
});

test('C14 difficulty: the snake gets faster and longer, within limits, and the apple stays quicker than the snake at the start', () => {
  const g = make();
  const v0 = g.interval();
  assert.ok(g.appleInterval() < v0, 'the apple starts faster than the snake');
  g.state.stun = 1e9; g.state.appleDir = { x: 0, y: 0 };
  let last = v0;
  for (let i = 0; i < 40; i++) {
    feed(g, 15000);
    assert.ok(g.interval() <= last, 'never slower than before');
    assert.ok(g.interval() >= g.tuning.chase.snakeFloor && g.interval() >= 60, 'floor respected');
    last = g.interval();
    g.state.stun = 1e9;
    if (g.state.phase !== 'running') break;
  }
  assert.ok(g.state.level > 5);
  assert.ok(g.state.snake.length <= g.tuning.chase.maxLen);
});

test('C15 score is one point per second plus bonuses, never goes down, and emits score events', () => {
  const g = make();
  g.state.stun = 1e9; g.state.appleDir = { x: 0, y: 0 };
  const l = logEvents(g);
  feed(g, 5000);
  assert.equal(g.state.score, 5);
  assert.equal(l.filter(e => e.type === 'score').length, 5);
  assert.ok(l.every(e => e.type !== 'score' || e.points > 0));
});

test('C16 pause stops everything; time larger than 100 ms is cut; restart is a fresh game', () => {
  const g = make();
  g.state.stun = 1e9;
  g.update(5000);
  assert.ok(g.state.elapsed <= 100);
  g.pause();
  const e0 = g.state.elapsed;
  g.update(100); g.update(100);
  assert.equal(g.state.elapsed, e0);
  g.resume();
  g.update(50);
  assert.ok(g.state.elapsed > e0);
  const h = Chase.create({});
  assert.equal(h.state.score, 0);
  assert.equal(h.state.snake.length, h.tuning.chase.snakeLen);
});

test('C17 the same seed and inputs give the same run', () => {
  const run = () => {
    const g = Chase.create({ edge: 'wrap', rng: mulberry32(42) });
    g.start();
    const out = [];
    for (let i = 0; i < 600 && g.state.phase === 'running'; i++) {
      if (i % 11 === 0) g.turn(i % 22 === 0 ? 1 : 0, i % 22 === 0 ? 0 : 1);
      if (i % 90 === 0) g.dash();
      g.update(33);
      out.push(g.state.apple.x + ':' + g.state.apple.y + ':' + g.state.snake[0].x + ':' + g.state.snake[0].y + ':' + g.state.score);
    }
    return out.join('|');
  };
  assert.equal(run(), run());
});

test('C18 items appear on their own on a free cell away from the snake, expire, and a full hand leaves them', () => {
  const g = Chase.create({ edge: 'wrap', rng: mulberry32(9), tuning: { chase: { itemEveryMs: 1000, itemLife: 2000 } } });
  g.start();
  g.state.stun = 1e9; g.state.appleDir = { x: 0, y: 0 };
  const l = logEvents(g);
  feed(g, 1100);
  const p = g.state.pickup;
  assert.ok(p, 'an item appeared');
  assert.ok(['peel', 'decoy'].includes(p.type));
  const head = g.state.snake[0];
  assert.ok(Math.abs(p.x - head.x) + Math.abs(p.y - head.y) >= 1);
  assert.ok(!g.state.snake.some(q => q.x === p.x && q.y === p.y));
  feed(g, 2100);
  assert.ok(l.some(e => e.type === 'itemExpire'));
});

test('C19 snapshot carries what achievements need', () => {
  const g = make();
  const s = g.snapshot();
  ['mode', 'score', 'level', 'elapsed', 'slips', 'fooled', 'knots', 'dashes', 'length', 'foods'].forEach(k => assert.ok(k in s, k));
  assert.equal(s.mode, 'chase');
});

test('D4 Apple Run difficulty: Hard is unchanged, Easy snake is slower and starts dumber', () => {
  assert.deepEqual(Chase.DIFFICULTY.hard, {});
  const iv = d => Chase.create({ tuning: Chase.DIFFICULTY[d] }).interval();
  assert.ok(iv('easy') > iv('normal') && iv('normal') > iv('hard'), 'snake step: easy > normal > hard');
});
