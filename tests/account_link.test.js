'use strict';
/* The Atherbyte account link (src/web/account-link.js, web page only): linking, saving, restoring, conflicts, backups
 * and the score route. No network: the account client and the Worker are faked. Run: node --test tests/account_link.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AL = require('../src/web/account-link.js');
const SnakeProfile = require('../src/profile.js');

const BENZ = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const RONALDO = { id: '11111111-1111-4111-8111-111111111111', username: 'ronaldo' };

function storage(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] || null, get length() { return m.size; }, map: m
  };
}
/* A device that has played as Benzema: coins, a bought skin, achievements, settings, local bests. */
function benzemaDevice(extra) {
  return storage(Object.assign({
    'gridsnake-player-v1': JSON.stringify({ name: 'Benzema', secret: BENZ }),
    'gridsnake-profile-v2': JSON.stringify({ prefs: { mode: 'timeattack', skin: 'jordan', sound: false }, totals: { foods: 900, bonus: 12, runs: 40 },
      ach: { foods: { tier: 3, progress: 900 } }, coins: 1234, owned: { 'skin:jordan': true }, name: 'Benzema', savedAt: 5000 }),
    'gridsnake-best-walls': '77', 'gridsnake-best-timeattack-walls-golden': '300'
  }, extra));
}
const emptyDevice = () => storage();

/* The Worker, in memory: the same answers as the routes in atherbyte-api/src/routes/gridsnake.js. */
function worker(opts = {}) {
  const w = { linkedTo: opts.linkedTo || null, save: opts.save || null, calls: [], best: 300, rounds: {}, roundSeq: 0, failScore: [], failRound: false, counted: [], records: {}, noSeed: !!opts.noSeed, engine: opts.engine, old: !!opts.old };
  w.authed = (p, init) => {
    const method = (init && init.method) || 'GET', body = init && init.body;
    w.calls.push({ path: p, method, body });
    const ok = (data) => Promise.resolve({ ok: true, status: 200, data });
    const err = (status, error, extra) => Promise.resolve({ ok: false, status, data: Object.assign({ error }, extra), code: error });
    if (opts.down) return Promise.resolve({ ok: false, status: 0, code: 'network' });
    if (p.endsWith('/player')) return ok(w.linkedTo ? { linked: true, name: w.linkedTo, best: w.best, rank: 1, save: w.save } : { linked: false });
    if (p.endsWith('/link')) {
      if (body.recovery_code !== BENZ) return err(404, 'unknown_player');
      if (opts.elsewhere) return err(409, 'player_linked_elsewhere');
      w.linkedTo = 'Benzema';
      return ok({ status: 'linked', name: 'Benzema', best: w.best, rank: 1 });
    }
    if (p.endsWith('/save')) {
      if (!w.linkedTo) return err(409, 'not_linked');
      const cur = w.save ? w.save.version : null;
      if (body.base_version !== cur) return err(409, 'save_conflict', { version: cur });
      w.save = { version: (cur || 0) + 1, data: JSON.parse(JSON.stringify(body.data)) };
      return ok({ version: w.save.version });
    }
    if (p.endsWith('/round')) {
      if (w.old) return err(404, 'not_found');          // the Worker that is live today has no /round route
      if (w.failRound) return Promise.resolve({ ok: false, status: 0, code: 'network' });
      if (!w.linkedTo) return err(409, 'not_linked');
      const id = 'r-' + (++w.roundSeq);
      w.rounds[id] = 'open';
      if (w.noSeed) return ok({ round_id: id, started_at: 't', expires_at: 't' });            // the Worker before replay
      return ok({ round_id: id, seed: 1000 + w.roundSeq, engine: w.engine || AL.ENGINE_SHA, started_at: 't', expires_at: 't' });
    }
    if (p.endsWith('/score')) {
      const f = w.failScore.shift();                      // 'network' | 'timeout-after' | 'server' | 'implausible' | 'expired'
      if (f === 'network') return Promise.resolve({ ok: false, status: 0, code: 'network' });
      if (f === 'server') return err(502, 'upstream_error');
      if (w.old) {                                       // today's Worker: no round, best only goes up
        w.counted.push({ round: body.round_id || null, score: body.score });
        if (body.score > w.best) w.best = body.score;
        return ok({ improved: w.best === body.score, best: w.best, rank: 1 });
      }
      if (!body.round_id) return err(400, 'round_required');
      if (!w.noSeed && !body.record) return err(400, 'replay_required');
      if (body.record) w.records[body.round_id] = body.record;
      if (!(body.round_id in w.rounds)) return err(404, 'round_not_found');
      if (f === 'mismatch') { w.rounds[body.round_id] = 'rejected'; return err(422, 'replay_mismatch'); }
      if (w.rounds[body.round_id] !== 'open') return err(409, 'round_closed');
      if (f === 'implausible') { w.rounds[body.round_id] = 'rejected'; return err(422, 'score_not_plausible'); }
      if (f === 'expired') { w.rounds[body.round_id] = 'expired'; return err(410, 'round_expired'); }
      w.rounds[body.round_id] = 'used';
      w.counted.push({ round: body.round_id, score: body.score });
      if (body.score > w.best) w.best = body.score;
      if (f === 'timeout-after') return Promise.resolve({ ok: false, status: 0, code: 'timeout' });   // done, but the answer is lost
      return ok({ improved: w.best === body.score, best: w.best, rank: 1 });
    }
    if (p.endsWith('/name')) {
      if (w.linkedTo) { const renamed = w.linkedTo !== 'ronaldo'; w.linkedTo = 'ronaldo'; return ok({ status: 'ok', name: 'ronaldo', renamed }); }
      if (!body.create) return err(409, 'not_linked');
      w.linkedTo = 'ronaldo'; w.best = null;
      return ok({ status: 'created', name: 'ronaldo', renamed: false });
    }
    return err(404, 'not_found');
  };
  return w;
}
function client(w, signedIn = true, me) {
  const c = {
    isConfigured: () => true, hasSession: () => signedIn, username: () => (signedIn ? RONALDO.username : ''),
    getSession: () => (signedIn ? { user: RONALDO } : null), authed: w.authed,
    // GET /v1/me: me(c) can end the session (an expired, unrefreshable one) or fail on the network
    me: () => Promise.resolve(me ? me(c) : { ok: true, profile: { id: RONALDO.id, username: 'ronaldo' } })
  };
  c.end = () => { signedIn = false; };
  return c;
}
const make = (st, w, signedIn) => AL.create({ account: client(w, signedIn), storage: st, now: () => 42 });
const snapshot = (st) => JSON.stringify([...st.map.entries()].filter(([k]) => k.startsWith('gridsnake-') && !/backups|account-sync/.test(k)).sort());

