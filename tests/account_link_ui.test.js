'use strict';
/* The Atherbyte sign-in in the real web page, served as https://atherbyte.online/grid-snake/ with the studio site's real
 * account client (../Atherbyte-Studio.github.io/js, or ATHERBYTE_SITE) and a stand-in for the Worker that keeps each
 * account's player and save apart, by the token. No network. Skipped when the studio site's files are not next to this
 * repository. Run: node build.js && NODE_PATH=$(npm root -g) node --test tests/account_link_ui.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE = process.env.ATHERBYTE_SITE || path.join(ROOT, '..', 'Atherbyte-Studio.github.io');
const CLIENT = path.join(SITE, 'js', 'atherbyte-account.js');
const skip = fs.existsSync(CLIENT) ? false : 'the studio site (js/atherbyte-account.js) is not next to this repository';

const API = 'https://api.test';
const BENZ = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const USERS = {
  ronaldo: { id: '11111111-1111-4111-8111-111111111111', username: 'ronaldo', password: 'pw-ronaldo-1', token: 'access-ronaldo' },
  neymar: { id: '22222222-2222-4222-8222-222222222222', username: 'neymar', password: 'pw-neymar-1', token: 'access-neymar' }
};
const session = (u, expiresAt) => ({ 'atherbyte-account-v1': JSON.stringify({ access_token: u.token, refresh_token: 'refresh-' + u.username, expires_at: expiresAt || 4102444800, user: { id: u.id, username: u.username } }) });
const benzema = {
  'gridsnake-player-v1': JSON.stringify({ name: 'Benzema', secret: BENZ }),
  'gridsnake-profile-v2': JSON.stringify({ name: 'Benzema', coins: 1234, owned: { 'skin:jordan': true }, totals: { runs: 40, foods: 900, bonus: 0 }, ach: { foods: { tier: 2, progress: 900 } }, savedAt: 5000 }),
  'gridsnake-best-timeattack-walls-golden': '300'
};

let browser;
test.before(async () => { if (!skip) browser = await require('playwright').chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

/* The Worker: one record per account (found by the token, as the real one does), and the Benzema player with its code. */
function fakeWorker() {
  const w = { players: { benz: { name: 'Benzema', code: BENZ, account: null, best: 300, save: null } }, calls: [] };
  w.of = (acct) => Object.values(w.players).find((p) => p.account === acct);
  return w;
}

