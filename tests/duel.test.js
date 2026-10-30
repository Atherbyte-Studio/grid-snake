'use strict';
/* Grid Snake Duel: rules, events, match, AI and statistics (no browser).
 * Run: node --test tests/duel.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const Duel = require('../src/duel/engine.js');
const Maps = require('../src/duel/maps.js');
const Events = require('../src/duel/events.js');
const Match = require('../src/duel/match.js');
const AI = require('../src/duel/ai.js');
const Stats = require('../src/duel/stats.js');
const Sim = require('../scripts/duel-sim.js');           // measured with the reference players in tests/support/duel-bots.js

const R = { x: 1, y: 0 }, L = { x: -1, y: 0 }, U = { x: 0, y: -1 }, D = { x: 0, y: 1 };
/* A controller that plays a fixed list of moves, then keeps going straight. */
function script(moves) { let i = 0; return { next: () => (i < moves.length ? moves[i++] : null) }; }
function straight() { return { next: () => null }; }
/* A round with the bodies placed by hand (head first) and no food unless given. */
function setup(opts) {
  const r = Duel.createRound(Object.assign({ map: 'crossroads', seed: 3, controllers: [opts.c0 || straight(), opts.c1 || straight()] }, opts.round || {}));
  const S = r.state;
  if (opts.a) { S.snakes[0].body = opts.a.map(([x, y]) => ({ x, y })); S.snakes[0].dir = opts.da || R; }
  if (opts.b) { S.snakes[1].body = opts.b.map(([x, y]) => ({ x, y })); S.snakes[1].dir = opts.db || L; }
  S.foods = (opts.foods || [[0, 29], [29, 0], [0, 28]]).map(([x, y]) => ({ x, y }));
  r.start();
  return r;
}
function run(r, max) { let n = 0; while (r.state.phase === 'running' && n < (max || 2000)) { r.tick(); n++; } return n; }
function line(x, y, len, dx) { const b = []; for (let i = 0; i < len; i++) b.push([x - dx * i, y]); return b; }

/* ---------------- arenas ---------------- */

test('every arena is point-symmetric, fully connected, and the spawns are free', () => {
  for (const id of Maps.ids) {
    const m = Maps.build(id), N = m.size;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) assert.equal(m.walls[y * N + x], m.walls[(N - 1 - y) * N + (N - 1 - x)], id + ' mirror');
    const seen = new Uint8Array(N * N), h = m.spawns[0].body[0], q = [h.y * N + h.x];
    seen[q[0]] = 1;
    while (q.length) {
      const c = q.pop(), x = c % N, y = (c - x) / N;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, i = ny * N + nx;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N || m.walls[i] || seen[i]) continue;
        seen[i] = 1; q.push(i);
      }
    }
    for (let i = 0; i < N * N; i++) if (!m.walls[i]) assert.ok(seen[i], id + ': cell ' + i + ' unreachable');
    m.spawns.forEach(s => s.body.forEach(c => assert.equal(m.walls[c.y * N + c.x], 0, id + ' spawn on a wall')));
    const a = m.spawns[0], b = m.spawns[1];
    a.body.forEach((c, i) => assert.deepEqual(b.body[i], Maps.mirror(c.x, c.y)));
    assert.equal(N, 30);
  }
});

/* ---------------- collisions ---------------- */

test('both snakes driving into the wall on the same tick: a double crash, a draw on equal scores', () => {
  const r = Duel.createRound({ map: 'crossroads', seed: 1, controllers: [straight(), straight()] });
  r.start(); run(r);
  assert.equal(r.state.result.reason, 'double');
  assert.equal(r.state.result.draw, true);
  assert.deepEqual(r.state.result.crashes, ['wall', 'wall']);
});

test('a wall crash gives the round to the other snake', () => {
  const r = setup({ a: [[2, 2], [3, 2], [4, 2], [5, 2]], da: L, b: [[25, 27], [25, 28], [25, 29]], db: U });
  run(r, 5);
  assert.equal(r.state.result.winner, 1);
  assert.equal(r.state.result.crashes[0], 'wall');
});

