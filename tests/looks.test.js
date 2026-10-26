'use strict';
const { KEY, SECRET, defaultBoard } = require('./support/board.js');
/* Each new look renders in a real game: no page errors, and the board is painted (not blank) with the snake on it.
 * Run: node build.js && NODE_PATH=$(npm root -g) node --test tests/looks.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const hooked = src.replace('/*TEST_HOOK*/', 'window.__t = { game: function () { return game; } };');
const LOOKS = [['skin', 'shemagh'], ['skin', 'royal'], ['board', 'meadow'], ['board', 'autumn']];

test('each new skin and board renders in a game without errors', async () => {
  const browser = await chromium.launch();
  try {
    for (const [kind, key] of LOOKS) {
      const prefs = { mode: 'classic', edge: 'walls', controls: 'turn' };
      prefs[kind] = key;
      const owned = { 'skin:shemagh': true, 'skin:royal': true, 'board:meadow': true, 'board:autumn': true };
      const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
      await ctx.addInitScript(([p, o]) => { try { localStorage.setItem('gridsnake-profile-v2', JSON.stringify({ name: 'T', prefs: p, owned: o })); } catch (e) {} }, [prefs, owned]);
      const page = await ctx.newPage();
      await ctx.addInitScript(([k, v]) => { try { if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } catch (e) {} }, [KEY, JSON.stringify({ name: 'Waseem', secret: SECRET })]);
      await page.route('**/rest/v1/rpc/**', defaultBoard().route);
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
      await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
      await page.route('https://looks.test/**', r => r.fulfill({ contentType: 'text/html', body: hooked }));
      await page.goto('https://looks.test/index.html');
      await page.click('#playBtn');
      await page.waitForTimeout(600);
      const painted = await page.evaluate(() => {
        const cv = document.getElementById('board'), ctx2 = cv.getContext('2d');
        const d = ctx2.getImageData(0, 0, cv.width, cv.height).data;
        const seen = new Set();
        for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
        return seen.size;
      });
      assert.deepEqual(errors, [], `${key}: page errors`);
      // A bare board samples as 1 colour; the snake, food and grid add more. 6 is a clear line between the two.
      assert.ok(painted >= 6, `${key}: the board looks blank (${painted} colours)`);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
});
