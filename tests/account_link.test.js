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
    return err(404, 'not_found');
  };
  return w;
}
function client(w, signedIn = true) {
  return {
    isConfigured: () => true, hasSession: () => signedIn, username: () => (signedIn ? RONALDO.username : ''),
    getSession: () => (signedIn ? { user: RONALDO } : null), authed: w.authed
  };
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

test('backups: the five most recent are kept', () => {
  const c = make(benzemaDevice(), worker());
  for (let i = 0; i < 8; i++) c.backup('r' + i);
  assert.equal(c.backups().length, 5);
  assert.equal(c.backups()[0].reason, 'r7');
});

test('link refused: no player, pending player, player linked elsewhere; nothing on the device changes', async () => {
  const none = make(emptyDevice(), worker());
  assert.match((await none.link()).message, /no player/);
  const pending = make(storage({ 'gridsnake-pending-player-v1': '{"name":"X","secret":"' + BENZ + '"}' }), worker());
  assert.match((await pending.link()).message, /Finish creating/);
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

test('another player on this device: no sync, no restore, scores keep the old path', async () => {
  const w = worker({ linkedTo: 'Benzema', save: { version: 1, data: { v: 2, savedAt: 1, data: { coins: 5 }, bests: {} } } });
  const st = storage({ 'gridsnake-player-v1': JSON.stringify({ name: 'Messi', secret: 'c'.repeat(32) }), 'gridsnake-profile-v2': '{"coins":3}' });
  const before = snapshot(st);
  const c = make(st, w);
  await c.refresh();
  assert.equal(c.state.phase, 'other-player');
  assert.equal(c.routesScores(), false);
  assert.equal(snapshot(st), before);
});

test('scores of the linked player go through the Worker with the ranked rules', async () => {
  const w = worker();
  const c = make(benzemaDevice(), w);
  assert.equal(c.routesScores(), false, 'not before linking');
  await c.refresh(); await c.link();
  assert.equal(c.routesScores(), true);
  const r = await c.submitScore(450);
  assert.deepEqual(r, { ok: true, improved: true, best: 450, rank: 1 });
  assert.deepEqual(w.calls.find((x) => x.path.endsWith('/score')).body, { score: 450, walls: true, golden: true, difficulty: 'hard' });
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