test('running into your own body, and into the rival body', () => {
  // own body: a tight turn into itself
  let r = setup({ a: [[5, 3], [4, 3], [4, 4], [5, 4], [6, 4], [6, 3]], da: R, b: line(20, 22, 4, 1), db: R, c0: script([D]), c1: script([U, R, D, L]) });
  r.state.snakes[0].body = [[5, 3], [6, 3], [6, 4], [5, 4], [4, 4], [4, 5]].map(([x, y]) => ({ x, y }));
  r.state.snakes[0].dir = L;
  run(r, 3);
  assert.equal(r.state.result.crashes[0], 'tail');
  // rival body: A heads down into B's middle
  r = setup({ a: [[10, 2], [10, 1], [10, 0]], da: D, b: [[13, 3], [12, 3], [11, 3], [10, 3], [9, 3], [8, 3]], db: R, c1: script([D, L, U, R]) });
  run(r, 2);
  assert.equal(r.state.result.crashes[0], 'body');
  assert.equal(r.state.result.winner, 1);
});

test('head-on into the same cell: both crash; equal scores draw, the higher score wins', () => {
  let r = setup({ a: [[2, 20], [1, 20], [0, 20]], da: R, b: [[4, 20], [5, 20], [6, 20]], db: L });
  run(r, 2);
  assert.deepEqual(r.state.result.crashes, ['headon', 'headon']);
  assert.equal(r.state.result.draw, true);
  r = setup({ a: [[2, 20], [1, 20], [0, 20]], da: R, b: [[4, 20], [5, 20], [6, 20]], db: L });
  r.state.snakes[1].score = 2;
  run(r, 2);
  assert.equal(r.state.result.reason, 'headon');
  assert.equal(r.state.result.winner, 1);
});

test('swapping cells is a head-on crash too (no passing through each other)', () => {
  const r = setup({ a: [[2, 20], [1, 20], [0, 20]], da: R, b: [[3, 20], [4, 20], [5, 20]], db: L });
  run(r, 2);
  assert.deepEqual(r.state.result.crashes, ['body', 'body']);
  assert.equal(r.state.result.draw, true);
});

test('following the rival tail is safe (it moves away), unless the rival is growing this tick', () => {
  // B moves up, A moves into the cell B's tail leaves
  let r = setup({ a: [[3, 20], [2, 20], [1, 20]], da: R, b: [[4, 18], [4, 19], [4, 20]], db: U, c1: script([U, R, R]) });
  r.tick();
  assert.equal(r.state.phase, 'running');
  assert.deepEqual(r.state.snakes[0].body[0], { x: 4, y: 20 });
  // same, but B eats on this tick so its tail stays: A crashes into it
  r = setup({ a: [[3, 20], [2, 20], [1, 20]], da: R, b: [[4, 18], [4, 19], [4, 20]], db: U, foods: [[4, 17], [29, 0], [0, 28]], c1: script([U, R, R]) });
  r.tick();
  assert.equal(r.state.result.crashes[0], 'body');
  assert.equal(r.state.result.winner, 1);
});

test('the result never depends on which snake is player 0 (mirrored set-ups give mirrored results)', () => {
  const cases = [
    { a: [[3, 20], [2, 20], [1, 20]], b: [[4, 18], [4, 19], [4, 20]], da: R, db: U, foods: [[4, 17]] },
    { a: [[2, 20], [1, 20], [0, 20]], b: [[4, 20], [5, 20], [6, 20]], da: R, db: L, foods: [[3, 20]] },
    { a: [[10, 2], [10, 1], [10, 0]], b: [[13, 3], [12, 3], [11, 3], [10, 3], [9, 3]], da: D, db: R, foods: [[0, 28]] }
  ];
  for (const c of cases) {
    const r1 = setup({ a: c.a, b: c.b, da: c.da, db: c.db, foods: c.foods.concat([[29, 0]]) });
    const r2 = setup({ a: c.b, b: c.a, da: c.db, db: c.da, foods: c.foods.concat([[29, 0]]) });
    run(r1, 3); run(r2, 3);
    const s1 = r1.state, s2 = r2.state;
    assert.deepEqual([s1.snakes[0].body, s1.snakes[1].body], [s2.snakes[1].body, s2.snakes[0].body]);
    assert.deepEqual([s1.snakes[0].reason, s1.snakes[1].reason], [s2.snakes[1].reason, s2.snakes[0].reason]);
    assert.deepEqual([s1.snakes[0].score, s1.snakes[1].score], [s2.snakes[1].score, s2.snakes[0].score]);
  }
});

