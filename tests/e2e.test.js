'use strict';
/* Browser tests (real Chromium through Playwright).
 * Run: node build.js && NODE_PATH=$(npm root -g) E2E_OUT=<folder for screenshots> node --test tests/e2e.test.js
 * The page is loaded from grid-snake.html with two test-only changes made in memory:
 *  - a hook that exposes the running game (the shipped file only contains a comment there)
 *  - shorter Time Attack and Survival level timers, so real-time tests stay quick
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'snake-e2e-'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FAST_TA = ['duration: 60000,', 'duration: 3000,'];
const FAST_SURVIVAL = ['levelMs: 20000,', 'levelMs: 800,'];

const INSTR = `(() => {
  const orig = window.requestAnimationFrame.bind(window);
  window.__raf = { pending: 0, max: 0, setIntervals: 0 };
  window.requestAnimationFrame = cb => { __raf.pending++; __raf.max = Math.max(__raf.max, __raf.pending); return orig(t => { __raf.pending--; cb(t); }); };
  const si = window.setInterval.bind(window);
  window.setInterval = (...a) => { __raf.setIntervals++; return si(...a); };
})();`;

let browser, counter = 0;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

function pageHtml(tweaks) {
  let src = fs.readFileSync(path.join(ROOT, 'grid-snake.html'), 'utf8');
  (tweaks || []).forEach(([a, b]) => {
    assert.equal(src.split(a).length, 2, 'tweak target must occur once: ' + a);
    src = src.replace(a, b);
  });
  assert.ok(src.includes('/*TEST_HOOK*/'));
  src = src.replace('/*TEST_HOOK*/', 'window.__t = { fx: function () { return FX; }, game: function () { return game; }, tracker: function () { return tracker; }, profile: profile };');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<style>:root{color-scheme:light}body{margin:0}</style></head><body>' + src + '</body></html>';
}

/* Saved data to start with. Seeded once per tab, so a reload keeps whatever the game saved. */
function seed(over) {
  return { 'gridsnake-profile-v2': JSON.stringify(Object.assign({ name: 'Tester', prefs: { mode: 'classic', edge: 'wrap' } }, over || {})) };
}

async function open(opts) {
  opts = opts || {};
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 800 } }, opts.context || {}));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.addInitScript(INSTR);
  if (opts.init) await page.addInitScript(opts.init);
  const storage = opts.storage === undefined ? seed() : opts.storage;
  const file = path.join(OUT, 'page-' + (++counter) + '.html');
  fs.writeFileSync(file, pageHtml(opts.tweaks));
  await page.goto('file://' + file);
  if (storage) {
    /* seed once, then reload so the game boots with it; later reloads keep what the game saved */
    await page.evaluate(s => Object.keys(s).forEach(k => localStorage.setItem(k, s[k])), storage);
    await page.reload();
  }
  await page.waitForFunction(() => !document.getElementById('playBtn').disabled);
  return { ctx, page, errors };
}

const text = (page, sel) => page.evaluate(s => document.querySelector(s).textContent.trim(), sel);
const shown = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none'; }, sel);
const st = page => page.evaluate(() => {
  const s = __t.game().state;
  return {
    mode: s.mode, edge: s.edge, phase: s.phase, reason: s.reason, score: s.score, foods: s.foods, level: s.level,
    dir: s.dir, queue: s.queue, head: s.snake[0], len: s.snake.length, obstacles: s.obstacles.length,
    pickup: s.pickup && s.pickup.type, effect: s.effect && s.effect.type, shield: s.shield,
    timeLeft: s.timeLeft, elapsed: s.elapsed
  };
});
const waitState = (page, fn, arg, timeout) => page.waitForFunction(fn, arg, { timeout: timeout || 8000 });
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png') });

async function select(page, modeId) { await page.click('.mode[data-mode="' + modeId + '"]'); }
async function play(page) { await page.click('#playBtn'); await waitState(page, () => __t.game().state.phase === 'running'); }

/* Put a food directly in front of the head; the next step eats it. Keeps the snake short in wrap mode. */
async function eatOne(page) {
  const before = (await st(page)).foods;
  await page.evaluate(() => {
    const s = __t.game().state, h = s.snake[0], d = s.dir;
    s.food = { x: (h.x + d.x + 20) % 20, y: (h.y + d.y + 20) % 20 };
  });
  await waitState(page, n => __t.game().state.foods > n, before);
  await page.evaluate(() => { const s = __t.game().state; if (s.snake.length > 8) s.snake = s.snake.slice(0, 8); });
}
async function putAhead(page, kind, n) {          // a pick-up n cells ahead of the head
  await page.evaluate(([k, n]) => {
    const s = __t.game().state, h = s.snake[0], d = s.dir;
    s.pickup = { type: k, x: (h.x + d.x * n + 20) % 20, y: (h.y + d.y * n + 20) % 20, ttl: 8000, life: 8000 };
  }, [kind, n || 2]);
}
async function putAt(page, kind, x, y) {
  await page.evaluate(([k, x, y]) => { __t.game().state.pickup = { type: k, x, y, ttl: 8000, life: 8000 }; }, [kind, x, y]);
}
const pixel = (page, cx, cy) => page.evaluate(([x, y]) => {
  const cv = document.getElementById('board'), g = cv.getContext('2d'), k = cv.width / 20;
  const d = g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data;
  return [d[0], d[1], d[2]];
}, [cx, cy]);
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= (tol || 22));
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
async function noOverflow(page) { return (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0; }
async function finish(ctx, errors) { assert.deepEqual(errors, [], 'no console or page errors'); await ctx.close(); }

/* =====================================================================
   Start-up, saved choices, and Classic
   ===================================================================== */

test('E2E boot: a first-time visitor gets Classic, a working Play button, four modes, and no setInterval', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ storage: null });
  assert.equal(await page.locator('.mode').count(), 4);
  assert.equal(await page.locator('.mode[aria-pressed="true"]').getAttribute('data-mode'), 'classic');
  assert.equal(await text(page, '#playBtn'), 'Play');
  assert.equal(await text(page, '#homeAchCount'), '0/61');
  assert.equal(await text(page, '#homeEdge'), 'Walls');
  assert.equal(await page.evaluate(() => window.__raf.setIntervals), 0);
  await shot(page, '01-home-desktop');
  await finish(ctx, errors);
});

test('E2E saved data: an older Classic best score is still shown, and mode and edge choices survive a reload', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ storage: { 'gridsnake-best-walls': '14', 'gridsnake-profile-v2': JSON.stringify({ name: 'Tester' }) } });
  assert.equal(await text(page, '#homeBest'), '14');
  await select(page, 'survival');
  assert.equal(await page.locator('.mode[aria-pressed="true"]').getAttribute('data-mode'), 'survival');
  await page.click('#homeSettingsBtn');
  await page.click('#modeWrap');
  assert.equal(await text(page, '#homeEdge'), 'Wrap');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.getElementById('settings').open), false);
  const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('gridsnake-profile-v2')));
  assert.deepEqual(saved.prefs, { mode: 'survival', edge: 'wrap', skin: 'emerald', style: 'realistic', board: 'midnight', food: 'dot', golden: false, sound: true, volume: 1, haptics: true, motion: 'auto', difficulty: 'auto', controls: 'auto' });
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('playBtn').disabled);
  assert.equal(await page.locator('.mode[aria-pressed="true"]').getAttribute('data-mode'), 'survival');
  assert.equal(await text(page, '#homeEdge'), 'Wrap');
  await finish(ctx, errors);
});

test('E2E Classic: no clock, no effects row, no pick-up guide; level and speed show', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  await play(page);
  assert.equal(await shown(page, '#strip'), false);
  assert.equal(await shown(page, '#effects'), false);
  assert.equal(await shown(page, '#legend'), false);
  assert.equal(await text(page, '#modeTag'), 'Classic');
  assert.equal(await text(page, '#level'), '1');
  assert.equal(await text(page, '#speed'), '6.7');
  await eatOne(page);
  assert.equal(await text(page, '#score'), '1');
  assert.equal(await text(page, '#speed'), '6.8');
  for (let i = 0; i < 4; i++) await eatOne(page);
  assert.equal(await text(page, '#level'), '2', 'level 2 after 5 foods');
  assert.equal((await st(page)).pickup, null, 'Classic never gets pick-ups');
  await finish(ctx, errors);
});