async function open(seed, opts = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  await ctx.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); Object.keys(s).forEach((k) => { if (localStorage.getItem(k) === null) localStorage.setItem(k, s[k]); }); } }, seed);
  const page = await ctx.newPage();
  const errors = [], board = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const w = opts.worker || fakeWorker();
  await ctx.route(/fonts\.(googleapis|gstatic)\.com|googlesyndication|challenges\.cloudflare/, (r) => r.abort());
  await ctx.route(/supabase\.co/, (r) => { board.push(r.request().url()); r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }); });
  await ctx.route('https://atherbyte.online/grid-snake/', (r) => r.fulfill({ contentType: 'text/html', body: html }));
  await ctx.route('https://atherbyte.online/account/', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>account</title>' }));
  await ctx.route('https://atherbyte.online/assets/**', (r) => r.fulfill({ status: 404, body: '' }));
  await ctx.route('https://atherbyte.online/js/site-config.js', (r) => r.fulfill({ contentType: 'text/javascript',
    body: 'window.ATHERBYTE_CONFIG = { account: { apiBaseUrl: "' + API + '", turnstileSiteKey: "", features: {} } };' }));
  await ctx.route('https://atherbyte.online/js/atherbyte-account.js', (r) => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(CLIENT, 'utf8') }));
  await ctx.route(API + '/**', (r) => {
    const req = r.request(), p = new URL(req.url()).pathname;
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST' };
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    if (opts.offline) return r.abort('internetdisconnected');
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    const json = (status, b) => r.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(b) });
    if (p === '/v1/auth/refresh') return json(401, { error: 'invalid_refresh' });
    if (p === '/v1/auth/login') {
      const u = USERS[body.username];
      if (!u || u.password !== body.password) return json(401, { error: 'invalid_credentials' });
      return json(200, { user: { id: u.id, username: u.username }, session: { access_token: u.token, refresh_token: 'refresh-' + u.username, expires_in: 3600, expires_at: 4102444800 } });
    }
    if (p === '/v1/auth/logout') return r.fulfill({ status: 204, headers: cors });
    const u = Object.values(USERS).find((x) => 'Bearer ' + x.token === req.headers().authorization);
    w.calls.push({ path: p, body, account: u ? u.username : null });
    if (!u) return json(401, { error: 'unauthorized' });
    if (p === '/v1/me') return json(200, { id: u.id, username: u.username });
    const mine = w.of(u.id);
    if (p.endsWith('/player')) return json(200, mine ? { linked: true, name: mine.name, best: mine.best, rank: 1, save: mine.save } : { linked: false });
    if (p.endsWith('/link')) {
      const target = Object.values(w.players).find((x) => x.code && x.code === body.recovery_code);
      if (!target) return json(404, { error: 'unknown_player' });
      if (target.account === u.id) return json(200, { status: 'already-linked', name: target.name, best: target.best, rank: 1 });
      if (target.account) return json(409, { error: 'player_linked_elsewhere' });
      if (mine) return json(409, { error: 'account_has_player' });
      target.account = u.id;
      return json(200, { status: 'linked', name: target.name, best: target.best, rank: 1 });
    }
    if (p.endsWith('/name')) {
      if (mine) { const renamed = mine.name !== u.username; mine.name = u.username; return json(200, { status: 'ok', name: u.username, renamed, reason: null }); }
      if (!body.create) return json(409, { error: 'not_linked' });
      w.players[u.username] = { name: u.username, code: null, account: u.id, best: null, save: null };
      return json(200, { status: 'created', name: u.username, renamed: false, reason: null });
    }
    if (!mine) return json(409, { error: 'not_linked' });
    if (p.endsWith('/save')) {
      const cur = mine.save ? mine.save.version : null;
      if (body.base_version !== cur) return json(409, { error: 'save_conflict', version: cur });
      mine.save = { version: (cur || 0) + 1, data: body.data };
      return json(200, { version: mine.save.version });
    }
    if (p.endsWith('/score')) { if (mine.best == null || body.score > mine.best) mine.best = body.score; return json(200, { improved: mine.best === body.score, best: mine.best, rank: 1 }); }
    return json(404, { error: 'not_found' });
  });
  await page.goto('https://atherbyte.online/grid-snake/');
  return { ctx, page, errors, board, w };
}
const gameRan = (page) => page.evaluate(() => typeof window.SnakeLeaderboard !== 'undefined' || !document.getElementById('playBtn').disabled);
const started = (page) => page.waitForFunction(() => !document.getElementById('acGate') && !document.getElementById('playBtn').disabled);
const live = (page) => page.evaluate(() => {
  const o = {};
  Object.keys(localStorage).filter((k) => /^gridsnake-/.test(k) && !/^gridsnake-(slot-v1:|device-owner|account-sync)/.test(k)).forEach((k) => { o[k] = localStorage.getItem(k); });
  return o;
});
async function signInHere(page, u) {
  await page.waitForSelector('#acSignIn');
  await page.fill('#acUser', u.username);
  await page.fill('#acPass', u.password);
  await page.click('#acSignIn button[type=submit]');
}
async function stoppedAtGate(page, re) {
  await page.waitForFunction((src) => new RegExp(src).test((document.getElementById('acGate') || {}).innerText || ''), re.source);
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  await page.keyboard.press('Space');
  assert.equal(await gameRan(page), false, 'the game code has not run');
  assert.equal(await page.evaluate(() => document.getElementById('welcomeDlg').open), false, 'no local name box');
}