test('a reversal is ignored: the snake keeps its heading', () => {
  const r = setup({ a: [[5, 20], [4, 20], [3, 20]], da: R, b: [[20, 25], [21, 25], [22, 25]], db: L, c0: script([L]) });
  r.tick();
  assert.deepEqual(r.state.snakes[0].body[0], { x: 6, y: 20 });
  const h = Duel.humanController();
  h.bind(r, 0);
  assert.equal(h.turn(-1, 0), false);
  assert.equal(h.turn(0, 1), true);
});

/* ---------------- scoring and the clock ---------------- */

test('food is +1 and grows the snake by one; new food keeps three on the board', () => {
  const r = setup({ a: [[5, 20], [4, 20], [3, 20]], da: R, b: [[20, 25], [21, 25], [22, 25]], db: L, foods: [[6, 20], [29, 0], [0, 28]] });
  r.tick();
  assert.equal(r.state.snakes[0].score, 1);
  assert.equal(r.state.snakes[0].body.length, 4);
  assert.equal(r.state.foods.length, 3);
});

test('new food never lands on a snake, a wall or next to a head, and is fair when it can be', () => {
  for (let seed = 1; seed < 30; seed++) {
    const r = Duel.createRound({ map: Maps.ids[seed % 4], seed, controllers: [straight(), straight()] });
    const S = r.state, N = 30;
    S.foods.forEach(f => {
      assert.ok(!r.isWall(f.x, f.y));
      assert.ok(!r.segAt(f.x, f.y));
      S.snakes.forEach(s => assert.ok(Math.abs(s.body[0].x - f.x) + Math.abs(s.body[0].y - f.y) >= 3));
    });
    assert.equal(N, r.size);
  }
});

test('time out: the higher score wins the round', () => {
  const r = Duel.createRound({ map: 'pillars', seed: 2, controllers: [straight(), straight()], tuning: { roundMs: 600 } });
  r.state.snakes[0].body = [[1, 20], [0, 20]].map(([x, y]) => ({ x, y })); r.state.snakes[0].dir = D;
  r.state.snakes[1].body = [[28, 9], [29, 9]].map(([x, y]) => ({ x, y })); r.state.snakes[1].dir = U;
  r.state.foods = [];
  r.state.snakes[0].score = 1;
  r.start(); run(r);
  assert.equal(r.state.result.reason, 'time');
  assert.equal(r.state.result.winner, 0);
});

test('a tie at the bell goes to sudden-death overtime: the first point wins, no point is a draw', () => {
  let r = Duel.createRound({ map: 'pillars', seed: 2, controllers: [straight(), straight()], tuning: { roundMs: 600, overtimeMs: 2400 } });
  r.state.snakes[0].body = [[1, 16], [1, 17]].map(([x, y]) => ({ x, y })); r.state.snakes[0].dir = U;
  r.state.snakes[1].body = [[28, 12], [28, 11]].map(([x, y]) => ({ x, y })); r.state.snakes[1].dir = D;
  r.state.foods = [{ x: 1, y: 6 }];
  r.start(); run(r);
  assert.equal(r.state.result.overtime, true);
  assert.equal(r.state.result.reason, 'overtime');
  assert.equal(r.state.result.winner, 0);
  r = Duel.createRound({ map: 'pillars', seed: 2, controllers: [straight(), straight()], tuning: { roundMs: 600, overtimeMs: 600 } });
  r.state.snakes[0].body = [[1, 16], [1, 17]].map(([x, y]) => ({ x, y })); r.state.snakes[0].dir = U;
  r.state.snakes[1].body = [[28, 12], [28, 11]].map(([x, y]) => ({ x, y })); r.state.snakes[1].dir = D;
  r.state.foods = [];
  r.start(); run(r);
  assert.equal(r.state.result.draw, true);
  assert.equal(r.state.result.overtime, true);
});

test('the same seed and the same moves replay the same round', () => {
  function play() {
    const r = Duel.createRound({ map: 'gates', event: 'portal', seed: 77, controllers: [AI.create('medium', 1), AI.create('hard', 2)] });
    const log = [];
    r.on(e => log.push(e.type + (e.who !== undefined ? e.who : '')));
    r.start(); run(r);
    return JSON.stringify([r.state.result, log]);
  }
  assert.equal(play(), play());
});

/* ---------------- events ---------------- */

function eventRound(ev, seed, map) {
  const r = Duel.createRound({ map: map || 'pillars', event: ev, seed: seed || 5, controllers: [AI.create('medium', seed), AI.create('medium', seed + 1)] });
  r.start();
  return r;
}