test('E2E controls: Play, Pause, Resume, Space, Restart, Menu all work', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  await play(page);
  await page.click('#pauseBtn');
  assert.equal(await text(page, '#ovTitle'), 'Paused');
  assert.equal(await text(page, '#pauseBtn'), 'Resume');
  const h0 = (await st(page)).head;
  await sleep(500);
  assert.deepEqual((await st(page)).head, h0, 'frozen while paused');
  await shot(page, '02-paused');
  await page.click('#pauseBtn');
  assert.equal((await st(page)).phase, 'running');
  assert.equal(await shown(page, '#overlay'), false);

  await page.keyboard.press('Space');
  assert.equal((await st(page)).phase, 'paused');
  await page.keyboard.press('Space');
  assert.equal((await st(page)).phase, 'running');

  await page.click('#pauseBtn');
  await page.click('#ovBtn');
  assert.equal((await st(page)).phase, 'running', 'overlay Resume');

  await eatOne(page);
  await page.click('#restartBtn');
  const s = await st(page);
  assert.equal(s.phase, 'ready');
  assert.equal(s.score, 0);
  assert.equal(await text(page, '#ovTitle'), 'Ready');
  await page.keyboard.press('ArrowUp');
  assert.equal((await st(page)).phase, 'running', 'an arrow key starts the run');

  await page.click('#menuBtn');
  assert.equal(await shown(page, '#home'), true);
  assert.equal(await shown(page, '#game'), false);
  await play(page);
  assert.equal((await st(page)).score, 0, 'a fresh run after the menu');
  await finish(ctx, errors);
});

test('E2E steering: reversals and repeats are ignored, quick turns queue, WASD works, walls end the run', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'classic', edge: 'walls' } }) });
  await play(page);
  await page.evaluate(() => { __t.game().state.acc = -1e9; });       // hold the snake still while queueing keys
  await page.keyboard.press('ArrowLeft');
  assert.equal((await st(page)).queue.length, 0, 'direct reversal ignored');
  await page.keyboard.press('ArrowRight');
  assert.equal((await st(page)).queue.length, 0, 'same direction ignored');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  assert.deepEqual((await st(page)).queue, [{ x: 0, y: -1 }], 'up then down: the reversal is dropped');
  await page.keyboard.press('a');
  assert.equal((await st(page)).queue.length, 2, 'A (left) after up is a valid turn');
  await page.keyboard.press('s');
  assert.equal((await st(page)).queue.length, 2, 'queue holds at most two turns');
  await page.evaluate(() => { __t.game().state.acc = 0; });
  await sleep(700);
  assert.equal((await st(page)).phase, 'running', 'the quick up-then-left turn did not kill the snake');

  await page.click('#restartBtn');
  await page.keyboard.press('ArrowLeft');
  assert.equal((await st(page)).phase, 'ready', 'a reversal does not start the run');
  await page.keyboard.press('ArrowRight');
  assert.equal((await st(page)).phase, 'running', 'the arrow the snake already faces starts the run');
  await page.evaluate(() => { __t.game().state.food = { x: 0, y: 0 }; });   // keep the random food out of the way of the straight run
  await waitState(page, () => __t.game().state.phase === 'over');
  const s = await st(page);
  assert.equal(s.reason, 'wall');
  assert.equal(await text(page, '#ovTitle'), 'Game over');
  assert.equal(await text(page, '#ovText'), 'You hit the wall.');
  assert.match(await text(page, '#ovStats'), /Score 0/);
  await shot(page, '03-gameover');
  await page.click('#ovBtn');
  assert.equal((await st(page)).phase, 'running');
  assert.equal((await st(page)).score, 0);
  await finish(ctx, errors);
});

test('E2E restart keeps permanent stats: best score, totals and unlocks stay, the run resets', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  await play(page);
  for (let i = 0; i < 3; i++) await eatOne(page);
  const before = await page.evaluate(() => localStorage.getItem('gridsnake-profile-v2') + '|' + localStorage.getItem('gridsnake-best-wrap'));
  assert.equal(await text(page, '#best'), '3');
  await page.click('#restartBtn');
  assert.equal(await text(page, '#score'), '0');
  assert.equal(await text(page, '#best'), '3', 'best score is still shown');
  assert.equal(await text(page, '#level'), '1');
  const after = await page.evaluate(() => localStorage.getItem('gridsnake-profile-v2') + '|' + localStorage.getItem('gridsnake-best-wrap'));
  assert.equal(after, before);
  assert.equal(await page.evaluate(() => __t.profile.getTotals().foods), 3);
  await finish(ctx, errors);
});

/* =====================================================================
   Time Attack
   ===================================================================== */

test('E2E Time Attack: the countdown shows, pausing stops it, and the run ends at zero', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ tweaks: [FAST_TA], storage: seed({ prefs: { mode: 'timeattack', edge: 'wrap', controls: 'arrows', difficulty: 'hard' } }) });
  await select(page, 'timeattack');
  const t0 = Date.now();
  await play(page);
  assert.equal(await shown(page, '#strip'), true);
  assert.equal(await text(page, '#stripL'), 'Time left');
  assert.match(await text(page, '#stripR'), /^0:0[23]$/);
  assert.equal(await shown(page, '#legend'), true, 'pick-up guide is shown on desktop');
  assert.equal(await shown(page, '#effects'), true);
  assert.equal(await text(page, '#chipIdle'), 'No active effects');

  await sleep(900);
  await page.click('#pauseBtn');
  const left = (await st(page)).timeLeft;
  await sleep(800);
  assert.equal((await st(page)).timeLeft, left, 'the clock does not run while paused');
  await page.click('#pauseBtn');

  await waitState(page, () => __t.game().state.phase === 'over');
  const real = Date.now() - t0;
  const s = await st(page);
  assert.equal(s.reason, 'time');
  assert.equal(s.timeLeft, 0);
  assert.ok(real >= 3500 && real < 6500, 'about 3 s of play plus 0.8 s paused, got ' + real);
  assert.equal(await text(page, '#ovTitle'), "Time's up");
  assert.equal(await text(page, '#ovText'), 'The clock ran out.');
  assert.match(await text(page, '#ovStats'), /Time 0:03/);
  await shot(page, '04-timeattack-over');

  await page.click('#ovBtn');
  assert.equal((await st(page)).phase, 'running');
  assert.ok((await st(page)).timeLeft > 2500, 'a new run gets a full clock');
  await finish(ctx, errors);
});

test('E2E Time Attack: a crash ends the run before the clock does', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'timeattack', edge: 'walls' } }) });
  await play(page);
  await waitState(page, () => __t.game().state.phase === 'over');
  assert.equal((await st(page)).reason, 'wall');
  assert.equal(await text(page, '#ovTitle'), 'Game over');
  assert.ok((await st(page)).timeLeft > 50000);
  await finish(ctx, errors);
});

/* =====================================================================
   Power-ups, drawn and collected
   ===================================================================== */

test('E2E pick-ups: each type has its own colour and shape on the board', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'timeattack', edge: 'wrap', controls: 'arrows', difficulty: 'hard' } }) });
  await play(page);
  const want = { boost: '#5AA9F2', slow: '#A58BFA', bonus: '#FFD98A', shield: '#4FD6E3' };
  for (const k of Object.keys(want)) {
    await page.click('#pauseBtn');
    await putAt(page, k, 3, 3);
    await sleep(420);                              // the pick-up grows in for about a quarter of a second
    assert.ok(near(await pixel(page, 3.5, 3.5), hex(want[k])), k + ' glyph colour at the cell centre: ' + (await pixel(page, 3.5, 3.5)));
    assert.ok(near(await pixel(page, 3.14, 3.5), hex('#222826'), 14), k + ' sits on a dark tile');
    await page.click('#pauseBtn');
    await sleep(60);
  }
  await page.click('#pauseBtn');
  await putAt(page, 'bonus', 3, 3);
  await sleep(420);
  await shot(page, '05-pickup-board');
  await finish(ctx, errors);
});

test('E2E pick-ups: Speed Boost, Slow Motion, Bonus Food and Shield apply, show on screen, and end', { timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'timeattack', edge: 'wrap', controls: 'arrows', difficulty: 'hard' } }) });
  await play(page);
  await page.evaluate(() => { __t.game().state.timeLeft = 1e9; __t.game().state.food = { x: 0, y: 0 }; });
  const normal = parseFloat(await text(page, '#speed'));

  await putAhead(page, 'boost', 2);
  await waitState(page, () => __t.game().state.effect && __t.game().state.effect.type === 'boost');
  assert.match(await text(page, '#chipSpeed'), /^Speed Boost \d\.\d s$/);
  assert.ok(parseFloat(await text(page, '#speed')) > normal, 'faster while boosted');
  assert.equal(await shown(page, '#chipIdle'), false);
  await shot(page, '06-boost');

  await putAhead(page, 'slow', 2);
  await waitState(page, () => __t.game().state.effect && __t.game().state.effect.type === 'slow');
  assert.match(await text(page, '#chipSpeed'), /^Slow Motion/);
  assert.ok(parseFloat(await text(page, '#speed')) < normal, 'slower in slow motion');

  const sc = (await st(page)).score;
  await putAhead(page, 'bonus', 2);
  await waitState(page, n => __t.game().state.score >= n + 5, sc);
  assert.match(await page.evaluate(() => document.getElementById('toasts').textContent), /\+5 bonus points/);

  await putAhead(page, 'shield', 2);
  await waitState(page, () => __t.game().state.shield === true);
  assert.equal(await text(page, '#chipShield'), 'Shield ready');
  await page.click('#pauseBtn');
  await page.evaluate(() => {      // centre the snake so the ring sample is inside the board and clear of the body
    const s = __t.game().state;
    s.snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }]; s.dir = { x: 1, y: 0 };
  });
  await sleep(100);
  assert.ok(near(await pixel(page, 10.5, 10.5 - 0.58), hex('#4FD6E3'), 45), 'a ring is drawn around the head: ' + (await pixel(page, 10.5, 9.92)));
  await page.click('#pauseBtn');

  await page.evaluate(() => { __t.game().state.effect.remaining = 150; });
  await waitState(page, () => !__t.game().state.effect);
  assert.equal(await shown(page, '#chipSpeed'), false);
  assert.equal(await shown(page, '#chipShield'), true, 'the shield stays until used');
  await finish(ctx, errors);
});

