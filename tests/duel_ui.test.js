'use strict';
/* Grid Snake Duel in a real browser (Chromium through Playwright).
 * Run: node build.js && NODE_PATH=$(npm root -g) E2E_OUT=<folder for screenshots> node --test tests/duel_ui.test.js
 * The page is grid-snake.html with test-only changes made in memory: a hook exposing the Duel state, shorter rounds,
 * an early event and a short countdown, so a whole match runs in seconds. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { KEY, SECRET, defaultBoard } = require('./support/board.js');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'duel-ui-'));
fs.mkdirSync(OUT, { recursive: true });
const ORIGIN = 'https://e2e.test';
const TWEAKS = [
  ['roundMs: 90000,', 'roundMs: 7000,'],
  ['announceMs: 8000,', 'announceMs: 700,'],
  ['eventMs: 10500,', 'eventMs: 1400,'],
  ['DD.flow = \'countdown\'; DD.flowT = 3000;', 'DD.flow = \'countdown\'; DD.flowT = 400;'],
  ['DD.flowT = 2700;', 'DD.flowT = 900;'],
  ['var events = Events.order(rng, MAX_ROUNDS);', 'var events = Events.order(rng, MAX_ROUNDS); if (window.__ev) events = events.map(function () { return window.__ev; });']
];

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

function pageHtml() {
  let src = fs.readFileSync(path.join(ROOT, 'grid-snake.html'), 'utf8');
  TWEAKS.forEach(([a, b]) => { assert.equal(src.split(a).length, 2, 'tweak target must occur once: ' + a); src = src.replace(a, b); });
  src = src.replace('/*TEST_HOOK*/', 'window.__t = { duel: function () { return DD; }, game: function () { return game; }, view: function () { return view; } };');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<style>:root{color-scheme:light}body{margin:0}</style></head><body>' + src + '</body></html>';
}

async function open(context, storage, ev) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 860 } }, context || {}));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await ctx.addInitScript(([k, v]) => { try { if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } catch (e) {} }, [KEY, JSON.stringify({ name: 'Waseem', secret: SECRET })]);
  if (ev) await ctx.addInitScript(e => { window.__ev = e; }, ev);
  const seed = Object.assign({ 'gridsnake-profile-v2': JSON.stringify({ name: 'Tester', prefs: { mode: 'classic', edge: 'walls' } }) }, storage || {});
  await ctx.addInitScript(s => Object.keys(s).forEach(k => { try { if (localStorage.getItem(k) === null) localStorage.setItem(k, s[k]); } catch (e) {} }), seed);
  await page.route('**/rest/v1/rpc/**', defaultBoard().route);
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const html = pageHtml();
  await page.route(ORIGIN + '/**', r => r.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(ORIGIN + '/index.html');
  await page.waitForFunction(() => !document.getElementById('playBtn').disabled);
  return { ctx, page, errors };
}
const visible = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && !e.closest('[hidden]') && r.width > 0; }, sel);
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png') });
const duel = (page, fn) => page.evaluate(fn);