test('signed out: nothing is sent and nothing changes', async () => {
  const st = benzemaDevice(), w = worker(), before = snapshot(st);
  const c = make(st, w, false);
  await c.refresh();
  assert.equal(c.state.phase, 'signed-out');
  assert.equal(w.calls.length, 0);
  assert.equal(snapshot(st), before);
});

test('link: keeps a backup first, sends the recovery code once, then saves every kind of local progress', async () => {
  const st = benzemaDevice(), w = worker(), before = snapshot(st);
  const c = make(st, w);
  await c.refresh();
  assert.equal(c.state.phase, 'unlinked');
  const r = await c.link();
  assert.equal(r.ok, true);
  assert.equal(c.state.phase, 'linked');
  assert.equal(c.backups()[0].reason, 'before-link');
  const linkCall = w.calls.find((x) => x.path.endsWith('/link'));
  assert.deepEqual(linkCall.body, { recovery_code: BENZ }, 'only the code, never an account id');
  assert.ok(!w.calls.some((x) => x.path.endsWith('/save') && JSON.stringify(x.body).includes(BENZ)), 'the code is not inside the save');
  const d = w.save.data;
  assert.equal(w.save.version, 1);
  assert.equal(d.data.coins, 1234);
  assert.deepEqual(d.data.owned, { 'skin:jordan': true });
  assert.deepEqual(d.data.ach, { foods: { tier: 3, progress: 900 } });
  assert.equal(d.data.prefs.skin, 'jordan');
  assert.deepEqual(d.bests, { 'gridsnake-best-walls': 77, 'gridsnake-best-timeattack-walls-golden': 300 });
  assert.equal(snapshot(st), before, 'linking changes nothing on the device');
});

test('the backup code is the game\'s own GS2 format: the profile restores from it exactly', () => {
  const st = benzemaDevice();
  const c = make(st, worker());
  const code = c.backup('test');
  const other = storage();
  const p = SnakeProfile.create(other, { modes: ['classic', 'timeattack'], skins: ['emerald', 'jordan'], premium: ['skin:jordan'], achievementIds: ['foods'] });
  assert.equal(p.importCode(code), true);
  assert.equal(p.getCoins(), 1234);
  assert.equal(p.owns('skin:jordan'), true);
  assert.equal(p.getBest('classic', 'walls'), 77);
  assert.equal(p.getBest('timeattack', 'walls', true), 300);
  assert.equal(p.getAch('foods').tier, 3);
});

test('backups: the five most recent are kept, with the player\'s code; the same progress twice is kept once', () => {
  const st = benzemaDevice();
  const c = make(st, worker());
  for (let i = 0; i < 8; i++) { st.setItem('gridsnake-best-walls', String(100 + i)); c.backup('r' + i); }
  c.backup('again');
  assert.equal(c.backups().length, 5);
  assert.equal(c.backups()[0].reason, 'r7');
  assert.deepEqual(c.backups()[0].player, { name: 'Benzema', secret: BENZ });
});