test('the event is announced, then begins; the HUD gets a status line', () => {
  for (const ev of Events.IDS) {
    const r = eventRound(ev, 4), seen = [];
    r.on(e => seen.push(e.type));
    while (r.state.phase === 'running' && r.state.eventPhase !== 'live') r.tick();
    if (r.state.phase !== 'running') continue;
    assert.ok(seen.indexOf('announce') >= 0 && seen.indexOf('eventStart') > seen.indexOf('announce'), ev);
    assert.equal(typeof r.eventStatus(), 'string');
    assert.ok(r.eventStatus().length > 0, ev);
    assert.ok(r.eventView(), ev);
  }
});

test('every hazard is warned before it can hurt (vanish, laser, walls): no cell turns lethal unannounced', () => {
  for (const ev of ['vanish', 'laser', 'walls']) for (const seed of [3, 8, 21]) {
    const r = eventRound(ev, seed), N = 30;
    let prevLethal = new Uint8Array(N * N), prevWarn = new Int16Array(N * N);
    while (r.state.phase === 'running' && r.state.tick < 700) {
      r.tick();
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const i = y * N + x, l = r.lethal(x, y) ? 1 : 0;
        if (l && !prevLethal[i] && !(ev === 'walls' && r.isWall(x, y))) assert.ok(prevWarn[i] > 0, ev + ' seed ' + seed + ': cell ' + x + ',' + y + ' at tick ' + r.state.tick);
        prevLethal[i] = l; prevWarn[i] = r.warn(x, y);
      }
    }
  }
});

test('the warning lasts long enough to step clear (vanish and laser warn for at least 2 s)', () => {
  const T = Events.TUNING, step = Duel.TUNING.stepMs;
  assert.ok(T.vanish.warn * step >= 2000);
  assert.ok(T.laser.warn * step >= 2000);
  assert.ok(T.portal.preview * step >= 2000 && T.walls.preview * step >= 2000 && T.core.warn * step >= 2000);
});

