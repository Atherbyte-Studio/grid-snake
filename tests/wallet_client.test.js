'use strict';
/* The wallet on the web page: the server's coins and items replace the device's, purchases go through the Worker, and runs
 * claim their coins (src/web/account-link.js, src/profile.js). No network: the Worker is faked.
 * Run: node --test tests/wallet_client.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const AL = require('../src/web/account-link.js');
const SnakeProfile = require('../src/profile.js');
const Engine = require('../src/engine.js');

function storage(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] || null, get length() { return m.size; }, map: m };
}
const RONALDO = { id: '11111111-1111-4111-8111-111111111111', username: 'ronaldo' };
const PRICE = { 'skin:cyber': 500, 'board:chess': 1600 };

/* The wallet routes of atherbyte-api, in memory. */
function worker(opts = {}) {
  const w = { calls: [], coins: opts.coins === undefined ? 700 : opts.coins, owned: opts.owned || {}, runs: {}, runSeq: 0, rounds: {}, ranked: opts.ranked || 'ok', paid: [] };
  const wallet = () => ({ wallet: true, coins: w.coins, owned: { ...w.owned } });
  w.authed = (p, init) => {
    const method = (init && init.method) || 'GET', body = init && init.body;
    w.calls.push({ path: p, method, body });
    const ok = (data) => Promise.resolve({ ok: true, status: 200, data });
    const err = (status, error, extra) => Promise.resolve({ ok: false, status, data: Object.assign({ error }, extra), code: error });
    if (opts.noWallet && /\/(wallet|run)/.test(p)) return err(404, 'not_found');
    if (p.endsWith('/wallet')) return opts.pending ? ok({ wallet: true, pending: true }) : ok(wallet());
    if (p.endsWith('/wallet/buy')) {
      if (!PRICE[body.item]) return err(400, 'unknown_item');
      if (w.owned[body.item]) return err(409, 'already_owned', wallet());
      if (w.coins < PRICE[body.item]) return err(402, 'not_enough_coins', wallet());
      w.coins -= PRICE[body.item]; w.owned[body.item] = true;
      return ok({ ...wallet(), bought: body.item });
    }
    if (p.endsWith('/wallet/claims')) {
      w.paid.push(...body.claims);
      return ok({ ...wallet(), gained: 0 });
    }
    if (p.endsWith('/run')) { const id = '22222222-2222-4222-8222-' + String(++w.runSeq).padStart(12, '0'); w.runs[id] = { mode: body.mode, state: 'open' }; return ok({ run_id: id }); }
    if (p.endsWith('/run/claim')) {
      const r = w.runs[body.run_id];
      if (!r) return err(404, 'run_not_found');
      if (r.state !== 'open') return err(409, 'run_closed');
      r.state = 'used'; w.coins += Math.min(body.score, 30);
      return ok({ ...wallet(), gained: Math.min(body.score, 30) });
    }
    if (p.endsWith('/round')) { const id = 'r-' + (++w.runSeq); w.rounds[id] = 'open'; return ok({ round_id: id, seed: 1000 + w.runSeq, engine: AL.ENGINE_SHA, record_format: 2, started_at: 't', expires_at: 't' }); }
    if (p.endsWith('/score')) {
      if (w.ranked === 'mismatch') return err(422, 'replay_mismatch');
      if (w.ranked === 'no-round') return err(404, 'round_not_found');
      w.coins += body.score;
      return ok({ improved: true, best: body.score, rank: 1, ...wallet(), gained: body.score });
    }
    if (p.endsWith('/player')) return ok({ linked: true, name: 'ronaldo', best: null, rank: null, save: null });
    return err(404, 'not_found');
  };
  return w;
}
const account = (w) => ({ isConfigured: () => true, hasSession: () => true, username: () => 'ronaldo', getSession: () => ({ user: RONALDO }), authed: w.authed,
  me: () => Promise.resolve({ ok: true, profile: { id: RONALDO.id, username: 'ronaldo' } }) });
