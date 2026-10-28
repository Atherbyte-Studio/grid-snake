'use strict';
/* The Atherbyte account panel in the real web page, served as https://atherbyte.online/grid-snake/ with the studio
 * site's real account client (../Atherbyte-Studio.github.io/js, or ATHERBYTE_SITE) and a stand-in for the Worker.
 * No network. Skipped when the studio site's files are not next to this repository.
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

async function open(browser, seed) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  await ctx.addInitScript((s) => Object.keys(s).forEach((k) => { if (localStorage.getItem(k) === null) localStorage.setItem(k, s[k]); }), seed);
  const page = await ctx.newPage();
  const errors = [], calls = [], board = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  const worker = { linked: false, save: null };
  await page.route(/fonts\.(googleapis|gstatic)\.com|googlesyndication/, (r) => r.abort());
  await page.route(/supabase\.co/, (r) => { board.push(r.request().url()); r.fulfill({ status: 401, body: '{}' }); });
  await page.route('https://atherbyte.online/grid-snake/', (r) => r.fulfill({ contentType: 'text/html', body: html }));
  await page.route('https://atherbyte.online/js/site-config.js', (r) => r.fulfill({ contentType: 'text/javascript',
    body: 'window.ATHERBYTE_CONFIG = { account: { apiBaseUrl: "' + API + '", turnstileSiteKey: "", features: {} } };' }));
  await page.route('https://atherbyte.online/js/atherbyte-account.js', (r) => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(CLIENT, 'utf8') }));
  await page.route(API + '/**', (r) => {
    const req = r.request(), p = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    calls.push({ path: p, method: req.method(), auth: req.headers().authorization || '', body });
    const json = (status, b) => r.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(b) });
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST' } });
    if (p.endsWith('/player')) return json(200, worker.linked ? { linked: true, name: 'Benzema', best: 300, rank: 2, save: worker.save } : { linked: false });
    if (p.endsWith('/link')) { worker.linked = body.recovery_code === BENZ; return worker.linked ? json(200, { status: 'linked', name: 'Benzema', best: 300, rank: 2 }) : json(404, { error: 'unknown_player' }); }
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
  await page.waitForFunction(() => !document.getElementById('playBtn').disabled);
  return { ctx, page, errors, calls, board, worker };
}

const signedIn = { 'atherbyte-account-v1': JSON.stringify({ access_token: 'access-token-test', refresh_token: 'refresh-token-test', expires_at: 4102444800, user: USER }) };
const benzema = {
  'gridsnake-player-v1': JSON.stringify({ name: 'Benzema', secret: BENZ }),
  'gridsnake-profile-v2': JSON.stringify({ name: 'Benzema', coins: 1234, owned: { 'skin:jordan': true }, totals: { runs: 40, foods: 900, bonus: 0 }, savedAt: 5000 }),
  'gridsnake-best-timeattack-walls-golden': '300'
};

test('account panel: link Benzema to ronaldo, save the progress, and send ranked scores through the Worker', { skip }, async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors, calls, board, worker } = await open(browser, Object.assign({}, signedIn, benzema));
    await page.evaluate(() => document.getElementById('profileDlg').showModal());
    await page.waitForFunction(() => /Link this device/.test(document.getElementById('acStatus').textContent));
    await page.getByRole('button', { name: 'Link this player' }).click();
    await page.waitForFunction(() => /^Linked: Benzema/.test(document.getElementById('acStatus').textContent));

    const link = calls.find((c) => c.path.endsWith('/link'));
    assert.deepEqual(link.body, { recovery_code: BENZ }, 'only the recovery code is sent, never an account id');
    assert.equal(link.auth, 'Bearer access-token-test');
    assert.equal(worker.save.version, 1);
    assert.equal(worker.save.data.data.coins, 1234);
    assert.deepEqual(worker.save.data.data.owned, { 'skin:jordan': true });
    assert.equal(worker.save.data.bests['gridsnake-best-timeattack-walls-golden'], 300);
    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('gridsnake-backups-v1')));
    assert.equal(kept[0].reason, 'before-link');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gridsnake-profile-v2')).coins), 1234, 'the device keeps its progress');

    const r = await page.evaluate(() => SnakeLeaderboard.submitBest({ secret: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', score: 450, settings: { walls: true, golden: true, difficulty: 'hard' } }));
    assert.deepEqual(r, { ok: true, improved: true, best: 450, rank: 1 });
    assert.deepEqual(calls.find((c) => c.path.endsWith('/score')).body, { score: 450, walls: true, golden: true, difficulty: 'hard' });
    assert.ok(!board.some((u) => /submit_best/.test(u)), 'the browser does not call submit_best for a linked player');
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); }
});

test('account panel: signed out, nothing is sent and the game is unchanged', { skip }, async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const { ctx, page, errors, calls } = await open(browser, benzema);
    await page.evaluate(() => document.getElementById('profileDlg').showModal());
    await page.waitForFunction(() => /Sign in to keep/.test(document.getElementById('acStatus').textContent));
    assert.equal(calls.length, 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await browser.close(); }
});