test('Vanishing Grid never drops a cell under a snake, and dropped cells are deadly', () => {
  const r = eventRound('vanish', 9), N = 30;
  let dropped = 0;
  while (r.state.phase === 'running' && r.state.tick < 800) {
    r.tick();
    r.state.snakes.forEach(s => s.alive && s.body.slice(1).forEach(c => assert.notEqual(r.lethal(c.x, c.y), 'void')));
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (r.lethal(x, y) === 'void') dropped++;
  if (r.state.tick > 200) assert.ok(dropped > 0);
});

test('Portal Shift: entering a portal comes out of the other one, heading the same way', () => {
  const r = Duel.createRound({ map: 'pillars', event: 'portal', seed: 12, controllers: [straight(), straight()] });
  const S = r.state;
  r.start();
  while (S.eventPhase !== 'live' || !r.eventView().cur) {      // keep the snakes alive while waiting
    S.snakes[0].body = [{ x: 2, y: 27 }, { x: 2, y: 28 }]; S.snakes[0].dir = U;
    S.snakes[1].body = [{ x: 27, y: 2 }, { x: 27, y: 1 }]; S.snakes[1].dir = D;
    r.tick();
  }
  const pair = r.eventView().cur, a = pair[0], b = pair[1];
  S.snakes[0].body = [{ x: a.x - 1, y: a.y }, { x: a.x - 2, y: a.y }]; S.snakes[0].dir = R;
  S.snakes[1].body = [{ x: 27, y: 2 }, { x: 27, y: 1 }]; S.snakes[1].dir = D;
  S.foods = [];
  r.tick();
  assert.equal(S.phase, 'running');
  assert.deepEqual(S.snakes[0].body[0], { x: b.x, y: b.y });
  assert.deepEqual(S.snakes[0].dir, R);
});

test('Portal Shift: a blocked exit is a crash, and the portal shows it is blocked', () => {
  const r = Duel.createRound({ map: 'pillars', event: 'portal', seed: 12, controllers: [straight(), straight()] });
  const S = r.state;
  r.start();
  while (S.eventPhase !== 'live' || !r.eventView().cur) {
    S.snakes[0].body = [{ x: 2, y: 27 }, { x: 2, y: 28 }]; S.snakes[0].dir = U;
    S.snakes[1].body = [{ x: 27, y: 2 }, { x: 27, y: 1 }]; S.snakes[1].dir = D;
    r.tick();
  }
  const pair = r.eventView().cur, a = pair[0], b = pair[1];
  S.snakes[0].body = [{ x: a.x - 1, y: a.y }, { x: a.x - 2, y: a.y }]; S.snakes[0].dir = R;
  S.snakes[1].body = [{ x: b.x, y: b.y }, { x: b.x, y: b.y + 1 }, { x: b.x, y: b.y + 2 }]; S.snakes[1].dir = U;   // sits on the exit
  S.foods = [];
  assert.equal(r.eventView().open[0], false);
  r.tick();
  assert.equal(S.snakes[0].reason, 'portal');
});

test('Moving Walls never move into a snake and stay on their tracks', () => {
  for (const seed of [2, 6, 13]) {
    const r = eventRound('walls', seed);
    while (r.state.phase === 'running' && r.state.tick < 700) {
      r.tick();
      const v = r.eventView();
      if (!v || !v.live) continue;
      v.bars.forEach(b => b.cells.forEach(c => {
        assert.ok(!r.isWall(c.x, c.y));
        r.state.snakes.forEach(s => { if (s.alive) s.body.slice(1).forEach(p => assert.ok(!(p.x === c.x && p.y === c.y), 'bar on a body')); });
      }));
    }
  }
});

test('The Core: marked before it appears, near the centre, worth 3, then comes back later', () => {
  const r = Duel.createRound({ map: 'crossroads', event: 'core', seed: 4, controllers: [straight(), straight()] });
  const S = r.state;
  r.start();
  function park() {
    S.snakes[0].body = [{ x: 2, y: 27 }, { x: 2, y: 28 }]; S.snakes[0].dir = U;
    S.snakes[1].body = [{ x: 27, y: 2 }, { x: 27, y: 1 }]; S.snakes[1].dir = D;
  }
  let marked = false;
  while (!(r.eventView() && r.eventView().live)) { park(); r.tick(); const v = r.eventView(); if (v && v.spot && !v.live) marked = true; }
  assert.ok(marked);
  const c = r.eventView().spot;
  assert.ok(Math.abs(c.x - 14.5) <= 5 && Math.abs(c.y - 14.5) <= 5);
  S.snakes[0].body = [{ x: c.x - 1, y: c.y }, { x: c.x - 2, y: c.y }]; S.snakes[0].dir = R;
  if (r.isWall(c.x - 1, c.y) || r.isWall(c.x - 2, c.y)) { S.snakes[0].body = [{ x: c.x, y: c.y + 1 }, { x: c.x, y: c.y + 2 }]; S.snakes[0].dir = U; }
  S.foods = [];
  const got = [];
  r.on(e => { if (e.type === 'core') got.push(e.points); });
  r.tick();
  assert.deepEqual(got, [3]);
  assert.equal(S.snakes[0].score, 3);
  assert.equal(r.eventView().live, false);
});

test('a new round starts clean: no event left over, fresh snakes, full clock', () => {
  const m = Match.create({ seed: 5 });
  const r1 = m.nextRound([AI.create('hard', 1), AI.create('easy', 2)]);
  r1.start(); run(r1);
  m.record(r1.state.result);
  if (m.state.phase === 'over') return;
  const r2 = m.nextRound([AI.create('hard', 3), AI.create('easy', 4)]);
  assert.equal(r2.state.event, null);
  assert.equal(r2.state.tick, 0);
  assert.equal(r2.state.timeLeft, Duel.TUNING.roundMs);
  assert.deepEqual(r2.state.snakes.map(s => s.body.length), [4, 4]);
  assert.deepEqual(r2.state.snakes.map(s => s.score), [0, 0]);
});

test('events in a match do not repeat until all five have been used', () => {
  for (let s = 0; s < 50; s++) {
    const o = Events.order(Duel.seededRng(s), 6);
    assert.equal(new Set(o.slice(0, 5)).size, 5);
    for (let i = 1; i < o.length; i++) assert.notEqual(o[i], o[i - 1]);
  }
});

/* ---------------- match ---------------- */

function fake(winner, scores) { return { winner, draw: winner < 0, reason: winner < 0 ? 'time' : 'crash', scores: scores || [0, 0] }; }
test('best of three: two round wins take the match', () => {
  const m = Match.create({ seed: 1, difficulty: 'hard' });
  m.nextRound([straight(), straight()]); assert.equal(m.record(fake(0, [3, 1])), 'between');
  m.nextRound([straight(), straight()]); assert.equal(m.record(fake(1, [0, 2])), 'between');
  m.nextRound([straight(), straight()]); assert.equal(m.record(fake(0, [4, 4])), 'over');
  const res = m.results();
  assert.equal(res.winner, 0);
  assert.deepEqual(res.wins, [2, 1]);
  assert.deepEqual(res.totals, [7, 7]);
  assert.equal(res.rounds.length, 3);
  assert.equal(res.difficulty, 'hard');
});

test('drawn rounds give nobody a point; after three draws the match is settled and always ends', () => {
  let m = Match.create({ seed: 2 });
  m.nextRound([straight(), straight()]); m.record(fake(-1, [2, 2]));
  assert.deepEqual(m.state.wins, [0, 0]);
  m.nextRound([straight(), straight()]); m.record(fake(0, [1, 0]));
  m.nextRound([straight(), straight()]); m.record(fake(-1));
  assert.equal(m.nextRound([straight(), straight()]) !== null, true);
  assert.equal(m.record(fake(-1)), 'over');
  assert.equal(m.results().winner, 0);
  assert.equal(m.results().settledBy, 'rounds');
  m = Match.create({ seed: 3 });
  for (let i = 0; i < 3; i++) { m.nextRound([straight(), straight()]); m.record(fake(-1, [i, 0])); }
  assert.equal(m.state.phase, 'over');
  assert.equal(m.results().settledBy, 'points');
  m = Match.create({ seed: 4 });
  for (let i = 0; i < 3; i++) { m.nextRound([straight(), straight()]); m.record(fake(-1, [1, 1])); }
  assert.equal(m.results().winner, -1);
  assert.ok(Match.MAX_ROUNDS <= 6);
});

test('leaving a match ends it with no winner', () => {
  const m = Match.create({ seed: 1 });
  m.nextRound([straight(), straight()]);
  m.abandon();
  assert.equal(m.state.phase, 'over');
  assert.equal(m.results().winner, null);
  assert.equal(m.nextRound([straight(), straight()]), null);
});

/* ---------------- AI ---------------- */

function aiMatch(a, b, seed) {
  const m = Match.create({ seed, difficulty: b });
  const ais = [];
  while (m.state.phase !== 'over') {
    const c = [AI.create(a, seed * 7 + m.state.rounds.length), AI.create(b, seed * 13 + m.state.rounds.length)];
    ais.push(...c);
    const r = m.nextRound(c);
    r.start(); run(r, 2000);
    m.record(r.state.result);
  }
  return { res: m.results(), ais };
}

test('the AI never asks for a reversal and never steers into a wall it can see when another way is open', () => {
  for (const level of AI.LEVELS) for (const seed of [1, 2, 3]) {
    const ai = AI.create(level, seed);
    const r = Duel.createRound({ map: Maps.ids[seed], event: Events.IDS[seed], seed, controllers: [{ next: (rd, i) => {
      const s = rd.state.snakes[i], d = ai.next(rd, i);
      if (d) assert.ok(!(d.x === -s.dir.x && d.y === -s.dir.y), level + ' reversed');
      const h = s.body[0], open = Duel.DIRS.filter(o => !(o.x === -s.dir.x && o.y === -s.dir.y) && !rd.isWall(h.x + o.x, h.y + o.y) && !rd.segAt(h.x + o.x, h.y + o.y));
      const dd = d || s.dir;
      if (open.length) assert.ok(!rd.isWall(h.x + dd.x, h.y + dd.y), level + ' drove into a wall');
      return d;
    } }, AI.create('medium', 9)] });
    r.start(); run(r, 800);
  }
});

test('hard competes for points: it eats about as often as a food-first player and never goes long without eating', () => {
  const s = Sim.summary(Sim.pairing('hard', 'greedy', 5).hard);
  assert.ok(s.foods >= 8, 'hard ate ' + s.foods + ' per round');
  assert.ok(s.drought <= 15, 'hard went ' + s.drought + ' s without eating');
  assert.ok(s.win >= 50, 'hard won ' + s.win + '% against a food-first player');
});

test('easy is beatable: a beginner-style player wins about as often as it does, and easy still eats and stays safe', () => {
  const t = Sim.pairing('easy', 'novice', 8), e = Sim.summary(t.easy), n = Sim.summary(t.novice);
  assert.ok(n.win >= e.win - 10, 'novice ' + n.win + '% vs easy ' + e.win + '%');
  assert.ok(e.foods >= 3, 'easy ate ' + e.foods);
  const walls = t.easy.filter(r => r.reason === 'wall').length;
  assert.ok(walls <= 2, 'easy drove into a wall ' + walls + ' times');
});

test('medium sits between: it beats easy, loses to hard more often than not, and is even with a solid player', () => {
  const em = Sim.pairing('easy', 'medium', 5), mh = Sim.pairing('medium', 'hard', 4), mg = Sim.pairing('medium', 'greedy', 5);
  assert.ok(Sim.summary(em.medium).win > Sim.summary(em.easy).win, 'medium vs easy');
  assert.ok(Sim.summary(mh.hard).win > Sim.summary(mh.medium).win, 'hard vs medium');
  const g = Sim.summary(mg.medium).win;
  assert.ok(g >= 25 && g <= 80, 'medium vs a solid player: ' + g + '%');
});

test('AI decisions are quick (average well under a frame)', () => {
  const { ais } = aiMatch('hard', 'medium', 3);
  const h = ais.filter(a => a.level === 'hard');
  const total = h.reduce((t, a) => t + a.stats.totalMs, 0), n = h.reduce((t, a) => t + a.stats.decisions, 0);
  assert.ok(n > 100);
  assert.ok(total / n < 5, 'hard average ' + (total / n).toFixed(2) + ' ms');
});

/* ---------------- statistics ---------------- */

function store(init) { const m = Object.assign({}, init); return { m, getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; }

test('stats: a win, a loss and a draw are counted; streaks and wins per level', () => {
  const st = store(), s = Stats.create(st);
  s.recordMatch({ winner: 0, difficulty: 'hard', rounds: [{ winner: 0, scores: [3, 1] }, { draw: true, winner: -1, scores: [1, 1] }, { winner: 0, scores: [2, 0] }] });
  s.recordMatch({ winner: 0, difficulty: 'easy', rounds: [{ winner: 0, scores: [1, 0] }, { winner: 0, scores: [1, 0] }] });
  s.recordMatch({ winner: 1, difficulty: 'medium', rounds: [{ winner: 1, scores: [0, 1] }, { winner: 1, scores: [0, 1] }] });
  s.recordMatch({ winner: -1, difficulty: 'medium', rounds: [] });
  const g = Stats.create(st).get();                                  // read back from storage
  assert.deepEqual([g.played, g.won, g.lost, g.drawn], [4, 2, 1, 1]);
  assert.deepEqual([g.roundsWon, g.roundsLost, g.roundsDrawn], [4, 2, 1]);
  assert.deepEqual(g.winsBy, { easy: 1, medium: 0, hard: 1 });
  assert.equal(g.bestStreak, 2);
  assert.equal(g.streak, 0);
});

test('stats: their own key only, broken data never crashes, an abandoned match is not counted', () => {
  const st = store({ 'gridsnake-profile-v2': '{"keep":1}', [Stats.KEY]: '{not json' });
  const s = Stats.create(st);
  assert.equal(s.get().played, 0);
  assert.equal(s.recordMatch({ winner: null }), false);
  s.recordMatch({ winner: 0, difficulty: 'medium', rounds: [] });
  assert.equal(st.m['gridsnake-profile-v2'], '{"keep":1}');
  assert.deepEqual(Object.keys(st.m).sort(), ['gridsnake-profile-v2', Stats.KEY].sort());
  assert.equal(Stats.sanitize({ played: -4, won: 'x', winsBy: { hard: 1e3 } }).played, 0);
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const t = Stats.create(throwing);
  t.recordMatch({ winner: 0, difficulty: 'easy', rounds: [] });
  assert.equal(t.get().won, 1);
});

/* ---------------- the page ---------------- */

test('src/duel/ui.js shares the page script: none of its names may replace one of the page (a clash broke drawing once)', () => {
  const fs = require('fs'), path = require('path');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'duel', 'ui.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.template.html'), 'utf8').replace(ui, '').replace('/*@include src/duel/ui.js*/', '');
  const top = [...ui.matchAll(/^  (?:function ([A-Za-z0-9_$]+)|var ([A-Za-z0-9_$]+))/gm)].map(m => m[1] || m[2]);
  assert.ok(top.length > 20);
  for (const name of top) {
    const re = new RegExp('(function ' + name + '\b|var ' + name + '\b|[,] ' + name + ' =)');
    assert.ok(!re.test(page), name + ' is already defined by the page');
  }
});