test('E2E shield: absorbs one wall hit and the run goes on; the next hit ends it', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'timeattack', edge: 'walls' } }) });
  await play(page);
  await page.evaluate(() => {
    const s = __t.game().state;
    s.timeLeft = 1e9; s.shield = true; s.food = { x: 5, y: 5 };
    s.snake = [{ x: 18, y: 10 }, { x: 17, y: 10 }, { x: 16, y: 10 }, { x: 15, y: 10 }];
  });
  await waitState(page, () => __t.game().state.shieldSaves === 1);
  const s = await st(page);
  assert.equal(s.phase, 'running');
  assert.equal(s.shield, false);
  assert.ok(s.head.x < 5, 'wrapped to the far side');
  assert.match(await page.evaluate(() => document.getElementById('toasts').textContent), /Shield used/);
  assert.equal(await shown(page, '#chipShield'), false);
  await page.evaluate(() => { const s = __t.game().state; s.snake = [{ x: 18, y: 4 }, { x: 17, y: 4 }, { x: 16, y: 4 }, { x: 15, y: 4 }]; });
  await waitState(page, () => __t.game().state.phase === 'over');
  assert.equal((await st(page)).reason, 'wall');
  await finish(ctx, errors);
});

/* =====================================================================
   Survival
   ===================================================================== */

test('E2E Survival: levels rise with time, obstacles appear and are drawn, speed grows', { timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open({ tweaks: [FAST_SURVIVAL], storage: seed({ prefs: { mode: 'survival', edge: 'wrap' } }) });
  await select(page, 'survival');
  let reached = false;
  for (let attempt = 0; attempt < 5 && !reached; attempt++) {
    if (attempt === 0) await play(page); else { await page.click('#restartBtn'); await page.keyboard.press('ArrowRight'); }
    assert.match(await text(page, '#stripL'), /^Survived 0:0\d$/);
    assert.match(await text(page, '#stripR'), /^Level \d in \d s$/);
    reached = await page.waitForFunction(() => __t.game().state.level >= 4 || __t.game().state.phase === 'over', null, { timeout: 8000 })
      .then(() => page.evaluate(() => __t.game().state.level >= 4));
  }
  assert.ok(reached, 'reached level 4 within a few attempts');
  const s = await st(page);
  assert.equal(s.obstacles, s.level - 1, 'one obstacle per level gained');
  assert.ok(parseFloat(await text(page, '#speed')) > 7.1, 'faster than the start');
  const o = await page.evaluate(() => __t.game().state.obstacles[0]);
  assert.ok(near(await pixel(page, o.x + 0.15, o.y + 0.5), hex('#4A5450'), 30), 'obstacle drawn in its own colour: ' + (await pixel(page, o.x + 0.15, o.y + 0.5)));
  assert.match(await page.evaluate(() => document.getElementById('toasts').textContent), /Level \d|new obstacle/);
  await shot(page, '07-survival');
  await finish(ctx, errors);
});

test('E2E Survival: an obstacle ends the run, unless a Shield smashes it', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'survival', edge: 'wrap' } }) });
  await play(page);
  await page.evaluate(() => { const s = __t.game().state; s.food = { x: 0, y: 0 }; s.shield = true; s.obstacles = [{ x: 12, y: 10 }]; });
  await waitState(page, () => __t.game().state.shieldSaves === 1);
  let s = await st(page);
  assert.equal(s.phase, 'running');
  assert.equal(s.obstacles, 0, 'smashed');
  assert.match(await page.evaluate(() => document.getElementById('toasts').textContent), /smashed the obstacle/);
  await page.evaluate(() => { const s = __t.game().state; s.obstacles = [{ x: (s.snake[0].x + 3) % 20, y: s.snake[0].y }]; });
  await waitState(page, () => __t.game().state.phase === 'over');
  s = await st(page);
  assert.equal(s.reason, 'obstacle');
  assert.equal(await text(page, '#ovText'), 'You hit an obstacle.');
  await finish(ctx, errors);
});

/* =====================================================================
   Achievements
   ===================================================================== */

test('E2E achievements: tiers pay once with a message, show progress, restart from zero, and survive a reload', { timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open();
  await play(page);
  await page.evaluate(() => {
    window.__toasts = [];
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => window.__toasts.push(n.textContent)))).observe(document.getElementById('toasts'), { childList: true });
  });
  for (let i = 0; i < 10; i++) await eatOne(page);
  await waitState(page, () => __t.profile.getAch('score').tier >= 1);
  assert.ok((await page.evaluate(() => window.__toasts)).some(t => /Achievement unlocked.*High Roller 1\/5.*\+15 coins/.test(t)));
  await shot(page, '08-achievement-toast');
  assert.equal((await page.evaluate(() => window.__toasts)).filter(t => /High Roller/.test(t)).length, 1, 'announced once');
  assert.deepEqual(await page.evaluate(() => __t.profile.getAch('apples')), { tier: 0, progress: 10 });

  await page.click('#menuBtn');
  assert.equal(await text(page, '#homeAchCount'), '2/61');
  await page.click('#homeAchBtn');
  assert.equal(await page.evaluate(() => document.getElementById('achDialog').open), true);
  assert.match(await text(page, '#achSummary'), /^2 of 61 tiers complete/);
  const apples = page.locator('.ach[data-id="apples"]');
  assert.match(await apples.locator('.ach-state').textContent(), /10 \/ 25/);
  assert.match(await apples.textContent(), /Tier 1 of 6/);
  const score = page.locator('.ach[data-id="score"]');
  assert.match(await score.textContent(), /Tier 2 of 5/);
  assert.match(await score.locator('.ach-state').textContent(), /\/ 25/, 'the next goal is 25');
  await shot(page, '09-achievements');
  await page.keyboard.press('Escape');

  await page.reload();
  await page.waitForFunction(() => !document.getElementById('playBtn').disabled);
  assert.equal(await text(page, '#homeAchCount'), '2/61');
  await play(page);
  await page.evaluate(() => {
    window.__toasts = [];
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => window.__toasts.push(n.textContent)))).observe(document.getElementById('toasts'), { childList: true });
  });
  for (let i = 0; i < 15; i++) await eatOne(page);
  await waitState(page, () => __t.profile.getAch('apples').tier >= 1);
  const toasts = await page.evaluate(() => window.__toasts);
  assert.equal(toasts.filter(t => /High Roller 1/.test(t)).length, 0, 'no repeat after reload');
  assert.ok(toasts.some(t => /Apple Eater 1\/6/.test(t)), 'the 25-food tier paid');
  assert.deepEqual(await page.evaluate(() => __t.profile.getAch('apples')), { tier: 1, progress: 0 }, 'and the 100-food tier starts from zero');
  await finish(ctx, errors);
});

test('E2E achievements: the game-over screen lists the tiers finished in that run, with coins', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'classic', edge: 'walls' } }) });
  await play(page);
  await page.evaluate(() => { __t.game().state.score = 12; });
  await page.evaluate(() => { const s = __t.game().state; s.snake = [{ x: 19, y: 10 }, { x: 18, y: 10 }, { x: 17, y: 10 }]; s.goldSegs = [false, false, false]; s.dir = { x: 1, y: 0 }; s.queue = []; s.food = { x: 0, y: 0 }; });
  await waitState(page, () => __t.game().state.phase === 'over');
  assert.equal(await shown(page, '#ovAch'), true);
  assert.match(await text(page, '#ovAch'), /High Roller 1\/5 \(\+15\)/);
  assert.equal(await shown(page, '#ovBest'), true, 'new best pill');
  await shot(page, '10-gameover-ach');
  await page.click('#ovBtn');
  await page.evaluate(() => { __t.game().state.score = 12; });
  await page.evaluate(() => { const s = __t.game().state; s.snake = [{ x: 19, y: 10 }, { x: 18, y: 10 }, { x: 17, y: 10 }]; s.goldSegs = [false, false, false]; s.dir = { x: 1, y: 0 }; s.queue = []; s.food = { x: 0, y: 0 }; });
  await waitState(page, () => __t.game().state.phase === 'over');
  assert.equal(await shown(page, '#ovAch'), false, 'nothing new the second time');
  await finish(ctx, errors);
});