test('link refused: no player, an unknown pending code, player linked elsewhere; nothing on the device changes', async () => {
  const none = make(emptyDevice(), worker());
  assert.match((await none.link()).message, /no player/);
  // a player whose creation answer was lost: its code is tried (the server knows it or not), never a name
  const pending = make(storage({ 'gridsnake-pending-player-v1': '{"name":"X","secret":"' + 'e'.repeat(32) + '"}' }), worker());
  assert.match((await pending.link()).message, /does not match any player/);
  const st = benzemaDevice(), before = snapshot(st), w = worker({ elsewhere: true });
  const c = make(st, w);
  assert.match((await c.link()).message, /another Atherbyte account/);
  assert.equal(snapshot(st), before);
  assert.equal(w.save, null);
});

test('restore on a new, empty device: takes the account copy, after a backup', async () => {
  const w = worker();
  const first = make(benzemaDevice(), w);
  await first.refresh(); await first.link();
  const st = emptyDevice();
  const c = make(st, w);
  await c.refresh();
  assert.equal(c.state.phase, 'restored');
  assert.equal(c.backups()[0].reason, 'before-restore');
  const prof = JSON.parse(st.getItem('gridsnake-profile-v2'));
  assert.equal(prof.coins, 1234);
  assert.deepEqual(prof.owned, { 'skin:jordan': true });
  assert.equal(st.getItem('gridsnake-best-timeattack-walls-golden'), '300');
});

test('a device with its own progress is never replaced by itself: conflict, then the player chooses', async () => {
  const w = worker();
  const first = make(benzemaDevice(), w);
  await first.refresh(); await first.link();
  // a second device, same player, different progress
  const st = benzemaDevice({ 'gridsnake-profile-v2': JSON.stringify({ coins: 9, totals: { runs: 2 }, savedAt: 7000 }), 'gridsnake-best-walls': '5' });
  const before = snapshot(st);
  const c = make(st, w);
  await c.refresh();
  assert.equal(c.state.phase, 'conflict');
  assert.equal(snapshot(st), before, 'nothing replaced while waiting for the choice');
  assert.equal(w.save.data.data.coins, 1234, 'and nothing replaced on the account');
  // choosing the account's copy keeps this device's progress as a backup code
  await c.useAccountSave();
  assert.equal(JSON.parse(st.getItem('gridsnake-profile-v2')).coins, 1234);
  assert.match(c.backups()[0].code, /^GS2\./);
  const kept = JSON.parse(Buffer.from(c.backups()[0].code.slice(4), 'base64').toString('utf8'));
  assert.equal(kept.data.coins, 9);
  assert.equal(kept.bests['gridsnake-best-walls'], 5);
});

test('keeping the device\'s progress replaces the account copy only by explicit choice, with the current version', async () => {
  const w = worker();
  const first = make(benzemaDevice(), w);
  await first.refresh(); await first.link();
  const st = benzemaDevice({ 'gridsnake-profile-v2': JSON.stringify({ coins: 9, savedAt: 7000 }) });
  const c = make(st, w);
  await c.refresh();
  assert.equal(c.state.phase, 'conflict');
  await c.useDeviceSave();
  assert.equal(c.state.phase, 'linked');
  assert.equal(w.save.version, 2);
  assert.equal(w.save.data.data.coins, 9);
});

test('two devices: a stale device gets a conflict instead of overwriting the newer save', async () => {
  const w = worker();
  const a = make(benzemaDevice(), w);
  await a.refresh(); await a.link();
  const stB = emptyDevice();
  const b = make(stB, w);
  await b.refresh();                                       // B restores version 1
  // A plays and saves version 2
  const stA = benzemaDevice({ 'gridsnake-profile-v2': JSON.stringify({ coins: 2000, savedAt: 9000 }) });
  const a2 = make(stA, w);
  stA.setItem('gridsnake-account-sync-v1', JSON.stringify({ [RONALDO.id]: { version: 1, at: 5000 } }));
  await a2.refresh();
  assert.equal(a2.state.phase, 'linked');
  await a2.syncNow();
  assert.equal(w.save.version, 2);
  // B plays on its version 1 copy and tries to save: refused, nothing overwritten
  stB.setItem('gridsnake-profile-v2', JSON.stringify(Object.assign(JSON.parse(stB.getItem('gridsnake-profile-v2')), { coins: 1, savedAt: 99999 })));
  b.state.phase = 'linked';
  const r = await b.syncNow();
  assert.equal(r.ok, false);
  assert.equal(b.state.phase, 'conflict');
  assert.equal(w.save.data.data.coins, 2000);
});

test('an unchanged device that is behind takes the newer account copy (after a backup)', async () => {
  const w = worker({ linkedTo: 'Benzema', save: { version: 3, data: { v: 2, savedAt: 8000, data: { coins: 50, savedAt: 8000 }, bests: {} } } });
  const st = benzemaDevice();
  st.setItem('gridsnake-account-sync-v1', JSON.stringify({ [RONALDO.id]: { version: 2, at: 5000 } }));
  const c = make(st, w);
  await c.refresh();
  assert.equal(c.state.phase, 'restored');
  assert.equal(JSON.parse(st.getItem('gridsnake-profile-v2')).coins, 50);
  assert.equal(c.backups()[0].reason, 'before-restore');
});

