'use strict';
/* The Atherbyte sign-in in the real web page, served as https://atherbyte.online/grid-snake/ with the studio site's real
 * account client (../Atherbyte-Studio.github.io/js, or ATHERBYTE_SITE) and a stand-in for the Worker. No network.
 * Skipped when the studio site's files are not next to this repository.
 * Run: node build.js && NODE_PATH=$(npm root -g) node --test tests/account_link_ui.test.js */
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
const USER = { id: '11111111-1111-4111-8111-111111111111', username: 'ronaldo' };
const session = (expiresAt) => ({ 'atherbyte-account-v1': JSON.stringify({ access_token: 'access-ok', refresh_token: 'refresh-old', expires_at: expiresAt || 4102444800, user: USER }) });
const benzema = {
  'gridsnake-player-v1': JSON.stringify({ name: 'Benzema', secret: BENZ }),
  'gridsnake-profile-v2': JSON.stringify({ name: 'Benzema', coins: 1234, owned: { 'skin:jordan': true }, totals: { runs: 40, foods: 900, bonus: 0 }, ach: { foods: { tier: 2, progress: 900 } }, savedAt: 5000 }),
  'gridsnake-best-timeattack-walls-golden': '300'
};

let browser;
test.before(async () => { if (!skip) browser = await require('playwright').chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

async function open(seed, opts = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  await ctx.addInitScript((s) => Object.keys(s).forEach((k) => { if (localStorage.getItem(k) === null) localStorage.setItem(k, s[k]); }), seed);
  const page = await ctx.newPage();
  const errors = [], calls = [], board = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const worker = { linked: opts.linked || null, save: null };
  await page.route(/fonts\.(googleapis|gstatic)\.com|googlesyndication/, (r) => r.abort());
  await page.route(/supabase\.co/, (r) => { board.push(r.request().url()); r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }); });
  await page.route('https://atherbyte.online/grid-snake/', (r) => r.fulfill({ contentType: 'text/html', body: html }));
  await page.route('https://atherbyte.online/js/site-config.js', (r) => r.fulfill({ contentType: 'text/javascript',
    body: 'window.ATHERBYTE_CONFIG = { account: { apiBaseUrl: "' + API + '", turnstileSiteKey: "", features: {} } };' }));
  await page.route('https://atherbyte.online/js/atherbyte-account.js', (r) => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(CLIENT, 'utf8') }));
  await page.route(API + '/**', (r) => {
    const req = r.request(), p = new URL(req.url()).pathname;
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST' };
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    if (opts.offline) return r.abort('internetdisconnected');
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    const auth = req.headers().authorization || '';
    calls.push({ path: p, body, auth });
    const json = (status, b) => r.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(b) });
    if (p === '/v1/auth/refresh') return json(401, { error: 'invalid_refresh' });
    if (auth !== 'Bearer access-ok') return json(401, { error: 'unauthorized' });
    if (p === '/v1/me') return json(200, { id: USER.id, username: 'ronaldo' });
    if (p.endsWith('/player')) return json(200, worker.linked ? { linked: true, name: worker.linked, best: 300, rank: 2, save: worker.save } : { linked: false });
    if (p.endsWith('/link')) {
      if (body.recovery_code !== BENZ) return json(404, { error: 'unknown_player' });
      worker.linked = worker.linked || 'Benzema';
      return json(200, { status: 'linked', name: worker.linked, best: 300, rank: 2 });
    }
    if (p.endsWith('/name')) {
      if (!worker.linked && !body.create) return json(409, { error: 'not_linked' });
      const status = worker.linked ? 'ok' : 'created';
      worker.linked = 'ronaldo';     // the username, from the account (never from this request)
      return json(200, { status, name: 'ronaldo', renamed: status === 'ok', reason: null });
    }
    if (p.endsWith('/save')) {
      const cur = worker.save ? worker.save.version : null;
      if (body.base_version !== cur) return json(409, { error: 'save_conflict', version: cur });
      worker.save = { version: (cur || 0) + 1, data: body.data };
      return json(200, { version: worker.save.version });
    }
    if (p.endsWith('/score')) return json(200, { improved: true, best: body.score, rank: 1 });
    return json(404, { error: 'not_found' });
  });
  await page.goto('https://atherbyte.online/grid-snake/');
  return { ctx, page, errors, calls, board, worker };
}
const gateText = (page) => page.evaluate(() => { const g = document.getElementById('acGate'); return g ? g.innerText : ''; });
const gameRan = (page) => page.evaluate(() => typeof window.SnakeLeaderboard !== 'undefined' || !document.getElementById('playBtn').disabled);
async function stoppedAtGate(page, re) {
  await page.waitForFunction((src) => new RegExp(src).test((document.getElementById('acGate') || {}).innerText || ''), re.source);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());   // keys reach the page, not a link
  await page.keyboard.press('Space'); await page.keyboard.press('Enter');
  assert.equal(await gameRan(page), false, 'the game code has not run');
  assert.equal(await page.evaluate(() => document.getElementById('welcomeDlg').open), false, 'no local name box');
}