const profileData = (extra) => JSON.stringify(Object.assign({ prefs: {}, coins: 99999, owned: { 'skin:cyber': true }, totals: { runs: 1 }, ach: { apples: { tier: 2, progress: 4 }, golden: { tier: 1, progress: 0 } }, savedAt: 5 }, extra));
function setup(opts) {
  const w = worker(opts), st = storage({ 'gridsnake-profile-v2': profileData() });
  const core = AL.create({ account: account(w), storage: st, now: () => 42 });
  core.bind();
  return { w, st, core };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pay = (w, path) => w.calls.filter((c) => c.path.endsWith(path));

test('profile.setWallet: the server replaces coins and items, drops the unknown, resets a look it does not hold, and is not progress', () => {
  const st = storage();
  let woke = 0;
  const p = SnakeProfile.create(st, { modes: ['classic'], skins: ['emerald', 'cyber'], boards: ['midnight', 'chess'], premium: ['skin:cyber', 'board:chess'], achievementIds: [] });
  p.addCoins(5000); p.buy('skin:cyber', 500); p.setPrefs({ skin: 'cyber' });
  p.onChange(() => { woke++; });
  const at = p.getSavedAt();
  assert.ok(p.setWallet({ coins: 120, owned: { 'board:chess': true, 'skin:nope': true, 'skin:cyber': 'yes' } }));
  assert.equal(p.getCoins(), 120);
  assert.equal(p.owns('board:chess'), true);
  assert.equal(p.owns('skin:cyber'), false, 'only a true counts');
  assert.equal(p.getPrefs().skin, 'emerald', 'an equipped look the wallet does not hold goes back to the default');
  assert.equal(p.getSavedAt(), at, 'it does not look like new progress');
  assert.equal(woke, 0, 'and does not wake the sync');
  assert.equal(JSON.parse(st.getItem('gridsnake-profile-v2')).coins, 120, 'but it is stored');
  assert.equal(p.setWallet(null), false);
  assert.equal(p.setWallet({ coins: -5, owned: [] }), true);
  assert.equal(p.getCoins(), 0);
});

test('wallet: a Worker without it keeps the game on its own coins', async () => {
  const { core } = setup({ noWallet: true });
  assert.equal(await core.loadWallet(), false);
  assert.equal(core.walletApi().isOn(), false);
  const b = await core.walletApi().buy('skin:cyber');
  assert.equal(b.ok, false);
});

test('wallet: a player whose progress is not saved yet is not switched on', async () => {
  const { core } = setup({ pending: true });
  assert.equal(await core.loadWallet(), false);
  assert.equal(core.walletApi().isOn(), false);
});

test('wallet: the server\'s coins and items reach the game, before and after it attaches', async () => {
  const { core } = setup({ coins: 321, owned: { 'skin:cyber': true } });
  assert.equal(await core.loadWallet(), true);
  const api = core.walletApi();
  assert.equal(api.isOn(), true);
  const got = [];
  api.attach((x) => got.push(x));
  assert.deepEqual(got, [{ coins: 321, owned: { 'skin:cyber': true } }], 'a wallet that arrived first is handed over at once');
  await api.buy('board:chess');         // not enough coins: the answer still carries the true balance
  assert.deepEqual(got[got.length - 1], { coins: 321, owned: { 'skin:cyber': true } });
});

test('wallet: buying goes through the Worker; a refusal says why and a repeat is not charged', async () => {
  const { core, w } = setup({ coins: 600 });
  await core.loadWallet();
  const api = core.walletApi(), seen = [];
  api.attach((x) => seen.push(x));
  assert.deepEqual(await api.buy('board:chess'), { ok: false, message: 'Not enough coins.' });
  assert.deepEqual(await api.buy('skin:cyber'), { ok: true });
  assert.deepEqual(seen[seen.length - 1], { coins: 100, owned: { 'skin:cyber': true } });
  assert.deepEqual(await api.buy('skin:cyber'), { ok: true }, 'already owned counts as done');
  assert.equal(w.coins, 100);
  const buys = pay(w, '/wallet/buy');
  assert.ok(buys.every((c) => Object.keys(c.body).join() === 'item'), 'only the item id is sent: no price, no balance');
});

test('wallet: a run that is not ranked is opened when it starts and claimed once when it ends', async () => {
  const { core, w } = setup({ coins: 0 });
  await core.loadWallet();
  const seen = []; core.walletApi().attach((x) => seen.push(x));
  const E = Object.assign({}, Engine);
  AL.patchEngine(E, core);
  const g = E.create({ mode: 'classic', edge: 'walls', golden: false, tuning: E.DIFFICULTY.hard });
  assert.equal(pay(w, '/run').length, 0, 'nothing is opened until the run starts');
  g.start();
  await sleep(5);
  assert.equal(pay(w, '/run').length, 1);
  assert.equal(pay(w, '/run')[0].body.mode, 'classic');
  g.state.score = 25;
  for (let i = 0; i < 400 && g.state.phase !== 'over'; i++) g.update(100);
  assert.equal(g.state.phase, 'over');
  await sleep(20);
  const claims = pay(w, '/run/claim');
  assert.equal(claims.length, 1);
  assert.equal(claims[0].body.score, 25);
  assert.deepEqual(Object.keys(claims[0].body).sort(), ['run_id', 'score']);
  assert.equal(seen[seen.length - 1].coins, 25, 'the server\'s answer is what the game shows');
});

test('wallet: a run of 0 points claims nothing, and a run started offline claims nothing', async () => {
  const { core, w } = setup({ coins: 0 });
  await core.loadWallet();
  const E = Object.assign({}, Engine); AL.patchEngine(E, core);
  const g = E.create({ mode: 'survival', edge: 'walls', golden: false, tuning: E.DIFFICULTY.hard });
  g.start(); await sleep(5);
  for (let i = 0; i < 400 && g.state.phase !== 'over'; i++) g.update(100);
  await sleep(10);
  assert.equal(pay(w, '/run/claim').length, 0);
  const off = setup({ coins: 0, noWallet: true });
  await off.core.loadWallet();
  const E2 = Object.assign({}, Engine); AL.patchEngine(E2, off.core);
  const g2 = E2.create({ mode: 'classic', edge: 'walls', golden: false, tuning: E2.DIFFICULTY.hard });
  g2.start(); g2.state.score = 40;
  for (let i = 0; i < 400 && g2.state.phase !== 'over'; i++) g2.update(100);
  await sleep(10);
  assert.equal(pay(off.w, '/run').length, 0, 'with no wallet nothing is opened');
});

function playRanked(core, E) {
  const g = E.create({ mode: 'timeattack', edge: 'walls', golden: true, tuning: E.DIFFICULTY.hard });
  g.start();
  g.state.score = 30;
  for (let i = 0; i < 1000 && g.state.phase !== 'over'; i++) g.update(100);
  return g;
}

test('wallet: a ranked round is paid by its replayed score and never also by time', async () => {
  const { core, w } = setup({ coins: 0 });
  await core.loadWallet(); core.prefetch(); await sleep(5);
  const E = Object.assign({}, Engine); AL.patchEngine(E, core);
  const g = playRanked(core, E);
  await sleep(10);
  assert.equal(pay(w, '/run/claim').length, 0, 'a ranked run waits for the board\'s answer');
  const r = await core.submitScore(g.state.score);
  assert.equal(r.ok, true);
  await sleep(20);
  assert.equal(pay(w, '/run/claim').length, 0, 'and is not claimed by time once the board paid it');
  assert.equal(w.coins, g.state.score);
});

test('wallet: a ranked run that cannot be ranked (no round) is paid by time; one whose replay does not match is paid nothing', async () => {
  for (const [ranked, claims] of [['no-round', 1], ['mismatch', 0]]) {
    const { core, w } = setup({ coins: 0, ranked });
    await core.loadWallet(); core.prefetch(); await sleep(5);
    const E = Object.assign({}, Engine); AL.patchEngine(E, core);
    const g = playRanked(core, E);
    await core.submitScore(g.state.score);
    await sleep(20);
    assert.equal(pay(w, '/run/claim').length, claims, ranked);
  }
});

test('wallet: finished achievement tiers are claimed once, with only their ids', async () => {
  const { core, w } = setup({ coins: 0 });
  await core.loadWallet();
  await sleep(1700);                      // the claim that follows the wallet
  const first = pay(w, '/wallet/claims');
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].body.claims.map((c) => c.c + ':' + c.t).sort(), ['apples:1', 'apples:2', 'golden:1']);
  assert.ok(first[0].body.claims.every((c) => Object.keys(c).sort().join() === 'c,t'), 'no reward amount is sent');
  await core.claimAchievements();
  assert.equal(pay(w, '/wallet/claims').length, 1, 'nothing new, nothing sent');
});