test('scores go through the Worker with the ranked rules; the board cannot create or restore a local player', async () => {
  const w = worker();
  const c = make(benzemaDevice(), w);
  await c.refresh(); await c.link();
  const board = AL.patchBoard(Object.assign({}, require('../src/leaderboard.js')), c);
  await c.prefetch(); const run = c.runCreated(c.takeRound()); c.runStarted(run); run.record.push('s'); c.runFinished(run, 450);
  assert.deepEqual(await board.submitBest({ secret: 'x', score: 450, settings: { walls: true, golden: true, difficulty: 'hard' } }), { ok: true, improved: true, best: 450, rank: 1 });
  const sent = w.calls.find((x) => x.path.endsWith('/score')).body;
  assert.deepEqual({ round_id: sent.round_id, score: sent.score, walls: sent.walls, golden: sent.golden, difficulty: sent.difficulty, engine: sent.engine },
    { round_id: 'r-1', score: 450, walls: true, golden: true, difficulty: 'hard', engine: AL.ENGINE_SHA });
  assert.equal((await board.submitBest({ score: 450, settings: { walls: false, golden: true, difficulty: 'hard' } })).reason, 'not-ranked');
  const before = w.calls.length;
  assert.equal((await board.enrollPlayer({ name: 'Someone' })).ok, false);
  assert.equal((await board.registerPlayer({ name: 'Someone', secret: BENZ })).ok, false);
  assert.equal((await board.resumePending({})).ok, false);
  assert.equal(w.calls.length, before, 'none of them reach a server');
  assert.deepEqual(await board.getMe({ secret: 'anything' }), { ok: true, name: 'Benzema', best: 450, rank: 1 });
});

test('session: none, refused or expired means signed out; a network failure is not a sign-out', async () => {
  assert.equal(await AL.create({ account: client(worker(), false), storage: storage() }).verifySession(), 'signed-out');
  assert.equal(await AL.create({ account: client(worker()), storage: storage() }).verifySession(), 'ok');
  const expired = client(worker(), true, (c) => { c.end(); return { ok: false, status: 401, code: 'unauthorized' }; });
  assert.equal(await AL.create({ account: expired, storage: storage() }).verifySession(), 'signed-out');
  const offline = client(worker(), true, () => ({ ok: false, status: 0, code: 'network' }));
  assert.equal(await AL.create({ account: offline, storage: storage() }).verifySession(), 'offline');
});

test('old player: linked by its code, then named after the account on the same record; progress kept', async () => {
  const st = benzemaDevice(), w = worker(), before = snapshot(st);
  const c = make(st, w);
  await c.fetchPlayer();
  assert.equal((await c.linkWithCode(BENZ)).ok, true);
  const r = await c.useAccountName(false);
  assert.deepEqual([r.ok, r.name], [true, 'ronaldo']);
  assert.ok(c.localPlayerChecked(), 'the code on this device belongs to the account player');
  c.writeIdentity(r.name);
  assert.deepEqual(JSON.parse(st.getItem('gridsnake-player-v1')), { name: 'ronaldo', secret: BENZ }, 'the real recovery code stays');
  await c.fetchPlayer(); await c.decideSync();
  assert.equal(w.save.data.data.coins, 1234);
  assert.deepEqual(w.save.data.data.owned, { 'skin:jordan': true });
  const after = JSON.parse(snapshot(st)).filter(([k]) => k !== 'gridsnake-player-v1');
  assert.deepEqual(after, JSON.parse(before).filter(([k]) => k !== 'gridsnake-player-v1'), 'coins, items, achievements, settings and bests untouched');
});

test('new account on an empty device: a player named after the account, and a stand-in code that is never sent', async () => {
  const st = emptyDevice(), w = worker();
  const c = AL.create({ account: client(w), storage: st, random: () => 0.5 });
  await c.fetchPlayer();
  assert.equal(c.state.linked, false);
  assert.equal((await c.useAccountName(false)).ok, false, 'no player is made without asking');
  const r = await c.useAccountName(true);
  assert.deepEqual([r.ok, r.status, r.name], [true, 'created', 'ronaldo']);
  c.writeIdentity('ronaldo');
  const id = JSON.parse(st.getItem('gridsnake-player-v1'));
  assert.equal(id.name, 'ronaldo');
  assert.equal(JSON.parse(st.getItem(AL.LOCAL_ONLY_KEY)).secret, id.secret);
  assert.equal(c.localPlayer(), null, 'the stand-in is not treated as an old player');
  assert.ok(!w.calls.some((x) => JSON.stringify(x.body || {}).includes(id.secret)));
});

test('progress but no recovery code: nothing is linked by guess and nothing is deleted', async () => {
  const st = storage({ 'gridsnake-profile-v2': JSON.stringify({ coins: 77, owned: { 'board:neon': true }, savedAt: 9 }), 'gridsnake-best-walls': '12' });
  const before = snapshot(st), w = worker();
  const c = make(st, w);
  await c.fetchPlayer();
  assert.equal(c.localPlayer(), null);
  assert.equal(c.state.linked, false);
  assert.ok(!w.calls.some((x) => x.path.endsWith('/link') || x.path.endsWith('/name')));
  assert.match(c.backup('before-choice'), /^GS2\./);
  assert.equal(snapshot(st), before);
});

