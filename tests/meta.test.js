'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../src/engine.js');
const Achievements = require('../src/achievements.js');
const Profile = require('../src/profile.js');
const Tracker = require('../src/tracker.js');

const MODES = Object.keys(Engine.MODES);
const IDS = Achievements.CHAINS.map(a => a.id);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fakeStorage(initial) {
  const m = Object.assign({}, initial || {});
  return {
    data: m,
    getItem: k => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); }
  };
}
function brokenStorage() {
  return { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
}
function newProfile(storage, now) {
  return Profile.create(storage, { modes: MODES, achievementIds: IDS, now: now || (() => 1700000000000) });
}
function feed(g, ms) {
  while (ms > 0 && g.state.phase === 'running') { const d = Math.min(ms, g.tuning.maxDt); g.update(d); ms -= d; }
}
function stepOnce(g) { feed(g, g.interval()); }
function eatOne(g) {
  const h = g.state.snake[0], d = g.state.dir;
  g.state.food = { x: (h.x + d.x + 20) % 20, y: (h.y + d.y + 20) % 20 };
  stepOnce(g);
  g.state.snake = g.state.snake.slice(0, 4);
}
function newGame(mode, edge, seed) {
  const g = Engine.create({ mode, edge: edge || 'wrap', rng: mulberry32(seed || 3) });
  g.start();
  if (g.state.timeLeft !== null) g.state.timeLeft = 1e9;
  return g;
}

/* =====================================================================
   PHASE 4a: achievement rules
   ===================================================================== */

/* =====================================================================
   PHASE 4b: saving between sessions
   ===================================================================== */

test('P4 a fresh profile starts in Classic with walls and zero everything', () => {
  const p = newProfile(fakeStorage());
  assert.deepEqual(p.getPrefs(), { mode: 'classic', edge: 'walls', skin: 'emerald', style: 'solid', board: 'midnight', food: 'dot', golden: false, sound: true, volume: 1, haptics: true, motion: 'auto', difficulty: 'auto', controls: 'auto' });
  assert.deepEqual(p.getTotals(), { foods: 0, bonus: 0, runs: 0 });
  assert.equal(Object.keys(p.achMap()).length, 0);
  assert.equal(p.getBest('classic', 'walls'), 0);
});

test('P4 best scores only go up, are kept per mode and per edge, and Classic keeps the older storage key', () => {
  const st = fakeStorage({ 'gridsnake-best-walls': '14' });       // a score saved by the version before modes
  const p = newProfile(st);
  assert.equal(p.getBest('classic', 'walls'), 14, 'the old score is still there');
  assert.equal(p.setBest('classic', 'walls', 10), false);
  assert.equal(p.getBest('classic', 'walls'), 14);
  assert.equal(p.setBest('classic', 'walls', 20), true);
  assert.equal(st.data['gridsnake-best-walls'], '20');
  assert.equal(p.getBest('classic', 'wrap'), 0);
  assert.equal(p.getBest('timeattack', 'walls'), 0);
  p.setBest('timeattack', 'walls', 8);
  assert.equal(p.getBest('classic', 'walls'), 20);
  assert.equal(p.getBest('timeattack', 'walls'), 8);
});

test('P4 corrupted or hostile saved data falls back to safe defaults', () => {
  const bad = [
    'not json', '[]', 'null', '123',
    JSON.stringify({ prefs: { mode: 'hack', edge: 'x' }, totals: { foods: -5, bonus: 'a', runs: Infinity }, ach: { apples: 'yes', nope: 5, score: { tier: -1, progress: 'x' } } })
  ];
  bad.forEach(raw => {
    const p = newProfile(fakeStorage({ [Profile.KEY]: raw }));
    assert.deepEqual(p.getPrefs(), { mode: 'classic', edge: 'walls', skin: 'emerald', style: 'solid', board: 'midnight', food: 'dot', golden: false, sound: true, volume: 1, haptics: true, motion: 'auto', difficulty: 'auto', controls: 'auto' }, raw);
    assert.deepEqual(p.getTotals(), { foods: 0, bonus: 0, runs: 0 }, raw);
    assert.ok(Object.values(p.achMap()).every(a => a.tier === 0 && a.progress === 0), raw);
    assert.equal(p.getName(), '', raw);
  });
});

test('P4 when storage throws, everything still works in memory for the session', () => {
  const p = newProfile(brokenStorage());
  p.setPrefs({ mode: 'timeattack' });
  p.addTotal('foods', 3);
  assert.equal(p.setAch('apples', { tier: 1, progress: 0 }), true);
  assert.equal(p.setAch('nope', { tier: 1, progress: 0 }), false, 'unknown ids are refused');
  p.setBest('classic', 'walls', 5);
  assert.equal(p.getPrefs().mode, 'timeattack');
  assert.equal(p.getTotals().foods, 3);
  assert.equal(p.getBest('classic', 'walls'), 5);
  const q = newProfile(null);
  q.addTotal('foods');
  assert.equal(q.getTotals().foods, 1);
});

/* =====================================================================
   PHASE 4c: the tracker, with real games
   ===================================================================== */

test('P4 tracker: best score updates live, only upward, and reports a new best', () => {
  const p = newProfile(fakeStorage());
  p.setBest('classic', 'wrap', 2);
  const g = newGame('classic');
  const bests = [];
  const t = Tracker.attach(g, p, { onBest: b => bests.push(b) });
  eatOne(g); eatOne(g);
  assert.deepEqual(bests, [], 'a tie is not a new best');
  assert.equal(t.info.newBest, false);
  eatOne(g);
  assert.deepEqual(bests, [3]);
  assert.equal(t.info.newBest, true);
  assert.equal(p.getBest('classic', 'wrap'), 3);
});

test('P4 tracker: runs are counted when a run ends, once', () => {
  const p = newProfile(fakeStorage());
  const g = newGame('classic', 'walls');
  Tracker.attach(g, p);
  g.state.snake[0].x = 19;
  stepOnce(g);
  assert.equal(g.state.phase, 'over');
  assert.equal(p.getTotals().runs, 1);
  stepOnce(g); g.update(100);
  assert.equal(p.getTotals().runs, 1);
});

test('P4 restart keeps the permanent stats: a new game starts clean while the profile is untouched', () => {
  const st = fakeStorage();
  const p = newProfile(st);
  const g1 = newGame('classic');
  Tracker.attach(g1, p);
  for (let i = 0; i < 11; i++) eatOne(g1);
  const before = JSON.stringify([p.getTotals(), p.achMap(), p.getBest('classic', 'wrap')]);

  const g2 = newGame('classic');                      // "Restart"
  Tracker.attach(g2, p);
  assert.equal(g2.state.score, 0);
  assert.equal(g2.state.level, 1);
  assert.equal(JSON.stringify([p.getTotals(), p.achMap(), p.getBest('classic', 'wrap')]), before);
});

test('P4 snake colour is saved, unknown colours are ignored', () => {
  const store = {}; const st = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const mk = () => Profile.create(st, { modes: ["classic"], skins: ['emerald', 'ocean'], achievementIds: [] });
  const a = mk();
  a.setPrefs({ skin: 'ocean' });
  assert.equal(mk().getPrefs().skin, 'ocean');
  a.setPrefs({ skin: 'neon-pink' });
  assert.equal(mk().getPrefs().skin, 'ocean');
  store['gridsnake-profile-v2'] = JSON.stringify({ prefs: { skin: '<script>' } });
  assert.equal(mk().getPrefs().skin, 'emerald');
});

test('P4 golden-apple setting is saved, and golden best scores are kept apart', () => {
  const store = {}; const st = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const mk = () => Profile.create(st, { modes: ['classic'], achievementIds: [] });
  const a = mk();
  assert.equal(a.getPrefs().golden, false);
  a.setPrefs({ golden: true });
  assert.equal(mk().getPrefs().golden, true);
  a.setPrefs({ golden: 'yes' });
  assert.equal(mk().getPrefs().golden, true, 'non-boolean ignored');
  a.setBest('classic', 'walls', 12);
  a.setBest('classic', 'walls', 40, true);
  assert.equal(a.getBest('classic', 'walls'), 12);
  assert.equal(a.getBest('classic', 'walls', true), 40);
});

test('P4 sound setting defaults to on, is saved, and ignores junk', () => {
  const store = {}; const st = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const mk = () => Profile.create(st, { modes: ['classic'], achievementIds: [] });
  const a = mk();
  assert.equal(a.getPrefs().sound, true);
  a.setPrefs({ sound: false });
  assert.equal(mk().getPrefs().sound, false);
  a.setPrefs({ sound: 'loud' });
  assert.equal(mk().getPrefs().sound, false);
});

test('P4 looks (style, board, food) default sensibly, are saved, and unknown values are ignored', () => {
  const store = {}; const st = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const mk = () => Profile.create(st, { modes: ['classic'], achievementIds: [], skins: ['emerald', 'rose'], styles: ['solid', 'rainbow'], boards: ['midnight', 'dusk'], foods: ['dot', 'apple'] });
  const a = mk();
  assert.deepEqual([a.getPrefs().style, a.getPrefs().board, a.getPrefs().food], ['solid', 'midnight', 'dot']);
  a.setPrefs({ style: 'rainbow', board: 'dusk', food: 'apple', skin: 'rose' });
  const b = mk().getPrefs();
  assert.deepEqual([b.style, b.board, b.food, b.skin], ['rainbow', 'dusk', 'apple', 'rose']);
  a.setPrefs({ style: 'glitter', board: 'x', food: 5 });
  assert.deepEqual([mk().getPrefs().style, mk().getPrefs().board, mk().getPrefs().food], ['rainbow', 'dusk', 'apple']);
  store['gridsnake-profile-v2'] = JSON.stringify({ prefs: { style: { evil: 1 }, board: '<b>', food: null } });
  const c = mk().getPrefs();
  assert.deepEqual([c.style, c.board, c.food], ['solid', 'midnight', 'dot']);
});

test('M-polish: volume, vibration and animation prefs are validated and saved; reset clears progress only', () => {
  const st = fakeStorage();
  const p = newProfile(st);
  p.setPrefs({ volume: 0.5, haptics: false, motion: 'off', skin: 'emerald' });
  p.setPrefs({ volume: 7, motion: 'sideways' });                        // invalid values are ignored
  assert.equal(p.getPrefs().volume, 0.5);
  assert.equal(p.getPrefs().motion, 'off');
  assert.equal(p.getPrefs().haptics, false);
  const q = newProfile(st);
  assert.deepEqual([q.getPrefs().volume, q.getPrefs().haptics, q.getPrefs().motion], [0.5, false, 'off']);
  p.addTotal('foods', 5); p.setAch('apples', { tier: 2, progress: 3 }); p.setBest('classic', 'walls', 9); p.setBest('survival', 'wrap', 4, true);
  p.resetProgress();
  assert.equal(p.getTotals().foods, 0);
  assert.equal(Object.keys(p.achMap()).length, 0);
  assert.equal(p.getBest('classic', 'walls'), 0);
  assert.equal(p.getBest('survival', 'wrap', true), 0);
  assert.equal(p.getPrefs().volume, 0.5, 'settings survive a reset');
  assert.equal(newProfile(st).getBest('classic', 'walls'), 0, 'and it is saved');
  const bad = newProfile(fakeStorage({ 'gridsnake-profile-v2': JSON.stringify({ prefs: { volume: 'loud', motion: 3, haptics: 'no' } }) }));
  assert.deepEqual([bad.getPrefs().volume, bad.getPrefs().haptics, bad.getPrefs().motion], [1, true, 'auto']);
});

test('M-shop: coins, buying, ownership gates premium looks, reset wipes purchases', () => {
  const st = fakeStorage();
  const mk = () => Profile.create(st, { modes: MODES, achievementIds: IDS, skins: ['emerald', 'jordan'], boards: ['midnight', 'neon'], premium: ['skin:jordan', 'board:neon'] });
  const p = mk();
  p.setPrefs({ skin: 'jordan' });
  assert.equal(p.getPrefs().skin, 'emerald', 'not bought, not usable');
  assert.equal(p.buy('skin:jordan', 100), false, 'no coins yet');
  p.addCoins(150); p.addCoins(-5); p.addCoins(2.7);
  assert.equal(p.getCoins(), 152);
  assert.equal(p.buy('skin:nope', 1), false);
  assert.equal(p.buy('skin:jordan', 100), true);
  assert.equal(p.getCoins(), 52);
  assert.equal(p.buy('skin:jordan', 1), false, 'cannot buy twice');
  assert.equal(p.owns('skin:jordan'), true); assert.equal(p.owns('board:neon'), false); assert.equal(p.owns('skin:emerald'), true);
  p.setPrefs({ skin: 'jordan' });
  const q = mk();
  assert.equal(q.getPrefs().skin, 'jordan'); assert.equal(q.getCoins(), 52);
  q.resetProgress();
  assert.equal(q.getCoins(), 0); assert.equal(q.owns('skin:jordan'), false); assert.equal(q.getPrefs().skin, 'emerald');
  const hacked = Profile.create(fakeStorage({ 'gridsnake-profile-v2': JSON.stringify({ coins: -4, owned: { 'skin:jordan': 'yes' }, prefs: { skin: 'jordan' } }) }), { skins: ['emerald', 'jordan'], premium: ['skin:jordan'] });
  assert.equal(hacked.getCoins(), 0); assert.equal(hacked.getPrefs().skin, 'emerald');
});

test('M-coins: a finished run pays its score, an achievement pays a bonus', () => {
  const st = fakeStorage();
  const prof = newProfile(st);
  const g = Engine.create({ mode: 'classic', edge: 'walls', rng: mulberry32(3) });
  const t = Tracker.attach(g, prof, {});
  g.start();
  g.state.score = 7; g.state.phase = 'running';
  g.state.snake = [{ x: 19, y: 10 }, { x: 18, y: 10 }, { x: 17, y: 10 }]; g.state.dir = { x: 1, y: 0 };
  feed(g, 2000);
  assert.equal(g.state.phase, 'over');
  assert.equal(t.info.coins, prof.getCoins());
  assert.ok(prof.getCoins() >= 7, 'score paid: ' + prof.getCoins());
});

/* =====================================================================
   Achievement chains, name, backup code
   ===================================================================== */

test('A1 every chain has unique ids, rising goals and positive rewards', () => {
  assert.equal(new Set(IDS).size, IDS.length);
  Achievements.CHAINS.forEach(c => {
    assert.ok(c.name && c.text && c.group && (c.kind === 'sum' || c.kind === 'run'), c.id);
    c.tiers.forEach((t, i) => { assert.ok(t.goal > 0 && t.reward > 0, c.id); if (i) assert.ok(t.goal > c.tiers[i - 1].goal, c.id + ' goals rise'); });
  });
  assert.equal(Achievements.totalTiers(), Achievements.CHAINS.reduce((n, c) => n + c.tiers.length, 0));
});

test('A2 a "sum" chain pays at its goal, then starts again from zero for a bigger goal', () => {
  const c = Achievements.byId('apples');
  let r = Achievements.advance(c, {}, 24);
  assert.deepEqual([r.state, r.finished.length], [{ tier: 0, progress: 24 }, 0]);
  r = Achievements.advance(c, r.state, 1);
  assert.equal(r.finished.length, 1);
  assert.equal(r.finished[0].goal, 25); assert.equal(r.finished[0].reward, c.tiers[0].reward);
  assert.deepEqual(r.state, { tier: 1, progress: 0 }, 'the next tier starts at zero');
  assert.equal(Achievements.view(c, r.state).goal, 100);
  r = Achievements.advance(c, r.state, 99);
  assert.equal(r.finished.length, 0, '99 of 100 is not enough');
  r = Achievements.advance(c, r.state, 1);
  assert.equal(r.finished[0].goal, 100);
});

test('A3 a "run" chain needs one run to reach the goal and passes several tiers at once', () => {
  const c = Achievements.byId('score');
  let r = Achievements.advance(c, {}, 9);
  assert.equal(r.finished.length, 0);
  r = Achievements.advance(c, r.state, 60);
  assert.deepEqual(r.finished.map(f => f.goal), [10, 25, 50]);
  assert.equal(r.state.tier, 3);
  assert.equal(Achievements.view(c, r.state).progress, 60);
});

test('A4 the last tier completes the chain and nothing more is paid', () => {
  const c = Achievements.byId('golden');
  let st = {}, paid = 0;
  for (let i = 0; i < 300; i++) { const r = Achievements.advance(c, st, 1); st = r.state; paid += r.finished.reduce((n, f) => n + f.reward, 0); }
  assert.equal(Achievements.done(c, st), true);
  assert.equal(paid, c.tiers.reduce((n, t) => n + t.reward, 0));
  assert.equal(Achievements.view(c, st).complete, true);
  assert.equal(Achievements.advance(c, st, 50).finished.length, 0);
});

test('A5 hostile saved chain data is cleaned', () => {
  const c = Achievements.byId('apples');
  assert.deepEqual(Achievements.clean(c, { tier: -3, progress: 'x' }), { tier: 0, progress: 0 });
  assert.equal(Achievements.clean(c, { tier: 999, progress: 5 }).tier, c.tiers.length);
  assert.deepEqual(Achievements.clean(c, null), { tier: 0, progress: 0 });
});

function chainRun(prof, mode, setup, ms) {
  const g = Engine.create({ mode, edge: 'walls', rng: mulberry32(11) });
  const unlocked = [];
  const t = Tracker.attach(g, prof, { onUnlock: f => unlocked.push(f) });
  g.start();
  if (setup) setup(g);
  if (ms) feed(g, ms);
  return { g, t, unlocked };
}

test('T1 tracker: eating 25 foods pays the first tier once and restarts the count', () => {
  const prof = newProfile(fakeStorage());
  const { g, unlocked } = chainRun(prof, 'classic');
  for (let i = 0; i < 25; i++) {
    const s = g.state, h = s.snake[0];
    s.snake = [{ x: 2, y: 2 }, { x: 1, y: 2 }, { x: 0, y: 2 }]; s.goldSegs = [false, false, false]; s.dir = { x: 1, y: 0 }; s.queue = [];
    s.food = { x: 3, y: 2 }; s.pickup = null; s.gold = null;
    feed(g, g.interval() + 1);
  }
  const first = unlocked.filter(f => f.chain === 'apples');
  assert.equal(first.length, 1);
  assert.equal(first[0].tier, 1);
  assert.deepEqual(prof.getAch('apples'), { tier: 1, progress: 0 });
  assert.ok(prof.getCoins() >= first[0].reward);
  assert.equal(prof.getTotals().foods, 25, 'lifetime totals keep counting');
});

test('T2 tracker: run goals use the current run and do not repeat once paid', () => {
  const prof = newProfile(fakeStorage());
  const a = chainRun(prof, 'classic', g => { g.state.score = 12; }, 0);
  a.t.tick();
  assert.deepEqual(a.unlocked.filter(f => f.chain === 'score').map(f => f.goal), [10]);
  a.t.tick(); a.t.tick();
  assert.equal(a.unlocked.filter(f => f.chain === 'score').length, 1, 'ticking again pays nothing');
  const b = chainRun(prof, 'classic', g => { g.state.score = 12; }, 0);
  b.t.tick();
  assert.equal(b.unlocked.filter(f => f.chain === 'score').length, 0, 'the 10-point tier is already done; 12 is below 25');
});

test('T3 tracker: mode chains only count in their own mode', () => {
  const prof = newProfile(fakeStorage());
  const c = chainRun(prof, 'classic', g => { g.state.score = 40; }); c.t.tick();
  assert.equal(c.unlocked.filter(f => f.chain === 'clock').length, 0);
  const t = chainRun(prof, 'timeattack', g => { g.state.score = 20; }); t.t.tick();
  assert.deepEqual(t.unlocked.filter(f => f.chain === 'clock').map(f => f.goal), [15]);
  const s = chainRun(prof, 'survival', g => { g.state.elapsed = 95000; }); s.t.tick();
  assert.deepEqual(s.unlocked.filter(f => f.chain === 'survivor').map(f => f.goal), [30, 90]);
});

test('T4 tracker: a finished run pays score coins and counts toward the Regular chain', () => {
  const prof = newProfile(fakeStorage());
  const { g, t } = chainRun(prof, 'classic', g => {
    g.state.score = 7; g.state.snake = [{ x: 19, y: 10 }, { x: 18, y: 10 }, { x: 17, y: 10 }]; g.state.goldSegs = [false, false, false]; g.state.dir = { x: 1, y: 0 };
  }, 1500);
  assert.equal(g.state.phase, 'over');
  assert.ok(prof.getCoins() >= 7);
  assert.equal(t.info.coins, prof.getCoins());
  assert.deepEqual(prof.getAch('runs'), { tier: 0, progress: 1 });
});

test('N1 names are trimmed, limited to 16 characters, stripped of markup, and saved', () => {
  const st = fakeStorage();
  const p = newProfile(st);
  assert.equal(p.setName('  Waseem  '), 'Waseem');
  assert.equal(p.setName('<b>Waseem</b>&"x"'), 'bWaseem/bx');
  assert.equal(p.setName('a'.repeat(40)).length, 16);
  assert.equal(p.setName('وسيم الأردني'), 'وسيم الأردني');
  assert.equal(p.setName(12345), '');
  p.setName('Waseem');
  assert.equal(newProfile(st).getName(), 'Waseem');
});

test('B1 a backup code restores everything on a fresh device, and rejects junk', () => {
  const mkp = st => Profile.create(st, { modes: MODES, achievementIds: IDS, skins: ['emerald', 'jordan'], premium: ['skin:jordan'] });
  const a = mkp(fakeStorage());
  a.setName('وسيم'); a.addCoins(500); a.buy('skin:jordan', 150); a.setPrefs({ skin: 'jordan', mode: 'survival' });
  a.setAch('apples', { tier: 2, progress: 40 }); a.addTotal('foods', 130); a.setBest('survival', 'walls', 77);
  const code = a.exportCode();
  assert.match(code, /^GS2\./);
  const b = mkp(fakeStorage());
  assert.equal(b.importCode('  ' + code.replace(/(.{20})/g, '$1\n') + ' '), true, 'whitespace in a pasted code is fine');
  assert.equal(b.getName(), 'وسيم'); assert.equal(b.getCoins(), 350); assert.equal(b.owns('skin:jordan'), true);
  assert.equal(b.getPrefs().skin, 'jordan'); assert.equal(b.getPrefs().mode, 'survival');
  assert.deepEqual(b.getAch('apples'), { tier: 2, progress: 40 });
  assert.equal(b.getTotals().foods, 130); assert.equal(b.getBest('survival', 'walls'), 77);
  const c = mkp(fakeStorage());
  ['', 'GS2.', 'GS2.@@@', 'hello', 'GS2.' + Buffer.from('{"v":1}').toString('base64'), 'GS2.' + Buffer.from('{"v":2,"data":5}').toString('base64')].forEach(bad => {
    assert.equal(c.importCode(bad), false, bad);
  });
  assert.equal(c.getCoins(), 0, 'a bad code changes nothing');
});

test('B2 an imported code cannot grant coins or skins that are not valid', () => {
  const mkp = () => Profile.create(fakeStorage(), { modes: MODES, achievementIds: IDS, skins: ['emerald', 'jordan'], premium: ['skin:jordan'] });
  const o = mkp(); 
  const evil = { v: 2, savedAt: 1, data: { coins: -50, owned: { 'skin:nope': true, 'skin:jordan': 'yes' }, prefs: { skin: 'jordan' }, name: '<script>' }, bests: { 'gridsnake-best-walls': -9, other: 5 } };
  assert.equal(o.importData(evil), true);
  assert.equal(o.getCoins(), 0); assert.equal(o.owns('skin:jordan'), false); assert.equal(o.getPrefs().skin, 'emerald');
  assert.equal(o.getName(), 'script'); assert.equal(o.getBest('classic', 'walls'), 0);
});

test('B3 profile reports changes (for the online copy) and keeps a saved time', () => {
  let t = 1000;
  const p = Profile.create(fakeStorage(), { modes: MODES, achievementIds: IDS, now: () => t });
  let n = 0; p.onChange(() => { n++; });
  p.addCoins(5); t = 2000; p.setName('x');
  assert.equal(n, 2); assert.equal(p.getSavedAt(), 2000);
});