/* =====================================================================
   Tab visibility, one loop, touch, layout, motion
   ===================================================================== */

test('E2E the game pauses when the tab goes to the background, and stays paused on return', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'timeattack', edge: 'wrap', controls: 'arrows', difficulty: 'hard' } }) });
  await play(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal((await st(page)).phase, 'paused');
  assert.equal(await text(page, '#ovTitle'), 'Paused');
  const left = (await st(page)).timeLeft;
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(500);
  const s = await st(page);
  assert.equal(s.phase, 'paused', 'does not resume by itself');
  assert.equal(s.timeLeft, left);
  await finish(ctx, errors);
});

test('E2E one animation loop only: restarting, switching modes and replaying never stacks loops or timers', { timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open();
  for (let i = 0; i < 4; i++) {
    await select(page, ['classic', 'timeattack', 'survival', 'classic'][i]);
    await play(page);
    await page.click('#restartBtn');
    await page.click('#ovBtn');
    await page.click('#pauseBtn');
    await page.click('#ovSec');
    await page.click('#menuBtn').catch(() => {});
    if (await shown(page, '#home') === false) await page.click('#menuBtn');
  }
  for (let i = 0; i < 5; i++) { await play(page); await page.click('#restartBtn'); await page.click('#menuBtn'); }
  const r = await page.evaluate(() => window.__raf);
  assert.equal(r.max, 1, 'never more than one frame request pending');
  assert.equal(r.setIntervals, 0);
  await finish(ctx, errors);
});

test('E2E touch: the direction pad and swipes steer, and the layout fits a phone in every mode', { timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open({
    context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    storage: seed({ prefs: { mode: 'timeattack', edge: 'wrap', controls: 'arrows', difficulty: 'hard' } })
  });
  assert.equal(await noOverflow(page), true, 'home fits');
  await shot(page, '11-home-mobile');
  await page.tap('#playBtn');
  await waitState(page, () => __t.game().state.phase === 'running');
  assert.equal(await shown(page, '.pad'), true);
  await page.evaluate(() => { __t.game().state.acc = -1e9; });
  await page.tap('.pad .up');
  assert.deepEqual((await st(page)).queue, [{ x: 0, y: -1 }]);
  await page.tap('.pad .left');
  assert.equal((await st(page)).queue.length, 2);
  await page.evaluate(() => { __t.game().state.acc = 0; });
  await sleep(500);
  assert.equal((await st(page)).phase, 'running');

  await page.evaluate(() => { const s = __t.game().state; s.queue = []; s.dir = { x: 1, y: 0 }; s.acc = -1e9; });
  await page.evaluate(() => {
    const el = document.getElementById('boardWrap'), r = el.getBoundingClientRect();
    const fire = (type, x, y) => {
      const t = new Touch({ identifier: 1, target: el, clientX: r.left + x, clientY: r.top + y });
      el.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
    };
    fire('touchstart', 150, 200); fire('touchmove', 150, 150); fire('touchend', 150, 150);
  });
  assert.deepEqual((await st(page)).queue, [{ x: 0, y: -1 }], 'swipe up');
  await page.evaluate(() => { __t.game().state.acc = 0; });

  await page.evaluate(() => { const s = __t.game().state; s.timeLeft = 1e9; s.shield = true; });
  await putAt(page, 'boost', 3, 3);
  await page.evaluate(() => { __t.game().state.effect = { type: 'boost', remaining: 4000, total: 5000 }; });
  await sleep(150);
  assert.equal(await noOverflow(page), true, 'Time Attack game fits with the clock, effects and guide');
  await shot(page, '12-timeattack-mobile');
  await page.tap('#menuBtn');
  await page.tap('#homeAchBtn');
  assert.equal(await noOverflow(page), true, 'achievements dialog fits');
  const w = await page.evaluate(() => document.getElementById('achDialog').getBoundingClientRect().width);
  assert.ok(w <= 390 - 32 + 1, 'dialog width ' + w);
  await shot(page, '13-achievements-mobile');
  await page.keyboard.press('Escape');
  await page.tap('.mode[data-mode="survival"]');
  await page.tap('#playBtn');
  await waitState(page, () => __t.game().state.phase === 'running');
  assert.equal(await noOverflow(page), true, 'Survival game fits');
  await finish(ctx, errors);
});

test('E2E reduced motion: no overlay or toast animation when the system asks for less motion', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ context: { reducedMotion: 'reduce' } });
  await play(page);
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('overlay')).animationName), 'none');
  await page.keyboard.press('Space');
  await page.evaluate(() => { __t.game().state.score = 9; });         // the next food reaches 10 points and pays a tier
  await eatOne(page);
  await waitState(page, () => document.querySelector('.toast'));
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.toast')).animationName), 'none');
  await finish(ctx, errors);
});

test('E2E snake colour: choice changes the look, is saved, and survives a reload', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open();
  await page.evaluate(() => document.querySelector('#look-skin .skin[data-id="ocean"]').click());
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), '#3C8FD9');
  assert.equal(await page.evaluate(() => document.querySelector('#look-skin .skin[data-id="ocean"]').getAttribute('aria-pressed')), 'true');
  assert.equal(await page.evaluate(() => __t.profile.getPrefs().skin), 'ocean');
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('playBtn').disabled);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), '#3C8FD9');
  await play(page);
  await waitState(page, () => __t.game().state.phase === 'running');
  await page.keyboard.press('Space');
  await waitState(page, () => __t.game().state.phase === 'paused');
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));   // let the board redraw
  const px = await page.evaluate(() => {
    const g = __t.game().state, cv = document.getElementById('board'), s = cv.width / __t.game().tuning.cols;
    const q = g.snake[Math.min(1, g.snake.length - 1)], c = cv.getContext('2d').getImageData((q.x + 0.5) * s, (q.y + 0.5) * s, 1, 1).data;
    return [c[0], c[1], c[2]];
  });
  assert.ok(px[2] > px[0] && px[2] > px[1], 'body is blue-ish: ' + px);
  await finish(ctx, errors);
});

test('E2E golden apples: setting is off by default, can be turned on, and the apple adds golden segments and score', { timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open();
  const pressed = id => page.evaluate(i => document.getElementById(i).getAttribute('aria-pressed'), id);
  assert.equal(await pressed('goldOff'), 'true');
  await page.evaluate(() => document.getElementById('goldOn').click());
  assert.equal(await pressed('goldOn'), 'true');
  assert.equal(await page.evaluate(() => __t.game().golden), true);
  await page.reload();                                           // saved
  await page.waitForFunction(() => !document.getElementById('playBtn').disabled);
  assert.equal(await pressed('goldOn'), 'true');
  await play(page);
  await waitState(page, () => __t.game().state.phase === 'running');
  // put the score just under 10 and eat once: the apple must appear
  await page.evaluate(() => { const s = __t.game().state, h = s.snake[0]; s.score = 9; s.food = { x: (h.x + s.dir.x + 20) % 20, y: (h.y + s.dir.y + 20) % 20 }; });
  await waitState(page, () => __t.game().state.gold !== null);
  // put the apple in front of the head and eat it
  const before = await page.evaluate(() => { const s = __t.game().state, h = s.snake[0]; s.food = { x: h.x, y: (h.y + 6) % 20 }; s.gold = { x: (h.x + s.dir.x + 20) % 20, y: (h.y + s.dir.y + 20) % 20 }; return { score: s.score, len: s.snake.length }; });
  await waitState(page, () => __t.game().state.goldEaten === 1);
  await waitState(page, () => __t.game().state.goldSegs.filter(Boolean).length === 5);
  const after = await page.evaluate(() => ({ score: __t.game().state.score, toast: !!document.querySelector('.toast') }));
  assert.equal(after.score, before.score + 5);
  assert.ok(after.toast, 'a message appears');
  // a golden body segment is really drawn in gold
  await page.keyboard.press('Space');
  await waitState(page, () => __t.game().state.phase === 'paused');
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const px = await page.evaluate(() => {
    const g = __t.game().state, cv = document.getElementById('board'), s = cv.width / __t.game().tuning.cols;
    const i = g.goldSegs.lastIndexOf(true), q = g.snake[i];
    const d = cv.getContext('2d').getImageData((q.x + 0.5) * s, (q.y + 0.5) * s, 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  assert.ok(px[0] > 200 && px[1] > 150 && px[2] < 120, 'gold-ish pixel: ' + px);
  // turning it off restarts the run and no apple is made
  await page.evaluate(() => { document.getElementById('settings').close && 0; });
  await page.evaluate(() => document.getElementById('goldOff').click());
  assert.equal(await page.evaluate(() => __t.game().golden), false);
  assert.equal(await page.evaluate(() => __t.game().state.gold), null);
  await finish(ctx, errors);
});

const AUDIO_STUB = `(() => {
  window.__audio = { contexts: 0, osc: 0, resumed: 0 };
  class G { constructor() { this.gain = { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }; } connect() {} }
  window.AudioContext = class {
    constructor() { __audio.contexts++; this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    resume() { __audio.resumed++; this.state = 'running'; return Promise.resolve(); }
    createGain() { return new G(); }
    createOscillator() { return { type: '', frequency: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, start() { __audio.osc++; }, stop() {} }; }
  };
})();`;

test('E2E sound: starts after the first tap, plays for eating, pick-ups and game over, and the Off setting silences it', { timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'timeattack', edge: 'wrap', controls: 'arrows', difficulty: 'hard' } }), init: AUDIO_STUB });
  const audio = () => page.evaluate(() => Object.assign({}, __audio));
  assert.equal((await audio()).contexts, 0, 'no audio before any tap');
  assert.equal(await page.evaluate(() => document.getElementById('soundOn').getAttribute('aria-pressed')), 'true', 'default is on');
  await play(page);
  assert.equal((await audio()).contexts, 1, 'created by the first tap');
  await waitState(page, () => __t.game().state.phase === 'running');
  await sleep(100);
  let n = (await audio()).osc;
  assert.ok(n > 0, 'start sound');
  await eatOne(page);
  assert.ok((await audio()).osc > n, 'eating plays a sound');
  n = (await audio()).osc;
  await page.evaluate(() => { const s = __t.game().state, h = s.snake[0]; s.pickup = { type: 'shield', x: (h.x + s.dir.x + 20) % 20, y: (h.y + s.dir.y + 20) % 20, ttl: 8000, life: 8000 }; });
  await waitState(page, () => __t.game().state.shield === true);
  assert.ok((await audio()).osc > n, 'pick-up sound');
  // turn sound off: eating stays silent
  await page.evaluate(() => document.getElementById('soundOff').click());
  assert.equal(await page.evaluate(() => __t.profile.getPrefs().sound), false);
  n = (await audio()).osc;
  await eatOne(page);
  await sleep(100);
  assert.equal((await audio()).osc, n, 'silent when off');
  await page.reload();                                         // saved
  await page.waitForFunction(() => !document.getElementById('playBtn').disabled);
  assert.equal(await page.evaluate(() => document.getElementById('soundOff').getAttribute('aria-pressed')), 'true');
  await finish(ctx, errors);
});