test('signed out: the in-game sign-in card, and the game does not start', { skip }, async () => {
  const { ctx, page, errors, w } = await open(benzema);
  await stoppedAtGate(page, /Sign in to play Grid Snake/);
  assert.deepEqual(await page.$$eval('#acGate [role=tab]', (t) => t.map((x) => x.textContent)), ['Sign In', 'Create Account']);
  assert.equal(await page.getAttribute('#acGate .ac-link', 'href'), '/account/?next=%2Fgrid-snake%2F');
  await page.click('#acGate [role=tab]:nth-child(2)');
  assert.equal(await page.isVisible('#acAck'), true, 'creating an account asks to confirm the recovery note');
  await page.evaluate(() => document.getElementById('acGate').remove());
  assert.equal(await gameRan(page), false, 'removing the card does not start the game: its code is inert text');
  assert.equal(w.calls.length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('wrong password: the card says so and the game stays locked', { skip }, async () => {
  const { ctx, page } = await open({});
  await signInHere(page, { username: 'ronaldo', password: 'nope-nope-1' });
  await page.waitForFunction(() => (document.getElementById('acSignInMsg') || {}).textContent);
  assert.equal(await gameRan(page), false);
  await ctx.close();
});

test('expired session that cannot be refreshed: back to sign-in, progress untouched', { skip }, async () => {
  const { ctx, page, w } = await open(Object.assign({}, benzema, session(USERS.ronaldo, 1000)));
  await stoppedAtGate(page, /Sign in to play Grid Snake/);
  assert.equal(await page.evaluate(() => localStorage.getItem('atherbyte-account-v1')), null);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gridsnake-profile-v2')).coins), 1234);
  assert.ok(!w.calls.some((c) => c.account));
  await ctx.close();
});

test('network failure: a retry screen, the game does not start, nothing changes', { skip }, async () => {
  const { ctx, page } = await open(Object.assign({}, benzema, session(USERS.ronaldo)), { offline: true });
  await stoppedAtGate(page, /Could not reach your Atherbyte account/);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gridsnake-player-v1')).name), 'Benzema');
  await ctx.close();
});

test('progress with no owner and no code: never linked by guess; backup shown; the typed code links it', { skip }, async () => {
  const seed = Object.assign({}, session(USERS.ronaldo), { 'gridsnake-profile-v2': JSON.stringify({ coins: 77, owned: { 'board:neon': true }, savedAt: 9 }) });
  const { ctx, page, w } = await open(seed);
  await stoppedAtGate(page, /not linked to any account/);
  assert.match(await page.inputValue('#acGateBackup'), /^GS2\./);
  assert.ok(!w.calls.some((c) => c.path.endsWith('/link') || c.path.endsWith('/name')));
  await page.fill('#acGateCode', 'BBBB-BBBB-BBBB-BBBB-BBBB-BBBB-BBBB-BBBB');
  await page.getByRole('button', { name: 'Link my recovery code' }).click();
  await page.waitForFunction(() => !document.getElementById('acGate') || /different Grid Snake progress/.test(document.getElementById('acGate').innerText));
  assert.equal(w.players.benz.account, USERS.ronaldo.id);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gridsnake-profile-v2')).coins), 77);
  await ctx.close();
});

test('A plays, signs out on the website, B signs in in the game, B signs out, A comes back: no mixing, no false warning', { skip }, async () => {
  const { ctx, page, errors, board, w } = await open(Object.assign({}, benzema, session(USERS.ronaldo)));
  const gateTexts = [];
  await page.exposeFunction('__gate', (t) => gateTexts.push(t));
  const watchGate = () => page.evaluate(() => new MutationObserver(() => { const g = document.getElementById('acGate'); if (g) window.__gate(g.innerText); }).observe(document.body, { childList: true, subtree: true, characterData: true }));

  // 1. A (ronaldo): the old player on this device is linked by its code, named ronaldo, and plays
  await started(page);
  await watchGate();
  const aLive = await live(page);
  assert.deepEqual(JSON.parse(aLive['gridsnake-player-v1']), { name: 'ronaldo', secret: BENZ });
  assert.equal(JSON.parse(aLive['gridsnake-profile-v2']).coins, 1234);
  assert.equal(w.players.benz.account, USERS.ronaldo.id);
  assert.deepEqual(await page.evaluate(() => SnakeLeaderboard.submitBest({ secret: 'x', score: 450, settings: { walls: true, golden: true, difficulty: 'hard' } })), { ok: true, improved: true, best: 450, rank: 1 });
  const aSave = JSON.stringify(w.players.benz.save);

  // 2. signed out on the website, in another tab: the game locks at once, without a reload
  const site = await ctx.newPage();
  await site.goto('https://atherbyte.online/account/');
  await site.evaluate(() => localStorage.removeItem('atherbyte-account-v1'));
  await page.waitForSelector('#acSignIn');
  assert.match(await page.innerText('#acGate'), /You signed out of Atherbyte/);
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => document.querySelectorAll('dialog[open]').length), 0);

  // 3. B (neymar) signs in on the game's own card: B's own, empty game, never A's data
  await signInHere(page, USERS.neymar);
  await page.waitForLoadState('load');
  await started(page);
  await watchGate();
  const bLive = await live(page);
  assert.equal(bLive['gridsnake-profile-v2'], undefined, 'none of A\'s coins, skins or achievements');
  assert.equal(bLive['gridsnake-best-timeattack-walls-golden'], undefined, 'none of A\'s bests');
  assert.equal(JSON.parse(bLive['gridsnake-player-v1']).name, 'neymar');
  assert.notEqual(JSON.parse(bLive['gridsnake-player-v1']).secret, BENZ, 'not A\'s recovery code');
  assert.ok(!w.calls.some((c) => c.account === 'neymar' && c.path.endsWith('/link')), 'A\'s code was never sent for B');
  await page.evaluate(() => { document.getElementById('profileDlg').showModal(); document.getElementById('profileDlg').close(); });   // first save makes B's player
  await page.waitForFunction(() => true);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(w.players.neymar && w.players.neymar.account, USERS.neymar.id, 'B got its own, separate player');
  assert.equal(JSON.stringify(w.players.benz.save), aSave, 'A\'s cloud save untouched by B');
  assert.equal(w.players.benz.best, 450);

  // 4. B signs out from the game; A signs in again: A's original progress, intact
  await page.evaluate(() => document.getElementById('profileDlg').showModal());
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForSelector('#acSignIn');
  await signInHere(page, USERS.ronaldo);
  await page.waitForLoadState('load');
  await started(page);
  assert.deepEqual(await live(page), aLive, 'A\'s player, code, coins, skins, achievements and bests are exactly as before');
  assert.equal(w.players.neymar.account, USERS.neymar.id, 'B\'s player stays B\'s');
  assert.equal(w.players.benz.account, USERS.ronaldo.id);
  assert.ok(!gateTexts.some((t) => /linked to a different|different Grid Snake player/.test(t)), 'no ownership warning at any point');
  assert.ok(!board.some((u) => /submit_best|register_player/.test(u)));
  assert.deepEqual(errors, []);
  await ctx.close();
});