test('network down: nothing on the device changes and the state says so', async () => {
  const st = benzemaDevice(), before = snapshot(st);
  const c = make(st, worker({ down: true }));
  await c.refresh();
  assert.equal(c.state.phase, 'error');
  assert.equal(snapshot(st), before);
});

test('build: the account code is only in the web page, never in grid-snake.html or the Android copy', () => {
  const root = path.join(__dirname, '..');
  const web = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const single = fs.readFileSync(path.join(root, 'grid-snake.html'), 'utf8');
  const android = fs.readFileSync(path.join(root, 'android-app/www/index.html'), 'utf8');
  assert.ok(web.includes('var SnakeAccountLink'));
  assert.ok(web.includes("'/js/atherbyte-account.js'") && web.includes("SITE = 'https://atherbyte.online'"), 'loads the account client on the studio site only');
  for (const f of [single, android]) {
    assert.ok(!f.includes('SnakeAccountLink'));
    assert.ok(!f.includes('atherbyte-account.js'));
  }
  assert.ok(web.includes('pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-3219161174659178'), 'the AdSense tag survives a rebuild');
});

/* ---------- several accounts on one device ---------- */
const NEYMAR = { id: '22222222-2222-4222-8222-222222222222', username: 'neymar' };
function switchable(w) {   // a client whose signed-in user can change, like a browser after sign-out and sign-in
  const c = { user: RONALDO, isConfigured: () => true, hasSession: () => !!c.user, username: () => (c.user ? c.user.username : ''),
    getSession: () => (c.user ? { user: c.user } : null), authed: w.authed, me: () => Promise.resolve({ ok: true }) };
  return c;
}
const liveOf = (st) => JSON.stringify([...st.map.entries()].filter(([k]) => k.startsWith('gridsnake-') && !k.startsWith(AL.SLOT_PREFIX) && k !== AL.OWNER_KEY && k !== AL.SYNC_KEY).sort());

test('switching accounts: A\'s data goes aside unchanged, B starts empty, and A gets exactly its data back', () => {
  const st = benzemaDevice(), acct = switchable(worker());
  const c = AL.create({ account: acct, storage: st });
  st.setItem(AL.OWNER_KEY, RONALDO.id);
  const aLive = liveOf(st);
  acct.user = NEYMAR;
  assert.equal(c.useSlotOf(NEYMAR.id), 'switched');
  assert.equal(liveOf(st), '[]', 'none of A\'s player, code, coins, skins, achievements or bests is visible to B');
  assert.equal(c.localPlayer(), null, 'so nothing of A is ever sent for B (the cause of the false warning)');
  assert.equal(st.getItem(AL.OWNER_KEY), NEYMAR.id);
  st.setItem('gridsnake-profile-v2', JSON.stringify({ coins: 5, savedAt: 1 }));   // B plays
  const bLive = liveOf(st);
  acct.user = RONALDO;
  assert.equal(c.useSlotOf(RONALDO.id), 'switched');
  assert.equal(liveOf(st), aLive, 'A\'s data is back exactly as it was');
  acct.user = NEYMAR;
  c.useSlotOf(NEYMAR.id);
  assert.equal(liveOf(st), bLive, 'and so is B\'s');
});

test('switching accounts: an old player with no owner is left in place, never claimed by a sign-in alone', () => {
  const st = benzemaDevice(), before = liveOf(st);
  const c = AL.create({ account: switchable(worker()), storage: st });
  assert.equal(c.useSlotOf(NEYMAR.id), 'unclaimed');
  assert.equal(liveOf(st), before);
  assert.equal(st.getItem(AL.OWNER_KEY), null);
});

test('switching accounts: data from the earlier version is recognised as its account\'s, not as an unclaimed player', () => {
  const st = benzemaDevice();
  st.setItem(AL.SYNC_KEY, JSON.stringify({ [RONALDO.id]: { version: 2, at: 5000, checked: BENZ } }));
  const c = AL.create({ account: switchable(worker()), storage: st });
  assert.equal(c.owner(), RONALDO.id);
  assert.equal(c.useSlotOf(NEYMAR.id), 'switched');
  assert.equal(c.localPlayer(), null);
});

test('switching accounts: if the browser will not keep A\'s data aside, nothing is moved', () => {
  const st = benzemaDevice();
  st.setItem(AL.OWNER_KEY, RONALDO.id);
  const before = liveOf(st), set = st.setItem;
  st.setItem = (k, v) => { if (k.startsWith(AL.SLOT_PREFIX)) throw new Error('quota'); set(k, v); };
  const c = AL.create({ account: switchable(worker()), storage: st });
  assert.equal(c.useSlotOf(NEYMAR.id), 'storage');
  assert.equal(liveOf(st), before);
});