test('E2E golden apple: disappears after its 5 seconds, and golden points do not bring the next apple closer', { timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'classic', edge: 'wrap', golden: true } }) });
  await play(page);
  await waitState(page, () => __t.game().state.phase === 'running');
  assert.equal(await page.evaluate(() => __t.game().tuning.golden.lifetime), 5000);
  await page.evaluate(() => { const s = __t.game().state, h = s.snake[0]; s.score = 9; s.food = { x: (h.x + s.dir.x + 20) % 20, y: (h.y + s.dir.y + 20) % 20 }; });
  await waitState(page, () => __t.game().state.gold !== null);
  await page.evaluate(() => { __t.game().state.gold.ttl = 600; });   // shorten the wait for the test
  await waitState(page, () => __t.game().state.gold === null);
  assert.equal(await page.evaluate(() => __t.game().state.goldEaten), 0);
  // eat a golden apple at score 12: no new apple, because only 7 are normal points
  await page.evaluate(() => { const g = __t.game(), s = g.state, h = s.snake[0]; s.score = 7; s.goldNext = 10; s.gold = { x: (h.x + s.dir.x + 20) % 20, y: (h.y + s.dir.y + 20) % 20, ttl: 5000, life: 5000 }; });
  await waitState(page, () => __t.game().state.goldEaten === 1);
  await sleep(300);
  assert.equal(await page.evaluate(() => __t.game().state.gold), null);
  assert.equal(await page.evaluate(() => __t.game().state.score), 12);
  await finish(ctx, errors);
});

test('E2E looks: snake style, board theme and food look change the picture, are saved, and never touch the rules', { timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open();
  const click = (key, id) => page.evaluate(([k, i]) => document.querySelector('#look-' + k + ' .skin[data-id="' + i + '"]').click(), [key, id]);
  const pressed = (key, id) => page.evaluate(([k, i]) => document.querySelector('#look-' + k + ' .skin[data-id="' + i + '"]').getAttribute('aria-pressed'), [key, id]);
  for (const [k, n] of [['skin', 6], ['board', 4], ['food', 3]]) {
    assert.equal(await page.evaluate(k => document.querySelectorAll('#look-' + k + ' .skin').length, k), n, k + ' choices');
  }
  await click('board', 'forest'); await click('food', 'apple'); await click('skin', 'rose');
  assert.equal(await pressed('board', 'forest'), 'true');
  assert.equal(await pressed('board', 'midnight'), 'false');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()), '#0E1611');
  await page.reload();                                           // saved
  await page.waitForFunction(() => !document.getElementById('playBtn').disabled);
  assert.equal(await pressed('food', 'apple'), 'true');
  assert.equal(await pressed('skin', 'rose'), 'true');
  await play(page);
  await waitState(page, () => __t.game().state.phase === 'running');
  await page.keyboard.press('Space');
  await waitState(page, () => __t.game().state.phase === 'paused');
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const px = (cx, cy) => page.evaluate(([x, y]) => {
    const cv = document.getElementById('board'), s = cv.width / __t.game().tuning.cols;
    const d = cv.getContext('2d').getImageData(x * s, y * s, 1, 1).data; return [d[0], d[1], d[2]];
  }, [cx, cy]);
  assert.ok(near(await px(0.5, 0.5), hex('#13201A'), 6), 'board colour is the forest one');
  // the food is red-ish with the apple look
  const f = await page.evaluate(() => { const f = __t.game().state.food; return [f.x + 0.35, f.y + 0.55]; });
  const fp = await px(f[0], f[1]);
  assert.ok(fp[0] > 150 && fp[1] < 130, 'apple is red: ' + fp);
  // same rules: score for one food is still 1
  await page.keyboard.press('Space');
  await eatOne(page);
  assert.equal(await page.evaluate(() => __t.game().state.score), 1);
  await shot(page, '14-looks');
  await finish(ctx, errors);
});

test('E2E extras: floating points text when eating, confetti only on a new best, none with reduced motion', { timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'classic', edge: 'walls' } }) });
  await play(page);
  await waitState(page, () => __t.game().state.phase === 'running');
  await eatOne(page);
  assert.ok(await page.evaluate(() => __t.fx().texts.some(t => t.text === '+1')), 'a +1 floats up');
  await waitState(page, () => __t.fx().texts.length === 0);                   // and goes away again
  await page.evaluate(() => { const s = __t.game().state; s.snake = [{ x: 19, y: 10 }, { x: 18, y: 10 }, { x: 17, y: 10 }, { x: 16, y: 10 }]; s.dir = { x: 1, y: 0 }; s.queue = []; s.goldSegs = [false, false, false, false]; });
  await waitState(page, () => __t.game().state.phase === 'over');
  assert.ok(await page.evaluate(() => __t.fx().confetti.length > 0), 'new best: confetti');
  await page.click('#ovBtn');                                                  // next run: nothing scores, no new best
  await waitState(page, () => __t.game().state.phase === 'running');
  assert.equal(await page.evaluate(() => __t.fx().confetti.length), 0, 'cleared for the next run');
  await page.evaluate(() => { const s = __t.game().state; s.snake = [{ x: 19, y: 10 }, { x: 18, y: 10 }, { x: 17, y: 10 }, { x: 16, y: 10 }]; s.dir = { x: 1, y: 0 }; s.queue = []; s.goldSegs = [false, false, false, false]; });
  await waitState(page, () => __t.game().state.phase === 'over');
  assert.equal(await page.evaluate(() => __t.fx().confetti.length), 0, 'no new best: no confetti');
  await finish(ctx, errors);

  const r = await open({ context: { reducedMotion: 'reduce' } });
  await play(r.page);
  await waitState(r.page, () => __t.game().state.phase === 'running');
  await eatOne(r.page);
  assert.equal(await r.page.evaluate(() => __t.fx().texts.length), 0, 'no floating text with reduced motion');
  await finish(r.ctx, r.errors);
});

