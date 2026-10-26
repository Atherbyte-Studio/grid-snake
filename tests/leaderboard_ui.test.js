'use strict';
/* The global board in a real page, against a stand-in for the database functions (tests/support/board.js).
 * No network. Covers: the first visit (name, recovery code), taken names, automatic posting of ranked rounds,
 * failure and retry, offline, locked ranked settings, the top ten and your own row, recovery on a new device,
 * and the not-configured state. Run: node build.js && NODE_PATH=$(npm root -g) node --test tests/leaderboard_ui.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { KEY, SECRET, identityStorage, makeBoard, defaultBoard } = require('./support/board.js');

const ROOT = path.join(__dirname, '..');
const base = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const MOCK = 'https://mock.supabase.test';
const SHIPPED_URL = "url: 'https://tmmzahzkqmcgbtjimtjn.supabase.co'";
const SHIPPED_KEY = "anonKey: 'sb_publishable_HC2_4BGM2Foe0SIduZBMwg__Ln0bKx4'";
const hook = 'window.__t = { game: function () { return game; }, profile: profile };';
const withConfig = base.replace(SHIPPED_URL, "url: '" + MOCK + "'").replace(SHIPPED_KEY, "anonKey: 'sb_publishable_mock'").replace('/*TEST_HOOK*/', hook);
if (!withConfig.includes("url: '" + MOCK + "'")) throw new Error('could not inject the mock config');
const notConfigured = base.replace(SHIPPED_URL, "url: ''").replace(SHIPPED_KEY, "anonKey: ''").replace('/*TEST_HOOK*/', hook);
if (notConfigured.includes('tmmzahzkqmcgbtjimtjn')) throw new Error('could not blank the config');

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

