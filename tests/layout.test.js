'use strict';
const { KEY, SECRET, defaultBoard } = require('./support/board.js');
/* Layout regression: on phone widths, the Survival / Time Attack effect chips must not cover the board.
 * Run: node build.js && NODE_PATH=$(npm root -g) node --test tests/layout.test.js
 * Loads index.html (the phone-viewport page) in memory with the same test hook as e2e.test.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const hooked = src.replace('/*TEST_HOOK*/', 'window.__t = { game: function () { return game; } };');

test('Survival and Time Attack effect chips never cover the board on phones', async () => {
  const browser = await chromium.launch();
  try {
    for (const mode of ['survival', 'timeattack']) for (const w of [320, 375, 430]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 760 }, isMobile: true, hasTouch: true });
      await ctx.addInitScript(() => { try { localStorage.setItem('gridsnake-profile-v2', JSON.stringify({ name: 'T', prefs: { mode: 'survival', edge: 'walls', controls: 'turn' } })); } catch (e) {} });
      const page = await ctx.newPage();
      await ctx.addInitScript(([k, v]) => { try { if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } catch (e) {} }, [KEY, JSON.stringify({ name: 'Waseem', secret: SECRET })]);
      await page.route('**/rest/v1/rpc/**', defaultBoard().route);
      await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
      await page.route('https://layout.test/**', r => r.fulfill({ contentType: 'text/html', body: hooked }));
      await page.goto('https://layout.test/index.html');
      await page.evaluate(m => document.querySelector('[data-mode="' + m + '"]').click(), mode);
      await page.click('#playBtn');
      await page.waitForTimeout(300);
      await page.evaluate(() => { window.__t.game().state.shield = true; });   // a real shield chip is showing
      await page.waitForTimeout(200);
      const covered = await page.evaluate(() => {
        const c = document.getElementById('board').getBoundingClientRect();
        const chips = [...document.querySelectorAll('#effects .chip')].filter(e => !e.hidden && getComputedStyle(e).display !== 'none');
        return chips.reduce((m, e) => Math.max(m, Math.min(e.getBoundingClientRect().bottom, c.bottom) - Math.max(e.getBoundingClientRect().top, c.top) > 0 ? 1 : m), 0);
      });
      assert.equal(covered, 0, `${mode} at ${w}px: an effect chip overlaps the board`);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
});