test('E2E realistic snake is the default look and draws a shaded body with a head, in the chosen colour', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'classic', edge: 'walls' } }) });
  assert.equal(await page.evaluate(() => document.getElementById('look-style')), null, 'no other snake styles to pick');
  await play(page);
  await waitState(page, () => __t.game().state.phase === 'running');
  await page.keyboard.press('Space');
  await waitState(page, () => __t.game().state.phase === 'paused');
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const px = (cx, cy) => page.evaluate(([x, y]) => {
    const cv = document.getElementById('board'), s = cv.width / __t.game().tuning.cols;
    const d = cv.getContext('2d').getImageData(Math.round(x * s), Math.round(y * s), 1, 1).data; return [d[0], d[1], d[2]];
  }, [cx, cy]);
  const sn = await page.evaluate(() => __t.game().state.snake.map(q => [q.x + 0.5, q.y + 0.5]));
  const mid = await px(sn[2][0], sn[2][1]);
  assert.ok(mid[1] > mid[0] && mid[1] > 50, 'green-ish body: ' + mid);                         // emerald skin
  // across the body the colour changes: dark edge, lighter middle (shading), not one flat colour
  const edgePx = await px(sn[2][0], sn[2][1] + 0.3), centre = await px(sn[2][0] + 0.3, sn[2][1]);
  assert.notDeepEqual(edgePx, centre, 'shaded, not flat');
  const head = await px(sn[0][0], sn[0][1]);
  assert.ok(head[1] > 80, 'head drawn: ' + head);
  await shot(page, '15-realistic');
  await finish(ctx, errors);
});

test('E2E death animation: a crash plays an animation (red tint, then the snake falls apart head first), the result fades in after it, and a new game clears it', { timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'classic', edge: 'walls' } }) });
  await play(page);
  await waitState(page, () => __t.game().state.phase === 'running');
  await page.evaluate(() => { const s = __t.game().state; s.snake = [{ x: 19, y: 10 }, { x: 18, y: 10 }, { x: 17, y: 10 }, { x: 16, y: 10 }]; s.goldSegs = [false, false, false, false]; s.dir = { x: 1, y: 0 }; s.queue = []; s.food = { x: 0, y: 0 }; });
  await waitState(page, () => __t.game().state.phase === 'over');
  assert.ok(await page.evaluate(() => __t.fx().death !== null), 'death animation started');
  assert.equal(await page.evaluate(() => document.getElementById('overlay').classList.contains('late')), true, 'the result waits for the animation');
  assert.equal(await text(page, '#ovTitle'), 'Game over');
  assert.equal(await page.evaluate(() => __t.fx().death.killed), 0, 'starts with a pause before breaking up');
  await waitState(page, () => __t.fx().death.killed === __t.fx().death.n);
  assert.ok(await page.evaluate(() => __t.fx().list.length > 0 || __t.fx().death.killed === 4));
  await shot(page, '16-death-done');
  await page.click('#ovBtn');
  assert.equal(await page.evaluate(() => __t.fx().death), null, 'cleared for the next run');
  assert.equal(await page.evaluate(() => document.getElementById('overlay').classList.contains('late')), false);
  await finish(ctx, errors);

  const r = await open({ storage: seed({ prefs: { mode: 'classic', edge: 'walls' } }), context: { reducedMotion: 'reduce' } });
  await play(r.page);
  await waitState(r.page, () => __t.game().state.phase === 'running');
  await r.page.evaluate(() => { const s = __t.game().state; s.snake = [{ x: 19, y: 10 }, { x: 18, y: 10 }, { x: 17, y: 10 }, { x: 16, y: 10 }]; s.goldSegs = [false, false, false, false]; s.dir = { x: 1, y: 0 }; s.queue = []; s.food = { x: 0, y: 0 }; });
  await waitState(r.page, () => __t.game().state.phase === 'over');
  assert.equal(await r.page.evaluate(() => __t.fx().death), null, 'no animation with reduced motion');
  assert.equal(await r.page.evaluate(() => document.getElementById('overlay').classList.contains('late')), false);
  await finish(r.ctx, r.errors);
});

test('E2E no death animation for running out of time', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ tweaks: [FAST_TA], storage: seed({ prefs: { mode: 'timeattack', edge: 'wrap', controls: 'arrows', difficulty: 'hard' } }) });
  await play(page);
  await waitState(page, () => __t.game().state.phase === 'over');
  assert.equal(await page.evaluate(() => __t.game().state.reason), 'time');
  assert.equal(await page.evaluate(() => __t.fx().death), null);
  await finish(ctx, errors);
});

/* =====================================================================
   Apple Run
   ===================================================================== */

test('E2E Apple Run: card, HUD, dash and item buttons, keys, and being caught', { timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'chase', edge: 'wrap' } }) });
  assert.equal(await text(page, '#homeAchCount'), '0/61');
  await play(page);
  assert.equal(await page.evaluate(() => __t.game().mode), 'chase');
  assert.equal(await page.evaluate(() => document.getElementById('chaseActions').hidden), false);
  assert.equal(await page.evaluate(() => document.getElementById('strip').hidden), false);
  assert.match(await text(page, '#stripL'), /^Survived/);
  assert.equal(await page.evaluate(() => document.getElementById('legend').hidden), false);
  // keys and buttons reach the engine
  await page.evaluate(() => { const s = __t.game().state; s.snake = [{ x: 0, y: 0 }, { x: 19, y: 0 }, { x: 18, y: 0 }, { x: 17, y: 0 }, { x: 16, y: 0 }]; s.pickup = null; });
  await page.keyboard.press('ArrowUp');
  assert.deepEqual(await page.evaluate(() => __t.game().state.appleDir), { x: 0, y: -1 });
  await page.keyboard.press('Shift');
  assert.ok(await page.evaluate(() => __t.game().state.dashLeft > 0), 'Shift dashes');
  await sleep(150);
  assert.match(await text(page, '#chipSpeed'), /Dash/);
  assert.equal(await page.evaluate(() => document.getElementById('dashBtn').disabled), true);
  await page.evaluate(() => { __t.game().state.item = 'peel'; });
  await sleep(100);
  assert.equal(await page.evaluate(() => document.getElementById('useBtn').disabled), false);
  await page.dispatchEvent('#useBtn', 'pointerdown');
  assert.ok(await page.evaluate(() => __t.game().state.peels.length === 1 && __t.game().state.item === null), 'button drops the item');
  await shot(page, '30-applerun');
  // get caught
  await page.evaluate(() => {
    const s = __t.game().state, a = s.apple;
    s.snake = [{ x: (a.x + 1) % 20, y: a.y }, { x: (a.x + 2) % 20, y: a.y }, { x: (a.x + 3) % 20, y: a.y }, { x: (a.x + 4) % 20, y: a.y }, { x: (a.x + 5) % 20, y: a.y }];
    s.dir = { x: -1, y: 0 }; s.stun = 0; s.slideLeft = 0; s.peels = []; s.decoy = null; s.dashLeft = 0;
    s.appleDir = { x: 1, y: 0 };
    s.apple.x = a.x; // already adjacent: the apple walks into the head
  });
  await waitState(page, () => __t.game().state.phase === 'over', 8000);
  assert.equal(await page.evaluate(() => __t.game().state.reason), 'caught');
  assert.equal(await text(page, '#ovTitle'), 'Gotcha!');
  assert.match(await text(page, '#ovStats'), /Survived/);
  await shot(page, '31-applerun-over');
  await page.click('#ovBtn');
  await waitState(page, () => __t.game().state.phase === 'ready' || __t.game().state.phase === 'running');
  await finish(ctx, errors);
});

test('E2E Apple Run: switching modes in the game hides the Apple Run controls again', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'chase', edge: 'walls' } }) });
  await play(page);
  await page.click('#menuBtn');
  await page.click('.mode[data-mode="classic"]');
  await play(page);
  assert.equal(await page.evaluate(() => document.getElementById('chaseActions').hidden), true);
  assert.equal(await page.evaluate(() => __t.game().mode), 'classic');
  await finish(ctx, errors);
});

test('E2E settings polish: volume, animations override, help text, and a two-step reset', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'classic', edge: 'wrap' }, totals: { foods: 7, bonus: 0, runs: 3 } }) });
  await page.click('#homeSettingsBtn');
  await page.fill('#volume', '40');
  assert.equal(await text(page, '#volumeOut'), '40%');
  assert.equal(await page.evaluate(() => __t.profile.getPrefs().volume), 0.4);
  await page.click('#motionOff');
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-motion')), 'off');
  assert.equal(await page.evaluate(() => __t.profile.getPrefs().motion), 'off');
  await page.click('details.help >> nth=0');
  assert.ok((await page.locator('details.help').first().innerText()).includes('Apple Run'));
  await page.click('#resetBtn');
  assert.match(await text(page, '#resetBtn'), /confirm/i);
  assert.equal(await page.evaluate(() => __t.profile.getTotals().foods), 7, 'one tap does not reset');
  await page.click('#resetBtn');
  assert.equal(await page.evaluate(() => __t.profile.getTotals().foods), 0);
  assert.equal(await page.evaluate(() => __t.profile.getPrefs().motion), 'off', 'settings survive');
  await page.click('#settingsClose');
  await page.reload();
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-motion')), 'off', 'remembered after reload');
  await finish(ctx, errors);
});

