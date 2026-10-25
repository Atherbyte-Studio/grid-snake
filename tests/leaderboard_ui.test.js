'use strict';
/* The global board in a real page, against a mock of Supabase's REST API (no network, no real project).
 * Covers: posting a Time Attack run, the retry that reuses one run id, offline, server errors, the board
 * dialog, the not-configured state, and that classic runs never offer a post.
 * Run: node build.js && NODE_PATH=$(npm root -g) node --test tests/leaderboard_ui.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const base = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// Point the shipped config at a fake project, in memory only, and expose the game for the crash helper.
const MOCK = 'https://mock.supabase.test';
const withConfig = base
  .replace("url: '',                       // e.g. 'https://xyzcompany.supabase.co'", "url: '" + MOCK + "',")
  .replace("anonKey: '',                   // the public \"anon\" key only", "anonKey: 'anon-test',")
  .replace('/*TEST_HOOK*/', 'window.__t = { game: function () { return game; }, profile: profile };');
if (!withConfig.includes("url: '" + MOCK + "'")) throw new Error('could not inject the mock config');
const notConfigured = base.replace('/*TEST_HOOK*/', 'window.__t = { game: function () { return game; }, profile: profile };');

function mockBoard() {
  const state = { rows: [], posts: [], gets: 0, fail: [] };   // fail: queue of HTTP statuses to return before succeeding
  state.route = async route => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      state.posts.push(body);
      const code = state.fail.length ? state.fail.shift() : 201;
      if (code === 201) {
        if (state.rows.some(r => r.run_id === body.run_id)) return route.fulfill({ status: 409, body: '{"message":"duplicate"}', contentType: 'application/json' });
        state.rows.push({ name: body.name, score: body.score, created_at: new Date().toISOString(), run_id: body.run_id });
      }
      return route.fulfill({ status: code, body: code === 201 ? '' : '{"message":"x"}', contentType: 'application/json' });
    }
    state.gets++;
    const url = new URL(req.url());
    const sorted = state.rows.slice().sort((a, b) => b.score - a.score || a.created_at.localeCompare(b.created_at));
    const off = Number(url.searchParams.get('offset') || 0), lim = Number(url.searchParams.get('limit') || 20);
    const page = sorted.slice(off, off + lim).map(r => ({ name: r.name, score: r.score, created_at: r.created_at }));
    return route.fulfill({ status: 200, body: JSON.stringify(page), contentType: 'application/json' });
  };
  return state;
}

