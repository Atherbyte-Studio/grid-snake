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
  const w = { linkedTo: opts.linkedTo || null, save: opts.save || null, calls: [], best: 300 };
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
    if (p.endsWith('/score')) { if (body.score > w.best) w.best = body.score; return ok({ improved: w.best === body.score, best: w.best, rank: 1 }); }
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
  assert.deepEqual(await board.submitBest({ secret: 'x', score: 450, settings: { walls: true, golden: true, difficulty: 'hard' } }), { ok: true, improved: true, best: 450, rank: 1 });
  assert.deepEqual(w.calls.find((x) => x.path.endsWith('/score')).body, { score: 450, walls: true, golden: true, difficulty: 'hard' });
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