test('the home screen offers the Duel; its menu has the three rivals, the record and the rules, and leads back', async () => {
  const { ctx, page, errors } = await open();
  assert.ok(await visible(page, '#duelEntry'));
  assert.ok(await visible(page, '#playBtn'));
  await shot(page, 'home-with-duel');
  await page.click('#duelEntry');
  assert.equal(await page.evaluate(() => __t.view()), 'duel');
  assert.ok(await visible(page, '#duelMenu'));
  assert.equal(await page.locator('#duelLevels button').count(), 3);
  assert.equal(await page.locator('#duelStatList > div').count(), 8);
  assert.equal(await page.locator('#duelEventList li').count(), 5);
  assert.equal(await page.getAttribute('#duelLevels [data-level="medium"]', 'aria-checked'), 'true');
  await page.click('#duelLevels [data-level="hard"]');
  assert.equal(await page.getAttribute('#duelLevels [data-level="hard"]', 'aria-checked'), 'true');
  await page.keyboard.press('ArrowLeft');                         // radio group: arrows move the choice
  assert.equal(await page.getAttribute('#duelLevels [data-level="medium"]', 'aria-checked'), 'true');
  await page.click('#duelLevels [data-level="hard"]');
  await shot(page, 'duel-menu-desktop');
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('playBtn').disabled);
  await page.click('#duelEntry');
  assert.equal(await page.getAttribute('#duelLevels [data-level="hard"]', 'aria-checked'), 'true', 'the rival level is remembered');
  await page.click('#duelBack');
  assert.equal(await page.evaluate(() => __t.view()), 'home');
  assert.ok(await visible(page, '#home'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a match: countdown, both snakes move, keys steer (no reversal), the event is announced and shown', async () => {
  const { ctx, page, errors } = await open();
  await page.click('#duelEntry');
  await page.click('#duelLevels [data-level="easy"]');
  await page.click('#duelStart');
  assert.ok(await visible(page, '#duelOv'));
  await page.waitForFunction(() => __t.duel().round && __t.duel().round.state.phase === 'running');
  const s0 = await duel(page, () => __t.duel().round.state.snakes.map(s => s.body[0]));
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => __t.duel().round.state.tick >= 3);
  const s1 = await duel(page, () => { const S = __t.duel().round.state; return { heads: S.snakes.map(s => s.body[0]), dir: S.snakes[0].dir }; });
  assert.notDeepEqual(s1.heads[0], s0[0]);
  assert.notDeepEqual(s1.heads[1], s0[1]);
  assert.deepEqual(s1.dir, { x: 0, y: 1 });
  await page.keyboard.press('ArrowUp');                         // straight back: ignored
  await page.waitForFunction(t => __t.duel().round.state.tick >= t + 2, await duel(page, () => __t.duel().round.state.tick));
  assert.deepEqual(await duel(page, () => __t.duel().round.state.snakes[0].dir), { x: 0, y: 1 });
  await page.keyboard.press('ArrowLeft');
  // keep the player alive while the event starts
  await page.evaluate(() => { const S = __t.duel().round.state; S.snakes[0].body = [{ x: 14, y: 6 }, { x: 15, y: 6 }]; S.snakes[0].dir = { x: -1, y: 0 }; });
  await page.waitForFunction(() => { const r = __t.duel().round; return !r || r.state.eventPhase === 'live' || r.state.phase === 'over'; });
  const ev = await duel(page, () => { const r = __t.duel().round; return { phase: r.state.eventPhase, name: document.getElementById('duelEventName').textContent, status: document.getElementById('duelEventStatus').textContent, banner: !!__t.duel().banner }; });
  if (ev.phase === 'live') {
    assert.ok(ev.name.length > 3, 'event name in the HUD');
    assert.ok(ev.status.length > 3, 'event status in the HUD');
  }
  assert.match(await page.textContent('#duelRound'), /Round 1/);
  assert.match(await page.textContent('#duelClock'), /^(OT )?\d:\d\d$/);
  await shot(page, 'duel-play-desktop');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('pause and resume with Space; leaving mid-match is not counted', async () => {
  const { ctx, page, errors } = await open();
  await page.click('#duelEntry');
  await page.click('#duelStart');
  await page.waitForFunction(() => __t.duel().round && __t.duel().round.state.phase === 'running');
  await page.keyboard.press('Space');
  assert.equal(await duel(page, () => __t.duel().round.state.phase), 'paused');
  assert.match(await page.textContent('#duelOvKicker'), /Paused/);
  assert.ok(await visible(page, '#duelOvMain'));
  await shot(page, 'duel-paused');
  const t = await duel(page, () => __t.duel().round.state.tick);
  await page.waitForTimeout(400);
  assert.equal(await duel(page, () => __t.duel().round.state.tick), t, 'time stands still while paused');
  await page.keyboard.press('Space');
  assert.equal(await duel(page, () => __t.duel().round.state.phase), 'running');
  await page.click('#duelLeaveBtn');
  assert.ok(await visible(page, '#duelMenu'));
  const stats = await page.evaluate(() => JSON.parse(localStorage.getItem('gridsnake-duel-stats-v1') || 'null'));
  assert.ok(!stats || stats.played === 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a whole match to the results screen; stats are saved under their own key; rematch and menu work', async () => {
  const { ctx, page, errors } = await open();
  await page.waitForTimeout(600);                                // the game's own start-up save is done
  const profileBefore = await page.evaluate(() => localStorage.getItem('gridsnake-profile-v2'));
  await page.click('#duelEntry');
  await page.click('#duelStart');
  // the player drives into the top wall every round: the rival wins two rounds
  for (let i = 0; i < 6; i++) {
    await page.waitForFunction(() => { const d = __t.duel(); return d.flow === 'results' || (d.round && d.round.state.phase === 'running'); }, null, { timeout: 15000 });
    if (await duel(page, () => __t.duel().flow === 'results')) break;
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => { const d = __t.duel(); return d.flow === 'results' || !d.round || d.round.state.phase === 'over'; }, null, { timeout: 15000 });
    if (await duel(page, () => __t.duel().flow === 'results')) break;
    await page.waitForFunction(() => __t.duel().flow !== 'toNext' || __t.duel().flowT < 0, null, { timeout: 15000 }).catch(() => {});
  }
  await page.waitForFunction(() => __t.duel().flow === 'results', null, { timeout: 15000 });
  const title = await page.textContent('#duelOvTitle');
  assert.ok(/Defeat|Victory|Match drawn/.test(title), title);
  assert.ok(await visible(page, '#duelOvMain'));
  assert.match(await page.textContent('#duelOvMain'), /Rematch/);
  assert.ok(await page.locator('#duelOvRounds li').count() >= 2);
  assert.ok(await visible(page, '#duelOvFinal'));
  assert.equal(await page.locator('#duelOvStats > div').count(), 3);
  await page.waitForTimeout(1300);                               // after the entrance animation
  await shot(page, 'duel-results');
  const stats = await page.evaluate(() => JSON.parse(localStorage.getItem('gridsnake-duel-stats-v1')));
  assert.equal(stats.played, 1);
  assert.equal(stats.won + stats.lost + stats.drawn, 1);
  assert.equal(await page.evaluate(() => localStorage.getItem('gridsnake-profile-v2')), profileBefore, 'the game profile is untouched');
  await page.click('#duelOvMain');                                // rematch
  await page.waitForFunction(() => __t.duel().round && __t.duel().round.state.phase === 'running' && __t.duel().match.state.rounds.length === 0);
  await page.keyboard.press('Escape');                            // pause
  await page.click('#duelOvSec');                                 // leave: back to the duel menu
  assert.ok(await visible(page, '#duelMenu'));
  assert.match(await page.textContent('#duelStatList'), /Matches1/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phones: the board fits the screen, turn buttons are shown, swipes steer and the page does not scroll sideways', async () => {
  for (const w of [320, 375, 430]) {
    const { ctx, page, errors } = await open({ viewport: { width: w, height: 760 }, isMobile: true, hasTouch: true });
    await page.tap('#duelEntry');
    const menuOk = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.ok(menuOk, w + ': menu fits');
    if (w === 375) await shot(page, 'duel-menu-phone');
    await page.tap('#duelStart');
    await page.waitForFunction(() => __t.duel().round && __t.duel().round.state.phase === 'running');
    const box = await page.evaluate(() => {
      const b = document.getElementById('duelBoard').getBoundingClientRect(), t = document.getElementById('duelTurnLeft').getBoundingClientRect();
      return { w: b.width, right: b.right, bottom: b.bottom, turnTop: t.top, turnH: t.height, sw: document.documentElement.scrollWidth, iw: window.innerWidth };
    });
    assert.ok(box.sw <= box.iw, w + ': no sideways scroll');
    assert.ok(box.right <= box.iw + 0.5 && box.w >= 240, w + ': board width ' + box.w);
    assert.ok(box.turnH >= 56, w + ': turn buttons are big');
    assert.ok(await visible(page, '#duelTurnLeft'));
    const d0 = await duel(page, () => __t.duel().round.state.snakes[0].dir);
    await page.tap('#duelTurnRight');
    await page.waitForFunction(d => { const s = __t.duel().round.state.snakes[0].dir; return s.x !== d.x || s.y !== d.y || __t.duel().round.state.phase !== 'running'; }, d0);
    if (w === 375) await shot(page, 'duel-play-phone');
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

test('the original game still starts and plays after visiting the Duel', async () => {
  const { ctx, page, errors } = await open();
  await page.click('#duelEntry');
  await page.click('#duelStart');
  await page.waitForFunction(() => __t.duel().round && __t.duel().round.state.phase === 'running');
  await page.keyboard.press('Escape');
  await page.click('#duelOvSec');
  await page.click('#duelBack');
  await page.click('#playBtn');
  await page.waitForFunction(() => __t.game().state.phase === 'running');
  assert.equal(await page.evaluate(() => __t.view()), 'game');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => __t.game().state.dir.y === 1);
  assert.equal(await page.evaluate(() => __t.duel().round), null, 'no duel runs in the background');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Android app (www/): Back pauses a duel, resumes it, leaves for the duel menu, then the game menu', async () => {
  const file = path.join(ROOT, 'android-app', 'www', 'index.html');
  let src = fs.readFileSync(file, 'utf8');
  src = src.replace('/*TEST_HOOK*/', 'window.__t = { duel: function () { return DD; }, view: function () { return view; } };');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); localStorage.setItem('gridsnake-profile-v2', JSON.stringify({ name: 'T' })); } catch (e) {} }, [KEY, JSON.stringify({ name: 'Waseem', secret: SECRET })]);
  await page.route('**/rest/v1/rpc/**', defaultBoard().route);
  await page.route(ORIGIN + '/**', r => r.request().url().endsWith('/index.html') ? r.fulfill({ contentType: 'text/html', body: src }) : r.fulfill({ status: 404, body: '' }));
  await page.goto(ORIGIN + '/index.html');
  await page.waitForFunction(() => !document.getElementById('playBtn').disabled);
  await page.tap('#duelEntry');
  await page.tap('#duelStart');
  await page.waitForFunction(() => __t.duel().round && __t.duel().round.state.phase === 'running', null, { timeout: 10000 });
  assert.equal(await page.evaluate(() => window.__androidBack()), true);
  assert.equal(await page.evaluate(() => __t.duel().round.state.phase), 'paused');
  assert.equal(await page.evaluate(() => window.__androidBack()), true);
  assert.equal(await page.evaluate(() => __t.duel().round.state.phase), 'running');
  await page.evaluate(() => window.__androidBack());
  await page.tap('#duelOvSec');
  assert.equal(await page.evaluate(() => __t.view()), 'duel');
  assert.equal(await page.evaluate(() => window.__androidBack()), true);
  assert.equal(await page.evaluate(() => __t.view()), 'home');
  assert.equal(await page.evaluate(() => window.__androidBack()), false, 'on the game menu Back lets the app minimise');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('each of the five events in the page: announced with a banner, shown in the event strip, drawn on the board', async () => {
  for (const ev of ['vanish', 'portal', 'laser', 'walls', 'core']) {
    const { ctx, page, errors } = await open(null, null, ev);
    await page.click('#duelEntry');
    await page.click('#duelStart');
    await page.waitForFunction(() => __t.duel().round && __t.duel().round.state.phase === 'running');
    // a steady AI drives the player so the round lasts; this only replaces the key presses
    await page.evaluate(() => { const ai = SnakeDuelAI.create('hard', 7); __t.duel().human.next = (r, i) => ai.next(r, i); });
    await page.waitForFunction(() => { const r = __t.duel().round; return !r || r.state.phase !== 'running' || r.state.eventPhase === 'announce' || r.state.eventPhase === 'live'; }, null, { timeout: 10000 });
    const bannerSeen = await page.evaluate(() => !document.getElementById('duelBanner').hidden);
    await page.waitForFunction(() => { const r = __t.duel().round; return !r || r.state.phase !== 'running' || r.state.eventPhase === 'live'; }, null, { timeout: 10000 });
    const live = await page.evaluate(() => { const r = __t.duel().round; return r && r.state.eventPhase === 'live'; });
    if (live) {
      // let the event build up in game time (ticked directly, as the frame loop would), then let one frame draw it
      await page.evaluate(() => { const r = __t.duel().round; for (let i = 0; i < 60 && r.state.phase === 'running'; i++) r.tick(); });
      await page.waitForTimeout(150);
      const strip = await page.evaluate(() => ({ ev: document.getElementById('duelEvent').getAttribute('data-event'), live: document.getElementById('duelEvent').classList.contains('live'), name: document.getElementById('duelEventName').textContent, status: document.getElementById('duelEventStatus').textContent }));
      assert.equal(strip.ev, ev);
      assert.ok(strip.name.length > 3 && strip.status.length > 3, ev + ' strip text');
      await shot(page, 'event-' + ev);
    }
    assert.ok(bannerSeen || !live, ev + ': the event banner was shown');
    assert.deepEqual(errors, [], ev);
    await ctx.close();
  }
});

test('reduced motion: a match still plays to the results with no particles, and the overlays still show', async () => {
  const ctx0 = { reducedMotion: 'reduce' };
  const { ctx, page, errors } = await open(ctx0);
  await page.click('#duelEntry');
  await page.click('#duelStart');
  await page.waitForFunction(() => __t.duel().round && __t.duel().round.state.phase === 'running');
  await page.evaluate(() => { const ai = SnakeDuelAI.create('medium', 3); __t.duel().human.next = (r, i) => ai.next(r, i); });
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => __t.duel().fx.parts.length), 0, 'no particles with reduced motion');
  await page.waitForFunction(() => __t.duel().flow === 'results', null, { timeout: 40000 });
  assert.ok(await visible(page, '#duelOvMain'));
  assert.deepEqual(errors, []);
  await ctx.close();
});