test('a running game is bound to its account: after a switch it sends nothing with the new session', async () => {
  const w = worker({ linkedTo: 'Benzema' }), acct = switchable(w);
  const c = AL.create({ account: acct, storage: benzemaDevice() });
  c.bind();
  acct.user = NEYMAR;
  const before = w.calls.length;
  assert.equal((await c.submitScore(999)).ok, false);
  assert.equal((await c.syncNow()).ok, false);
  assert.equal(w.calls.length, before, 'no request reached the Worker');
});

test('a new account plays at once; its player is made on the server with its first save, never before', async () => {
  const w = worker(), st = emptyDevice();
  const c = AL.create({ account: client(w), storage: st });
  await c.fetchPlayer();
  c.state.phase = 'linked';
  assert.ok(!w.calls.some((x) => x.path.endsWith('/name')));
  st.setItem('gridsnake-profile-v2', JSON.stringify({ coins: 3, savedAt: 50 }));
  assert.equal((await c.syncNow()).ok, true);
  assert.deepEqual(w.calls.filter((x) => x.path.endsWith('/name')).map((x) => x.body), [{ create: true }]);
  assert.equal(w.save.data.data.coins, 3);
});

/* ---------- ranked rounds (supabase/score_rounds.sql) and the game's score queue ---------- */
/* The game's queue, exactly as src/index.template.html runs it (rankRun / flushRanks / Try again): oldest first, one at a
   time; an item leaves the queue only on ok or one of the "dropped" reasons; anything else waits for Try again or for
   the next run's flush. */