async function openGame(browser, { html, mode = 'timeattack', name = 'Waseem', mock }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(([p]) => { try { localStorage.setItem('gridsnake-profile-v2', JSON.stringify(p)); } catch (e) {} },
    [{ name: name, prefs: { mode: mode, edge: 'walls', controls: 'turn' } }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.route('https://lb.test/**', r => r.fulfill({ contentType: 'text/html', body: html }));
  if (mock) await page.route(MOCK + '/**', mock.route);
  await page.goto('https://lb.test/index.html');
  await page.evaluate(m => document.querySelector('[data-mode="' + m + '"]').click(), mode);
  await page.click('#playBtn');
  await page.waitForTimeout(300);
  return { ctx, page, errors };
}

async function endRun(page, score) {
  await page.evaluate(sc => {
    const s = window.__t.game().state;
    s.score = sc; s.snake = [{ x: 19, y: 10 }, { x: 18, y: 10 }, { x: 17, y: 10 }];
    s.goldSegs = [false, false, false]; s.dir = { x: 1, y: 0 }; s.queue = []; s.food = { x: 0, y: 0 };
  }, score);
  await page.waitForFunction(() => window.__t.game().state.phase === 'over', null, { timeout: 8000 });
  await page.waitForTimeout(150);
}

const txt = (page, sel) => page.$eval(sel, e => e.textContent.trim());

test('a Time Attack run posts once, and a retry of the same run is not counted twice', async () => {
  const browser = await chromium.launch();
  try {
    const mock = mockBoard();
    mock.fail = [500];                                   // the first post fails, the retry succeeds
    const { ctx, page, errors } = await openGame(browser, { html: withConfig, mock });
    await endRun(page, 25);
    assert.equal(await page.$eval('#ovPostRow', e => e.hidden), false, 'the post row shows after a Time Attack run');
    await page.click('#ovPost');
    await page.waitForFunction(() => /trouble|try again/i.test(document.getElementById('ovPostMsg').textContent), null, { timeout: 8000 });
    assert.equal(await page.$eval('#ovPost', e => e.disabled), false, 'the button comes back after a failure');
    await page.click('#ovPost');
    await page.waitForFunction(() => /Posted to the global board/.test(document.getElementById('ovPostMsg').textContent), null, { timeout: 8000 });
    assert.equal(mock.posts.length, 2, 'two requests: the failed one and the retry');
    assert.equal(mock.posts[0].run_id, mock.posts[1].run_id, 'the retry reuses the run id');
    assert.equal(mock.rows.length, 1, 'the board holds the run once');
    assert.equal(mock.posts[1].name, 'Waseem');
    assert.equal(mock.posts[1].score, 25);
    assert.deepEqual(errors, [], 'no page errors');
    await ctx.close();
  } finally { await browser.close(); }
});

test('the board dialog lists the posted score with its rank, and the names are plain text', async () => {
  const browser = await chromium.launch();
  try {
    const mock = mockBoard();
    mock.rows.push({ name: '<img src=x onerror=alert(1)>', score: 99, created_at: '2026-10-01T10:00:00Z', run_id: 'a' });
    mock.rows.push({ name: 'Ann', score: 40, created_at: '2026-10-02T10:00:00Z', run_id: 'b' });
    const { ctx, page, errors } = await openGame(browser, { html: withConfig, mock });
    await page.click('#ovSec').catch(() => {});                          // back to the menu
    await page.waitForTimeout(200);
    await page.click('#homeBoardBtn');
    await page.waitForFunction(() => document.querySelectorAll('#boardList li').length === 2, null, { timeout: 8000 });
    const rows = await page.$$eval('#boardList li', li => li.map(x => ({
      rank: x.querySelector('.rank').textContent, who: x.querySelector('.who').firstChild.textContent, pts: x.querySelector('.pts').textContent })));
    assert.deepEqual(rows.map(r => r.rank), ['#1', '#2'], 'ranked best first');
    assert.equal(rows[0].pts, '99');
    assert.equal(rows[1].who, 'Ann');
    assert.equal(rows[1].pts, '40');
    assert.equal(await page.$$eval('#boardList img', i => i.length), 0, 'a name is never rendered as HTML');
    // The display keeps the first 16 characters (the board's limit), as plain text.
    assert.equal(rows[0].who, '<img src=x onerr', 'the name is shown as plain text, cut to 16 characters');
    assert.deepEqual(errors, [], 'no page errors');
    await ctx.close();
  } finally { await browser.close(); }
});

test('offline: the post is not sent and the player is told why', async () => {
  const browser = await chromium.launch();
  try {
    const mock = mockBoard();
    const { ctx, page } = await openGame(browser, { html: withConfig, mock });
    await endRun(page, 12);
    await ctx.setOffline(true);
    await page.click('#ovPost');
    await page.waitForFunction(() => /offline/i.test(document.getElementById('ovPostMsg').textContent), null, { timeout: 8000 });
    assert.equal(mock.posts.length, 0, 'nothing was sent');
    await ctx.close();
  } finally { await browser.close(); }
});

test('with no project set up: no request is made and the board says so', async () => {
  const browser = await chromium.launch();
  try {
    let requests = 0;
    const { ctx, page } = await openGame(browser, { html: notConfigured, mock: { route: r => { requests++; return r.fulfill({ status: 200, body: '[]' }); } } });
    await endRun(page, 12);
    assert.match(await txt(page, '#ovPostMsg'), /not set up yet/);
    assert.equal(await page.$eval('#ovPost', e => e.disabled), true);
    await page.click('#ovSec').catch(() => {});
    await page.waitForTimeout(200);
    await page.click('#homeBoardBtn');
    await page.waitForTimeout(300);
    assert.match(await txt(page, '#boardMsg'), /not set up yet/);
    assert.equal(requests, 0, 'nothing was requested while unconfigured');
    await ctx.close();
  } finally { await browser.close(); }
});

test('a classic run never offers a post', async () => {
  const browser = await chromium.launch();
  try {
    const mock = mockBoard();
    const { ctx, page } = await openGame(browser, { html: withConfig, mode: 'classic', mock });
    await endRun(page, 12);
    assert.equal(await page.$eval('#ovPostRow', e => e.hidden), true, 'no post row for Classic');
    assert.equal(mock.posts.length, 0);
    await ctx.close();
  } finally { await browser.close(); }
});