test('signed out: the sign-in screen, and the game does not start', { skip }, async () => {
  const { ctx, page, errors, calls } = await open(benzema);
  await stoppedAtGate(page, /Sign in to your Atherbyte account/);
  const links = await page.$$eval('#acGateActions a', (as) => as.map((a) => [a.textContent, a.getAttribute('href')]));
  assert.deepEqual(links, [['Sign in', '/account/?next=%2Fgrid-snake%2F'], ['Create an account', '/account/?next=%2Fgrid-snake%2F']]);
  // removing the screen does not start the game either: its code is still inert text
  await page.evaluate(() => document.getElementById('acGate').remove());
  assert.equal(await gameRan(page), false);
  assert.equal(calls.length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('expired session that cannot be refreshed: back to the sign-in screen', { skip }, async () => {
  const { ctx, page, calls } = await open(Object.assign({}, benzema, session(1000)));
  await stoppedAtGate(page, /Sign in to your Atherbyte account/);
  assert.ok(calls.some((c) => c.path === '/v1/auth/refresh'));
  assert.equal(await page.evaluate(() => localStorage.getItem('atherbyte-account-v1')), null, 'the dead session is cleared');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gridsnake-profile-v2')).coins), 1234, 'progress untouched');
  await ctx.close();
});

test('network failure: a retry screen, the game does not start, and nothing changes', { skip }, async () => {
  const { ctx, page } = await open(Object.assign({}, benzema, session()), { offline: true });
  await stoppedAtGate(page, /Could not reach your Atherbyte account/);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gridsnake-player-v1')).name), 'Benzema');
  await ctx.close();
});

test('new account on an empty device: one click starts the game as ronaldo', { skip }, async () => {
  const { ctx, page, errors, calls } = await open(session());
  await page.waitForFunction(() => /New here\? Start playing as ronaldo/.test((document.getElementById('acGate') || {}).innerText || ''));
  assert.equal(await gameRan(page), false);
  await page.getByRole('button', { name: 'Start as ronaldo' }).click();
  await page.waitForFunction(() => !document.getElementById('acGate') && !document.getElementById('playBtn').disabled);
  assert.deepEqual(calls.find((c) => c.path.endsWith('/name')).body, { create: true });
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gridsnake-player-v1')).name), 'ronaldo');
  assert.equal(await page.evaluate(() => document.getElementById('welcomeDlg').open), false);
  assert.equal(await page.evaluate(() => SnakeLeaderboard.__account), true, 'board calls go through the account');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('old player with progress: linked by its code, named ronaldo, progress kept and saved; scores via the Worker', { skip }, async () => {
  const { ctx, page, errors, calls, board, worker } = await open(Object.assign({}, benzema, session()));
  await page.waitForFunction(() => !document.getElementById('acGate') && !document.getElementById('playBtn').disabled);
  assert.deepEqual(calls.find((c) => c.path.endsWith('/link')).body, { recovery_code: BENZ });
  assert.deepEqual(calls.find((c) => c.path.endsWith('/name')).body, { create: false });
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('gridsnake-player-v1'))), { name: 'ronaldo', secret: BENZ });
  const prof = await page.evaluate(() => JSON.parse(localStorage.getItem('gridsnake-profile-v2')));
  assert.equal(prof.coins, 1234);
  assert.deepEqual(prof.owned, { 'skin:jordan': true });
  assert.equal(await page.evaluate(() => localStorage.getItem('gridsnake-best-timeattack-walls-golden')), '300');
  assert.equal(worker.save.data.data.coins, 1234, 'the progress is saved to the account');
  assert.equal(await page.evaluate(() => (document.getElementById('acStatus') || {}).textContent), 'Signed in as ronaldo. Your progress is kept with your Atherbyte account.');
  const r = await page.evaluate(() => SnakeLeaderboard.submitBest({ secret: 'x', score: 450, settings: { walls: true, golden: true, difficulty: 'hard' } }));
  assert.deepEqual(r, { ok: true, improved: true, best: 450, rank: 1 });
  assert.ok(!board.some((u) => /submit_best|register_player/.test(u)));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('progress but no recovery code: not linked by guess, backup shown, and the typed code links it', { skip }, async () => {
  const seed = Object.assign({}, session(), { 'gridsnake-profile-v2': JSON.stringify({ coins: 77, owned: { 'board:neon': true }, savedAt: 9 }) });
  const { ctx, page, calls, worker } = await open(seed);
  await stoppedAtGate(page, /not linked to an account yet/);
  assert.match(await page.inputValue('#acGateBackup'), /^GS2\./);
  assert.ok(!calls.some((c) => c.path.endsWith('/link') || c.path.endsWith('/name')), 'nothing linked or created by itself');
  await page.fill('#acGateCode', 'BBBB-BBBB-BBBB-BBBB-BBBB-BBBB-BBBB-BBBB');
  await page.getByRole('button', { name: 'Link my recovery code' }).click();
  await page.waitForFunction(() => !document.getElementById('acGate') || /different Grid Snake progress/.test(document.getElementById('acGate').innerText));
  assert.equal(worker.linked, 'ronaldo');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gridsnake-profile-v2')).coins), 77, 'this device\'s progress is still there');
  await ctx.close();
});