function gameQueue(board) {
  const q = { items: [], flushing: false, shown: [], seq: 0 };
  q.flush = () => new Promise((resolve) => {
    if (q.flushing || !q.items.length) return resolve();
    const item = q.items[0];
    q.flushing = true;
    board.submitBest({ secret: 'x', score: item.score, settings: { walls: true, golden: true, difficulty: 'hard' } }).then((r) => {
      q.flushing = false;
      const dropped = r.ok || r.reason === 'invalid' || r.reason === 'not-ranked' || r.reason === 'unknown-player';
      if (dropped) q.items.shift();
      q.shown.push({ run: item.id, ok: r.ok, reason: r.reason, why: r.why, best: r.best });
      if (dropped) q.flush().then(resolve); else resolve();
    });
  });
  q.endRun = (score) => { q.items.push({ id: ++q.seq, score }); return q.flush(); };   // rankRun
  q.retry = () => q.flush();                                                         // the Try again button
  return q;
}
/* A whole Time Attack run through the real engine and the patches: start (opens the round), end with a score. */
function playRun(engine, score) {
  const g = engine.create({ mode: 'timeattack', edge: 'walls', golden: true });
  g.start();
  g.state.score = score;
  g.state.phase = 'running';
  // end the run the engine's own way: time runs out
  g.update(100); g.state.timeLeft = 0; g.update(1);
  return g;
}
async function setupRounds(opts) {
  const w = worker(Object.assign({ linkedTo: 'Benzema' }, opts));
  const st = benzemaDevice();
  const acct = switchable(w);
  const c = AL.create({ account: acct, storage: st });
  c.bind();
  const board = AL.patchBoard(Object.assign({}, require('../src/leaderboard.js')), c);
  const engine = AL.patchEngine(Object.assign({}, require('../src/engine.js')), c);
  await c.prefetch();
  return { w, c, acct, board, engine, q: gameQueue(board) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('rounds: a Time Attack run uses the round fetched ahead and fetches the next; Classic uses none', async () => {
  const { w, engine } = await setupRounds();
  assert.deepEqual(Object.keys(w.rounds), ['r-1'], 'one round fetched ahead');
  engine.create({ mode: 'classic', edge: 'walls' }).start();
  const g = engine.create({ mode: 'timeattack', edge: 'walls', golden: true });
  g.start(); g.start();
  await tick();
  assert.deepEqual(Object.keys(w.rounds), ['r-1', 'r-2'], 'the run took r-1, and r-2 is fetched for the next run');
  const E = require('../src/engine.js');
  const same = E.create({ mode: 'timeattack', edge: 'walls', golden: true, rng: AL.seededRng(1001) });
  assert.deepEqual(g.state.food, same.state.food, 'the run is built from r-1\'s seed (1001): same food as the server will see');
});

test('queue: a counted score is sent with its own run\'s round, once', async () => {
  const { w, engine, q } = await setupRounds();
  playRun(engine, 40); await tick();
  await q.endRun(40);
  assert.deepEqual(w.counted, [{ round: 'r-1', score: 40 }]);
  assert.equal(q.items.length, 0);
});

test('queue: a definitive refusal leaves the queue with its reason, and the next run is counted with its own round', async () => {
  const { w, engine, q } = await setupRounds();
  w.failScore.push('implausible');
  playRun(engine, 40); await tick();
  await q.endRun(40);
  assert.deepEqual(q.shown.at(-1), { run: 1, ok: false, reason: 'invalid', why: 'implausible', best: undefined });
  assert.equal(q.items.length, 0, 'not stuck');
  playRun(engine, 55); await tick();
  await q.endRun(55);
  assert.deepEqual(w.counted, [{ round: 'r-2', score: 55 }], 'the new run, with the new round');
});

test('queue: no connection, then Try again: the same score with the SAME round; it is counted once', async () => {
  const { w, engine, q } = await setupRounds();
  w.failScore.push('network');
  playRun(engine, 40); await tick();
  await q.endRun(40);
  assert.equal(q.shown.at(-1).reason, 'network');
  assert.equal(q.items.length, 1, 'kept for Try again');
  await q.retry();
  assert.deepEqual(w.counted, [{ round: 'r-1', score: 40 }]);
  assert.equal(q.items.length, 0);
});

test('queue: a 5xx answer is retried the same way', async () => {
  const { w, engine, q } = await setupRounds();
  w.failScore.push('server');
  playRun(engine, 40); await tick();
  await q.endRun(40);
  assert.equal(q.items.length, 1);
  await q.retry();
  assert.deepEqual(w.counted, [{ round: 'r-1', score: 40 }]);
});

test('queue: a timeout after the server counted it: the retry is told "already counted", nothing counts twice', async () => {
  const { w, engine, q } = await setupRounds();
  w.failScore.push('timeout-after');
  playRun(engine, 400); await tick();
  await q.endRun(400);
  assert.equal(q.shown.at(-1).reason, 'timeout');
  await q.retry();
  assert.deepEqual(q.shown.at(-1), { run: 1, ok: false, reason: 'invalid', why: 'already', best: 400 });
  assert.equal(w.counted.length, 1);
  assert.equal(q.items.length, 0);
});

test('queue: a failed run waiting for retry, then a new run: each score goes with its own round, none with another', async () => {
  const { w, engine, q } = await setupRounds();
  w.failScore.push('network');
  playRun(engine, 40); await tick();
  await q.endRun(40);                  // run 1: lost answer, waits
  playRun(engine, 55); await tick();
  await q.endRun(55);                  // run 2: the queue sends run 1 first (now online), then run 2
  assert.deepEqual(w.counted, [{ round: 'r-1', score: 40 }, { round: 'r-2', score: 55 }]);
  assert.equal(q.items.length, 0);
});

test('queue: an expired round, and a run whose round never opened, are dropped with their reason; the next run counts', async () => {
  const { w, c, engine, q } = await setupRounds();
  w.failScore.push('expired');
  playRun(engine, 40); await tick();
  await q.endRun(40);
  assert.equal(q.shown.at(-1).why, 'expired');
  w.failRound = true;
  c.takeRound(); await tick();              // the round waiting ahead is used up, and fetching the next one fails
  playRun(engine, 41); await tick();        // so this run is created with no round
  await q.endRun(41);
  assert.equal(q.shown.at(-1).why, 'no-round');
  assert.equal(q.items.length, 0);
  w.failRound = false;
  await c.prefetch();                       // the connection is back: the next run's round is fetched
  playRun(engine, 42); await tick();
  await q.endRun(42);
  assert.deepEqual(w.counted.map((x) => x.score), [42]);
});

test('queue: a score of 0 is not sent and leaves no run behind', async () => {
  const { w, c, engine } = await setupRounds();
  playRun(engine, 0); await tick();
  assert.deepEqual(c.pendingRuns(), []);
  assert.equal(w.calls.filter((x) => x.path.endsWith('/score')).length, 0);
});

test('queue: after the account changes, a waiting score is never sent with the other account\'s session', async () => {
  const { w, acct, engine, q } = await setupRounds();
  w.failScore.push('network');
  playRun(engine, 40); await tick();
  await q.endRun(40);
  acct.user = NEYMAR;
  const before = w.calls.length;
  await q.retry();
  assert.equal(w.calls.length, before, 'nothing left the device');
  assert.equal(q.shown.at(-1).why, 'signed-out');
});

/* ---------- rollout: the new page first, the Worker it talks to may still be the old one ---------- */
test('rollout: the new page with today\'s Worker scores exactly as today (no round), and recovers from a lost answer', async () => {
  const { w, engine, q } = await setupRounds({ old: true });
  playRun(engine, 40); await tick();
  await q.endRun(40);
  assert.deepEqual(w.counted, [{ round: null, score: 40 }]);
  w.failScore.push('network');
  playRun(engine, 41); await tick();
  await q.endRun(41);
  assert.equal(q.items.length, 1);
  await q.retry();
  assert.deepEqual(w.counted.at(-1), { round: null, score: 41 });
  assert.equal(q.items.length, 0);
});

test('rollout: a run started before the Worker switch and ended after it is dropped with its reason; the next one counts with a round', async () => {
  const { w, engine, q } = await setupRounds({ old: true });
  playRun(engine, 40); await tick();     // started under today's Worker: no round
  w.old = false;                          // the new Worker goes live during the run
  await q.endRun(40);
  assert.deepEqual(q.shown.at(-1), { run: 1, ok: false, reason: 'invalid', why: 'switched', best: undefined });
  assert.equal(q.items.length, 0, 'not stuck');
  playRun(engine, 42); await tick();
  await q.endRun(42);
  assert.deepEqual(w.counted, [{ round: 'r-1', score: 42 }]);
});

test('rollout: only the old router\'s 404 "not_found" means "old Worker"', async () => {
  const { w, c } = await setupRounds();
  assert.equal(c.takeRound().id, 'r-1', 'the new Worker answers /round');
  await tick();
  w.old = true;
  c.takeRound(); await tick();
  assert.equal(c.takeRound(), 'legacy-worker');
});

/* ---------- replay (Option C): the record is what the server replays ---------- */
const E = require('../src/engine.js');
/* The server's replay, written again here from its description (atherbyte-api src/game/replay.js), to check that what
   this page records replays to the score it reached. */
function replayHere(seed, record) {
  const g = E.create({ mode: 'timeattack', edge: 'walls', golden: true, tuning: E.DIFFICULTY.hard, rng: AL.seededRng(seed) });
  const T = { '^': [0, -1], v: [0, 1], '<': [-1, 0], '>': [1, 0] };
  for (const e of record.split(',')) {
    if (e === 's') g.start(); else if (e === 'p') g.pause(); else if (e === 'r') g.resume();
    else if (T[e]) g.turn(T[e][0], T[e][1]); else g.update(parseInt(e, 36));
  }
  return { phase: g.state.phase, score: g.state.score };
}
/* A real run through the patched engine: fractional frame times (as a browser gives), turns toward the food, a pause. */
function playReal(engine) {
  const g = engine.create({ mode: 'timeattack', edge: 'walls', golden: true, tuning: E.DIFFICULTY.hard });
  const D = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const safe = (d) => { const h = g.state.snake[0], x = h.x + d[0], y = h.y + d[1];
    return x >= 0 && y >= 0 && x < 20 && y < 20 && !g.state.snake.slice(0, -1).some((q) => q.x === x && q.y === y); };
  g.start();
  let n = 0;
  while (g.state.phase !== 'over' && n++ < 20000) {
    if (n === 300) { g.pause(); g.update(16.7); g.update(16.7); g.resume(); }
    const h = g.state.snake[0], f = g.state.gold || g.state.pickup || g.state.food;
    const want = D.filter(safe).sort((a, b) => (Math.abs(h.x + a[0] - f.x) + Math.abs(h.y + a[1] - f.y)) - (Math.abs(h.x + b[0] - f.x) + Math.abs(h.y + b[1] - f.y)))[0];
    if (want) g.turn(want[0], want[1]);
    g.update(16.6 + ((n * 13) % 17) / 10);
  }
  return g;
}

test('replay: the record this page keeps replays, with the round\'s seed, to exactly the score the player reached', async () => {
  const { w, engine, q } = await setupRounds();
  const g = playReal(engine);
  assert.equal(g.state.phase, 'over');
  await tick();
  await q.endRun(Math.floor(g.state.score));
  assert.equal(w.counted.length, 1);
  const rec = w.records['r-1'];
  assert.match(rec, /^s,/);
  assert.match(rec, /,p,r,/, 'pause and resume are recorded');
  const again = replayHere(1001, rec);
  assert.equal(again.phase, 'over', 'the record runs to the end of the round');
  assert.equal(again.score, g.state.score, 'and to the same score');
});

test('replay: a round with no seed (the Worker before replay) is sent without a record, as before', async () => {
  const { w, engine, q } = await setupRounds({ noSeed: true });
  playRun(engine, 40); await tick();
  await q.endRun(40);
  assert.deepEqual(w.counted, [{ round: 'r-1', score: 40 }]);
  assert.equal(w.records['r-1'], undefined);
});

test('replay: a run recorded before the Worker switched to replay is dropped with its reason; the next one counts', async () => {
  const { w, engine, q } = await setupRounds({ noSeed: true });
  playRun(engine, 40); await tick();       // its round has no seed: no record
  w.noSeed = false;                         // the replaying Worker goes live
  await q.endRun(40);
  assert.equal(q.shown.at(-1).why, 'switched');
  await tick();                             // the round fetched from the old Worker was dropped; a new one is fetched
  const g = playReal(engine); await tick();
  await q.endRun(Math.floor(g.state.score));
  assert.ok(w.records[Object.keys(w.records).at(-1)], 'the next run is sent with its record');
});

test('replay: a refused replay leaves the queue with its reason; another engine version is not sent at all', async () => {
  const { w, engine, q } = await setupRounds();
  w.failScore.push('mismatch');
  playRun(engine, 40); await tick();
  await q.endRun(40);
  assert.equal(q.shown.at(-1).why, 'mismatch');
  assert.equal(q.items.length, 0);
  w.engine = 'other-engine';
  await tick();
  const c2 = await setupRounds({ engine: 'other-engine' });
  playRun(c2.engine, 41); await tick();
  const before = c2.w.calls.filter((x) => x.path.endsWith('/score')).length;
  await c2.q.endRun(41);
  assert.equal(c2.q.shown.at(-1).why, 'outdated');
  assert.equal(c2.w.calls.filter((x) => x.path.endsWith('/score')).length, before, 'nothing was sent');
});