async function open({ html = withConfig, mode = 'timeattack', identity = true, board = null }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
  const stored = Object.assign({ 'gridsnake-profile-v2': JSON.stringify({ name: identity ? 'Waseem' : '', prefs: { mode: mode, edge: 'walls', controls: 'turn' } }) },
    identity ? identityStorage('Waseem') : {});
  await ctx.addInitScript(s => Object.keys(s).forEach(k => { try { if (localStorage.getItem(k) === null) localStorage.setItem(k, s[k]); } catch (e) {} }), stored);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const requests = [];
  page.on('request', r => { if (/rest\/v1/.test(r.url())) requests.push(r.url()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.route('https://lb.test/**', r => r.fulfill({ contentType: 'text/html', body: html }));
  if (board) await page.route(MOCK + '/**', board.route);
  await page.goto('https://lb.test/index.html');
  await page.waitForFunction(() => !document.getElementById('playBtn').disabled);
  await page.evaluate(m => document.querySelector('[data-mode="' + m + '"]').click(), mode);
  return { ctx, page, errors, requests };
}

async function startRound(page) {
  await page.evaluate(() => { if (document.getElementById('welcomeDlg').open) document.getElementById('welcomeDlg').close(); });
  await page.click('#playBtn');
  await page.waitForTimeout(250);
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
const text = (page, sel) => page.evaluate(s => document.querySelector(s).textContent.trim(), sel);
const waitText = (page, sel, part) => page.waitForFunction(([s, p]) => document.querySelector(s).textContent.includes(p), [sel, part], { timeout: 8000 });
const others = n => Array.from({ length: n }, (_, i) => ({ name: 'P' + (i + 1), best: 200 - i * 10 }));

test('first visit: a name is asked for, and the new player gets a recovery code to save', { timeout: 60000 }, async () => {
  const db = makeBoard([]);
  const { ctx, page, errors } = await open({ identity: false, board: db });
  assert.equal(await page.evaluate(() => document.getElementById('welcomeDlg').open), true, 'the welcome box opens');
  await page.fill('#welcomeInput', 'Waseem');
  await page.click('#welcomeCreate');
  await page.waitForSelector('#welcomeCodeBox:not([hidden])', { timeout: 8000 });
  const shown = await text(page, '#welcomeSecret');
  assert.match(shown, /^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/, 'the code is shown in groups of four');
  const stored = JSON.parse(await page.evaluate(k => localStorage.getItem(k), KEY));
  assert.equal(stored.name, 'Waseem');
  assert.equal(stored.secret, shown.replace(/-/g, ''), 'the browser keeps the same code that was shown');
  await page.click('#welcomeSaved');
  assert.equal(await page.evaluate(() => document.getElementById('welcomeDlg').open), false);
  assert.equal(db.players.length, 1);
  assert.equal(db.players[0].name, 'Waseem');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a taken name is refused, ignoring case, and nothing is stored', { timeout: 60000 }, async () => {
  const db = makeBoard([{ name: 'Ali', best: 10 }]);
  const { ctx, page } = await open({ identity: false, board: db });
  await page.fill('#welcomeInput', 'ALI');
  await page.click('#welcomeCreate');
  await waitText(page, '#welcomeMsg', 'already taken');
  assert.equal(await page.evaluate(() => document.getElementById('welcomeDlg').open), true, 'the box stays open for another name');
  assert.equal(await page.evaluate(k => localStorage.getItem(k), KEY), null);
  await ctx.close();
});

test('a name outside the rules is refused before anything is sent', { timeout: 60000 }, async () => {
  const db = makeBoard([]);
  const { ctx, page } = await open({ identity: false, board: db });
  await page.fill('#welcomeInput', '<b>x');
  await page.click('#welcomeCreate');
  await waitText(page, '#welcomeMsg', 'Use 1 to 16');
  assert.equal(db.calls.filter(c => c.fn === 'register_player').length, 0);
  await ctx.close();
});

test('a ranked round is sent by itself: a new best, then a lower score that keeps it', { timeout: 90000 }, async () => {
  const db = defaultBoard();
  const { ctx, page, errors } = await open({ board: db });
  await startRound(page);
  await endRun(page, 120);
  await waitText(page, '#ovRankMsg', 'New Personal Best! 120');
  assert.equal(db.players[0].best, 120);
  assert.equal(await page.$('#ovPost'), null, 'there is no Post score button');
  await page.click('#ovBtn');                 // Play again starts the next round
  await page.waitForTimeout(250);
  await endRun(page, 50);
  await waitText(page, '#ovRankMsg', 'Your best remains 120.');
  assert.equal(db.players[0].best, 120, 'a lower score never lowers the best');
  assert.equal(db.submits().length, 2);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a failed send says so, keeps the score, and sends it on Try again, once', { timeout: 90000 }, async () => {
  const db = defaultBoard();
  db.fail = [500];
  const { ctx, page } = await open({ board: db });
  await startRound(page);
  await endRun(page, 90);
  await waitText(page, '#ovRankMsg', 'will be sent again');
  assert.equal(await page.evaluate(() => document.getElementById('ovRankMsg').textContent.includes('saved')), false, 'no false claim of saving');
  assert.equal(await page.evaluate(() => document.getElementById('ovRetry').hidden), false, 'Try again is offered');
  await page.click('#ovRetry');
  await waitText(page, '#ovRankMsg', 'New Personal Best! 90');
  assert.equal(db.players[0].best, 90);
  assert.equal(db.submits().length, 2, 'one failed try and one success');
  await ctx.close();
});

test('offline: nothing is claimed as saved, and the score is sent when the connection returns', { timeout: 90000 }, async () => {
  const db = defaultBoard();
  const { ctx, page } = await open({ board: db });
  await startRound(page);
  await ctx.setOffline(true);
  await endRun(page, 70);
  await waitText(page, '#ovRankMsg', 'offline');
  assert.equal(db.players[0].best, null, 'nothing reached the board while offline');
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitText(page, '#ovRankMsg', 'New Personal Best! 70');
  assert.equal(db.players[0].best, 70);
  await ctx.close();
});

test('a classic round is never sent to the board', { timeout: 60000 }, async () => {
  const db = defaultBoard();
  const { ctx, page } = await open({ board: db, mode: 'classic' });
  await startRound(page);
  await endRun(page, 80);
  await page.waitForTimeout(300);
  assert.equal(db.submits().length, 0);
  assert.equal(await page.evaluate(() => document.getElementById('ovRankRow').hidden), true);
  await ctx.close();
});

test('Time Attack fixes the ranked settings and sends them with the score', { timeout: 90000 }, async () => {
  const db = defaultBoard();
  const { ctx, page } = await open({ board: db });
  for (const id of ['#modeWrap', '#goldOff', '#diffEasy', '#diffNormal']) {
    assert.equal(await page.evaluate(s => document.querySelector(s).disabled, id), true, id + ' is locked');
  }
  await startRound(page);
  await endRun(page, 60);
  await waitText(page, '#ovRankMsg', 'New Personal Best! 60');
  assert.deepEqual(db.submits()[0].body, { p_secret: SECRET, p_score: 60, p_walls: true, p_golden: true, p_difficulty: 'hard' });
  await ctx.close();
});

test('the board: ten rows at most, and your own best below them when you are outside the top ten', { timeout: 90000 }, async () => {
  const db = makeBoard([{ name: 'Waseem', secret: SECRET, best: 50 }].concat(others(12)));
  const { ctx, page } = await open({ board: db });
  await page.click('#homeBoardBtn');
  await page.waitForSelector('#boardList li');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#boardList li').length), 10);
  assert.equal(await page.evaluate(() => document.getElementById('boardYou').hidden), false);
  assert.match(await text(page, '#boardYouList'), /#13/, 'the true rank, not 11');
  assert.match(await text(page, '#boardYouList'), /Waseem/);
  await ctx.close();
});

test('a player inside the top ten is highlighted once, with no extra row', { timeout: 90000 }, async () => {
  const db = makeBoard([{ name: 'Waseem', secret: SECRET, best: 150 }].concat(others(5)));
  const { ctx, page } = await open({ board: db });
  await page.click('#homeBoardBtn');
  await page.waitForSelector('#boardList li');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#boardList li.me').length), 1);
  assert.equal(await page.evaluate(() => document.getElementById('boardYou').hidden), true);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#boardList li').length), 6);
  await ctx.close();
});

test('a new device: the recovery code brings back the same name and best', { timeout: 90000 }, async () => {
  const db = makeBoard([{ name: 'Waseem', secret: SECRET, best: 150 }].concat(others(3)));
  const { ctx, page } = await open({ identity: false, board: db });
  await page.click('summary:has-text("recovery code")');
  await page.fill('#welcomeRecover', '0123-4567-89AB-CDEF-0123-4567-89ab-cdef');
  await page.click('#welcomeRecoverBtn');
  await page.waitForFunction(() => !document.getElementById('welcomeDlg').open, null, { timeout: 8000 });
  const stored = JSON.parse(await page.evaluate(k => localStorage.getItem(k), KEY));
  assert.equal(stored.name, 'Waseem');
  assert.equal(stored.secret, SECRET);
  assert.equal(await page.evaluate(() => window.__t.profile.getName()), 'Waseem');
  await ctx.close();
});

test('a wrong recovery code says so and does not change anything', { timeout: 60000 }, async () => {
  const db = makeBoard([{ name: 'Waseem', secret: SECRET, best: 150 }]);
  const { ctx, page } = await open({ identity: false, board: db });
  await page.click('summary:has-text("recovery code")');
  await page.fill('#welcomeRecover', 'ffffffffffffffffffffffffffffffff');
  await page.click('#welcomeRecoverBtn');
  await waitText(page, '#welcomeMsg', 'does not match any player');
  assert.equal(await page.evaluate(k => localStorage.getItem(k), KEY), null);
  await ctx.close();
});

test('without a configured board, no name is asked for and nothing is sent', { timeout: 60000 }, async () => {
  const { ctx, page, errors, requests } = await open({ html: notConfigured, identity: false });
  assert.equal(await page.evaluate(() => document.getElementById('welcomeDlg').open), false);
  await startRound(page);
  await endRun(page, 50);
  await waitText(page, '#ovRankMsg', 'not set up yet');
  assert.equal(requests.length, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a ranked round waits for a player: "Play for now" then Play asks for the name again', { timeout: 60000 }, async () => {
  const db = makeBoard([]);
  const { ctx, page } = await open({ identity: false, board: db });
  await page.click('#welcomeLater');
  assert.equal(await page.evaluate(() => document.getElementById('welcomeDlg').open), false);
  await page.click('#playBtn');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => document.getElementById('welcomeDlg').open), true, 'a ranked round needs a player');
  assert.equal(await page.evaluate(() => document.getElementById('game').hidden), true, 'the round did not start');
  await ctx.close();
});
