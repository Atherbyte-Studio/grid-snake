/* Checks the exact files that go into the app (www/): offline, fonts, Android Back, phone sizes.
 * Run: node scripts/build-www.js && node --test tests/www.test.js   (needs Playwright + Chromium) */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const WWW = path.join(__dirname, '..', 'www');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.ttf': 'font/ttf' };
let server, base, browser;

test.before(async () => {
  assert.ok(fs.existsSync(path.join(WWW, 'index.html')), 'run node scripts/build-www.js first');
  server = http.createServer((req, res) => {
    const f = path.join(WWW, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
    if (!f.startsWith(WWW) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port + '/';
  browser = await chromium.launch();
});
test.after(async () => { await browser.close(); server.close(); });

async function open(vp, named) {
  const touch = vp.width < 900;
  const ctx = await browser.newContext({ viewport: vp, hasTouch: touch, isMobile: touch });
  const page = await ctx.newPage();
  const requests = [], errors = [];
  page.on('request', r => requests.push(r.url()));
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  if (named) await page.addInitScript(() => { if (!localStorage.getItem('seeded')) { localStorage.setItem('seeded', '1'); localStorage.setItem('gridsnake-profile-v2', JSON.stringify({ name: 'Tester', prefs: { mode: 'classic', edge: 'walls' } })); } });
  await page.goto(base);
  await page.waitForFunction(() => !document.getElementById('playBtn').disabled);
  return { ctx, page, requests, errors };
}
const back = page => page.evaluate(() => window.__androidBack());
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

test('offline: every request stays inside the app and the bundled fonts load', async () => {
  const { ctx, page, requests, errors } = await open({ width: 390, height: 844 }, true);
  assert.ok(requests.length >= 3, 'page + fonts.css + fonts requested');
  for (const u of requests) assert.ok(u.startsWith(base), 'external request: ' + u);
  const fonts = await page.evaluate(async () => { await document.fonts.ready; return [document.fonts.check('700 20px Sora'), document.fonts.check('400 15px "Instrument Sans"'), [...document.fonts].filter(f => f.status === 'loaded').length]; });
  assert.equal(fonts[0], true); assert.equal(fonts[1], true); assert.equal(fonts[2], 2, 'both local font files loaded');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Android Back: name box cannot be skipped, dialogs close, a run returns to the menu, menu lets the app minimise', async () => {
  const first = await open({ width: 390, height: 844 }, false);                  // first launch: no name yet
  assert.equal(await first.page.evaluate(() => document.getElementById('welcomeDlg').open), true);
  assert.equal(await back(first.page), true);
  assert.equal(await first.page.evaluate(() => document.getElementById('welcomeDlg').open), true, 'still open');
  await first.ctx.close();

  const { ctx, page } = await open({ width: 390, height: 844 }, true);
  assert.equal(await back(page), false, 'on the menu Back is not handled, so the app minimises');
  for (const [btn, dlg] of [['#homeSettingsBtn', 'settings'], ['#homeShopBtn', 'shopDlg'], ['#homeAchBtn', 'achDialog'], ['#homeProfileBtn', 'profileDlg']]) {
    await page.click(btn);
    assert.equal(await page.evaluate(d => document.getElementById(d).open, dlg), true, dlg + ' opened');
    assert.equal(await back(page), true);
    assert.equal(await page.evaluate(d => document.getElementById(d).open, dlg), false, dlg + ' closed by Back');
  }
  await page.click('#playBtn');
  assert.equal(await page.evaluate(() => document.getElementById('game').hidden), false);
  assert.equal(await back(page), true);
  assert.equal(await page.evaluate(() => document.getElementById('home').hidden), false, 'back on the menu');
  assert.equal(await back(page), false);
  await ctx.close();
});

for (const [name, vp] of [['phone portrait 390x844', { width: 390, height: 844 }], ['small phone 360x640', { width: 360, height: 640 }], ['phone landscape 844x390', { width: 844, height: 390 }]]) {
  test('layout: ' + name + ' has no sideways scroll, and the board and controls fit on screen', async () => {
    const { ctx, page, errors } = await open(vp, true);
    assert.equal(await overflow(page), false, 'home overflows sideways');
    await page.click('#playBtn');
    await page.waitForTimeout(300);
    assert.equal(await overflow(page), false, 'game overflows sideways');
    const r = await page.evaluate(() => {
      const box = el => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
      return { canvas: box(document.querySelector('#game canvas')), pad: document.querySelector('.pad') ? box(document.querySelector('.pad')) : null, w: innerWidth, h: innerHeight };
    });
    assert.ok(r.canvas.l >= -1 && r.canvas.r <= r.w + 1 && r.canvas.t >= -1 && r.canvas.b <= r.h + 1, 'board inside the screen: ' + JSON.stringify(r.canvas));
    if (r.pad && r.pad.b > 0) assert.ok(r.pad.b <= r.h + 1, 'arrow pad inside the screen');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}