test('E2E shop: coins from a run, locked items, buying, equipping, and saved after reload', { timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'classic', edge: 'walls' }, coins: 180 }) });
  assert.equal(await text(page, '#homeCoins'), '180');
  await page.click('#homeShopBtn');
  assert.equal(await page.locator('.shop-item').count(), require('../src/shop.js').ITEMS.length);
  assert.equal(await text(page, '[data-id="skin:jordan"] button'), 'Buy for 200');
  assert.equal(await page.evaluate(() => document.querySelector('[data-id="skin:jordan"] button').disabled), true, 'not enough coins');
  await page.click('#shopClose');
  // finish a run to earn coins
  await play(page);
  await page.evaluate(() => { const s = __t.game().state; s.score = 25; s.snake = [{ x: 19, y: 10 }, { x: 18, y: 10 }, { x: 17, y: 10 }]; s.goldSegs = [false, false, false]; s.dir = { x: 1, y: 0 }; s.queue = []; s.food = { x: 0, y: 0 }; });
  await waitState(page, () => __t.game().state.phase === 'over');
  assert.match(await text(page, '#ovStats'), /\+(\d+) coins/);
  await page.click('#ovSec');
  assert.equal(await text(page, '#homeCoins'), String(await page.evaluate(() => __t.profile.getCoins())));
  assert.ok(await page.evaluate(() => __t.profile.getCoins()) >= 200, 'enough coins to buy the 200 keffiyeh after a run');
  await page.click('#homeShopBtn');
  await page.click('[data-id="skin:jordan"] button');
  assert.equal(await text(page, '[data-id="skin:jordan"] button'), 'Equipped');
  assert.equal(await page.evaluate(() => __t.profile.getPrefs().skin), 'jordan');
  assert.equal(await page.evaluate(() => __t.profile.owns('skin:jordan')), true);
  await shot(page, '32-shop');
  await page.click('#shopClose');
  await page.reload();
  assert.equal(await page.evaluate(() => __t.profile.getPrefs().skin), 'jordan', 'kept after reload');
  await play(page);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await shot(page, '33-jordan-in-game');
  await finish(ctx, errors);
});

test('E2E shop: an unowned skin saved in storage is not used', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'classic', edge: 'walls', skin: 'dragon', board: 'neon' } }) });
  assert.equal(await page.evaluate(() => __t.profile.getPrefs().skin), 'emerald');
  assert.equal(await page.evaluate(() => __t.profile.getPrefs().board), 'midnight');
  await finish(ctx, errors);
});

test('E2E phone: the whole game fits one screen, controls are reachable, no page scrolling', { timeout: 90000 }, async () => {
  for (const m of ['classic', 'survival', 'chase']) {
    const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: m, edge: 'walls', controls: 'arrows' } }), context: { viewport: { width: 390, height: 700 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } });
    await page.tap('#playBtn');
    await waitState(page, () => __t.game().state.phase === 'running');
    await sleep(300);
    const g = await page.evaluate(() => {
      const r = id => { const b = document.querySelector(id).getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, r: b.right, w: b.width, h: b.height }; };
      return { sh: document.documentElement.scrollHeight, ih: innerHeight, sw: document.documentElement.scrollWidth, iw: innerWidth, board: r('#boardWrap'), pad: r('.pad'), up: r('.pad .up'), menu: r('#menuBtn'),
        dash: document.getElementById('chaseActions').hidden ? null : r('#dashBtn'), use: document.getElementById('chaseActions').hidden ? null : r('#useBtn') };
    });
    assert.ok(g.sh <= g.ih + 1, m + ': no vertical scroll ' + g.sh + '/' + g.ih);
    assert.ok(g.sw <= g.iw, m + ': no horizontal scroll');
    assert.ok(Math.abs(g.board.w - g.board.h) < 2, m + ': board stays square');
    assert.ok(g.board.w >= 280, m + ': board is big enough ' + g.board.w);
    assert.ok(g.pad.b <= g.ih && g.pad.t > g.board.b - 2, m + ': pad under the board and on screen');
    assert.ok(g.up.w >= 60 && g.up.h >= 60, m + ': big touch targets');
    assert.ok(g.menu.t >= 0 && g.menu.b <= g.ih);
    if (m === 'chase') {
      assert.ok(g.dash && g.dash.b <= g.ih && g.dash.h >= 50 && g.use.h >= 50, 'Apple Run buttons are big and on screen');
      assert.ok(g.dash.r <= g.pad.l + 1 || g.dash.l >= g.pad.r - 1, 'they do not overlap the pad');
    }
    await page.tap('.pad .left');                       // the pad steers
    if (m === 'chase') assert.deepEqual(await page.evaluate(() => __t.game().state.appleDir), { x: -1, y: 0 });
    await shot(page, '40-phone-' + m);
    await finish(ctx, errors);
  }
});

/* =====================================================================
   Profile: name, backup code, online copy
   ===================================================================== */

test('E2E name gate: a name is required once, cannot be skipped, and is remembered', { timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ name: '' }) });
  const isOpen = () => page.evaluate(() => document.getElementById('welcomeDlg').open);
  assert.equal(await isOpen(), true);
  await page.keyboard.press('Escape');
  assert.equal(await isOpen(), true, 'Esc cannot skip');
  await page.fill('#welcomeInput', '   ');
  await page.click('#welcomeForm button[type="submit"]');
  assert.equal(await isOpen(), true, 'blank rejected');
  await shot(page, '33-welcome');
  await page.fill('#welcomeInput', 'Waseem');
  await page.click('#welcomeForm button[type="submit"]');
  assert.equal(await isOpen(), false);
  assert.equal(await text(page, '#homeName'), 'Waseem');
  await page.reload();
  assert.equal(await isOpen(), false, 'not asked again');
  await finish(ctx, errors);
});

test('E2E name gate: restoring a backup code with a name closes it', { timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ name: '' }) });
  const code = await page.evaluate(() => { const c = __t.profile.exportCode(); return c; });
  await page.evaluate(() => __t.profile.setName('Rana'));
  const code2 = await page.evaluate(() => __t.profile.exportCode());
  await page.evaluate(() => __t.profile.setName(''));
  await page.reload();
  await page.click('#welcomeDlg summary');
  await page.fill('#welcomeCode', code2);
  await page.click('#welcomeRestore');
  assert.equal(await page.evaluate(() => document.getElementById('welcomeDlg').open), false);
  assert.equal(await text(page, '#homeName'), 'Rana');
  await finish(ctx, errors);
});

test('E2E profile: set a name, see stats, and restore from a backup code', { timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'classic', edge: 'walls' }, coins: 321, totals: { foods: 12, bonus: 1, runs: 4 } }) });
  assert.equal(await text(page, '#homeName'), 'Tester');
  await page.click('#homeProfileBtn');
  assert.equal(await page.evaluate(() => document.getElementById('profileDlg').open), true);
  await page.fill('#nameInput', '  Waseem  ');
  await page.click('#nameForm button[type="submit"]');
  assert.equal(await text(page, '#homeName'), 'Waseem');
  assert.equal(await text(page, '#homeAvatar'), 'W');
  assert.match(await text(page, '#pfStats'), /Coins\s*321/);
  assert.match(await text(page, '#pfStats'), /Foods eaten\s*12/);
  assert.equal(await text(page, '#pfHeroName'), 'Waseem');
  assert.match(await text(page, '#pfBests'), /Classic/);
  assert.match(await text(page, '#pfSave'), /this device only/);
  const code = await page.inputValue('#pfCode');
  assert.match(code, /^GS2\./);
  await shot(page, '34-profile');
  await page.click('#pfBackupSummary');
  await page.fill('#pfRestoreCode', 'GS2.nonsense');
  await page.click('#pfRestore');
  assert.match(await text(page, '#pfBackupMsg'), /did not work/);
  // wipe, then restore from the code
  await page.evaluate(() => { __t.profile.resetProgress(); __t.profile.setName(''); });
  assert.equal(await page.evaluate(() => __t.profile.getCoins()), 0);
  await page.fill('#pfRestoreCode', code);
  await page.click('#pfRestore');
  assert.match(await text(page, '#pfBackupMsg'), /Restored/);
  assert.equal(await page.evaluate(() => __t.profile.getCoins()), 321);
  assert.equal(await text(page, '#homeName'), 'Waseem');
  await page.click('#profileClose');
  await page.reload();
  assert.equal(await text(page, '#homeName'), 'Waseem', 'kept after reload');
  await finish(ctx, errors);
});

test('E2E profile: the online copy brings progress back on a device with nothing saved', { timeout: 90000 }, async () => {
  const fake = `(() => {
    const key = p => '__cloud:' + p;
    window.claude = { use: async n => n === 'user' ? { id: async () => 'u1' } : n === 'db' ? { doc: p => ({
      get: async () => { const v = sessionStorage.getItem(key(p)); return { exists: v !== null, data: () => JSON.parse(v) }; },
      set: async d => { sessionStorage.setItem(key(p), JSON.stringify(d)); }
    }) } : null };
  })();`;
  const { ctx, page, errors } = await open({ init: fake, storage: seed({ name: '', prefs: { mode: 'classic', edge: 'walls' } }) });
  await page.fill('#welcomeInput', 'Temp'); await page.click('#welcomeForm button[type="submit"]');
  await page.evaluate(() => { __t.profile.setName('Waseem'); __t.profile.addCoins(777); });
  await waitState(page, () => Object.keys(sessionStorage).some(k => k.startsWith('__cloud:')), undefined, 8000);
  assert.match(await page.evaluate(() => sessionStorage.getItem(Object.keys(sessionStorage).find(k => k.startsWith('__cloud:')))), /777/);
  await page.evaluate(() => localStorage.clear());               // a new device: nothing saved locally
  await page.reload();
  await waitState(page, () => __t.profile.getCoins() === 777, undefined, 8000);
  assert.equal(await page.evaluate(() => __t.profile.getName()), 'Waseem');
  assert.equal(await text(page, '#homeName'), 'Waseem');
  await page.click('#homeProfileBtn');
  assert.match(await text(page, '#pfSave'), /online profile/);
  await finish(ctx, errors);
});

test('E2E golden apple is drawn as a golden apple (gold body and a leaf), not a plain ball', { timeout: 60000 }, async () => {
  const { ctx, page, errors } = await open({ storage: seed({ prefs: { mode: 'classic', edge: 'walls', golden: true } }) });
  await play(page);
  await page.evaluate(() => { const s = __t.game().state; s.food = { x: 0, y: 0 }; s.gold = { x: 15, y: 5, ttl: 5000, life: 5000 }; });
  await page.keyboard.press('Space');
  await waitState(page, () => __t.game().state.phase === 'paused');
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(450);
  const px = await page.evaluate(() => {
    const cv = document.getElementById('board'), c = cv.width / __t.game().tuning.cols, ctx = cv.getContext('2d');
    const at = (x, y) => Array.from(ctx.getImageData(Math.round((15 + x) * c), Math.round((5 + y) * c), 1, 1).data).slice(0, 3);
    return { body: at(0.5 + 0.12, 0.5 + 0.15), leaf: at(0.5 + 0.17, 0.5 - 0.3) };
  });
  assert.ok(px.body[0] > 200 && px.body[1] > 150 && px.body[2] < 140, 'gold body: ' + px.body);
  assert.ok(px.leaf[1] > px.leaf[0] - 10 && px.leaf[1] > 140 && px.leaf[2] < 120, 'leaf is green-ish: ' + px.leaf);
  await shot(page, '35-golden-apple');
  await finish(ctx, errors);
});

/* =====================================================================
   Mobile gameplay: difficulty and touch controls
   ===================================================================== */

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

test('E2E difficulty: a computer keeps the original (Hard) speed, a phone starts on Easy, and the choice is saved and restarts the run', { timeout: 90000 }, async () => {
  const desk = await open({ storage: seed({ prefs: { mode: 'classic', edge: 'walls' } }) });
  assert.equal(await desk.page.evaluate(() => __t.game().interval()), 150, 'desktop default is the original game');
  await finish(desk.ctx, desk.errors);

  const { ctx, page, errors } = await open({ context: PHONE, storage: seed({ prefs: { mode: 'classic', edge: 'walls' } }) });
  assert.equal(await page.evaluate(() => __t.game().interval()), 190, 'phone default is Easy');
  await page.tap('#homeSettingsBtn');
  assert.equal(await page.getAttribute('#diffEasy', 'aria-pressed'), 'true');
  await shot(page, '40-settings-mobile');
  await page.tap('#diffNormal');
  assert.equal(await page.evaluate(() => __t.game().interval()), 170);
  await page.tap('#diffHard');
  assert.equal(await page.evaluate(() => __t.game().interval()), 150);
  assert.equal(await page.getAttribute('#diffHard', 'aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gridsnake-profile-v2')).prefs.difficulty), 'hard');
  await page.reload();
  assert.equal(await page.evaluate(() => __t.game().interval()), 150, 'kept after reload');
  await finish(ctx, errors);
});

test('E2E touch controls: two turn buttons turn left and right of the heading, and Arrows / Swipe only switch the layout', { timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open({ context: PHONE, storage: seed({ prefs: { mode: 'classic', edge: 'wrap', difficulty: 'easy' } }) });
  await page.tap('#playBtn');
  await waitState(page, () => __t.game().state.phase === 'running');
  assert.equal(await page.getAttribute('html', 'data-controls'), 'turn', 'phone default');
  assert.equal(await shown(page, '.turnpad'), true);
  assert.equal(await shown(page, '.pad'), false);
  assert.equal(await noOverflow(page), true);
  const b = await page.evaluate(() => { const r = document.getElementById('turnLeft').getBoundingClientRect(); return { w: r.width, h: r.height, bottom: r.bottom, vh: innerHeight }; });
  assert.ok(b.w >= 120 && b.h >= 80 && b.bottom <= b.vh, 'big buttons inside the screen: ' + JSON.stringify(b));
  await shot(page, '41-turnpad-mobile');
  // heading right: left -> up, then right -> right again (turns are relative to the queued heading)
  await page.evaluate(() => { __t.game().state.acc = -1e9; });
  await page.tap('#turnLeft');
  assert.deepEqual((await st(page)).queue, [{ x: 0, y: -1 }]);
  await page.tap('#turnLeft');
  assert.deepEqual((await st(page)).queue, [{ x: 0, y: -1 }, { x: -1, y: 0 }], 'a second tap keeps turning the same way');
  await page.tap('#turnRight');
  assert.deepEqual((await st(page)).queue, [{ x: 0, y: -1 }, { x: -1, y: 0 }, { x: 0, y: -1 }], 'three turns wait on Easy');
  await page.evaluate(() => { __t.game().state.acc = 0; });

  await finish(ctx, errors);
});

test('E2E touch controls: Arrows and Swipe only are saved and shown correctly', { timeout: 90000 }, async () => {
  const { ctx, page, errors } = await open({ context: PHONE, storage: seed({ prefs: { mode: 'classic', edge: 'wrap' } }) });
  await page.tap('#homeSettingsBtn');
  await page.tap('#ctrlArrows');
  await page.tap('#settingsClose');
  await page.tap('#playBtn');
  assert.equal(await shown(page, '.pad'), true);
  assert.equal(await shown(page, '.turnpad'), false);
  await page.tap('#menuBtn');
  await page.tap('#homeSettingsBtn');
  await page.tap('#ctrlSwipe');
  await page.tap('#settingsClose');
  await page.tap('#playBtn');
  assert.equal(await shown(page, '.pad'), false);
  assert.equal(await shown(page, '.turnpad'), false);
  assert.equal(await noOverflow(page), true);
  await shot(page, '42-swipe-only-mobile');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gridsnake-profile-v2')).prefs.controls), 'swipe');
  await page.reload();
  assert.equal(await page.getAttribute('html', 'data-controls'), 'swipe');
  await finish(ctx, errors);
});

test('E2E toasts on phones: an achievement message never covers the steering buttons or the board, and never blocks a tap', { timeout: 120000 }, async () => {
  for (const [name, vp, controls] of [['portrait turn', { width: 390, height: 844 }, 'turn'], ['portrait arrows', { width: 390, height: 844 }, 'arrows'], ['landscape arrows', { width: 844, height: 390 }, 'arrows'], ['small phone', { width: 360, height: 640 }, 'turn']]) {
    const { ctx, page, errors } = await open({ context: Object.assign({ isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, { viewport: vp }), storage: seed({ prefs: { mode: 'classic', edge: 'wrap', controls } }) });
    await page.tap('#playBtn');
    await waitState(page, () => __t.game().state.phase === 'running');
    await page.evaluate(() => { __t.game().state.score = 9; });              // one more point finishes the first High Roller tier
    await eatOne(page);
    await page.waitForSelector('.toast');
    await page.waitForTimeout(350);                                         // let the slide-in finish
    const r = await page.evaluate(() => {
      const box = el => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
      const hit = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
      const toast = box(document.querySelector('.toast')), out = { toast, pe: getComputedStyle(document.getElementById('toasts')).pointerEvents, hits: [], inside: toast.t >= 0 && toast.b <= innerHeight && toast.l >= 0 && toast.r <= innerWidth };
      document.querySelectorAll('.pad button, .turnpad button, #board').forEach(el => { const d = el.offsetParent !== null ? box(el) : null; if (d && d.r > d.l && hit(toast, d)) out.hits.push(el.id || el.className || el.tagName); });
      return out;
    });
    assert.deepEqual(r.hits, [], name + ': toast overlaps ' + r.hits.join(',') + ' ' + JSON.stringify(r.toast));
    assert.equal(r.pe, 'none', name + ': toasts ignore taps');
    assert.equal(r.inside, true, name + ': toast fully on screen');
    if (name === 'portrait turn') await shot(page, '43-toast-mobile');
    await finish(ctx, errors);
  }
});
