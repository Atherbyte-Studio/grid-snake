/* Builds www/ (the folder Capacitor bundles into the app) from the original game file.
 * The original ../grid-snake.html is only READ. Changes made for the phone app:
 *   1. Google Fonts link -> fonts shipped inside the app (works offline).
 *   2. A real viewport meta tag (the claude.ai viewer normally adds it).
 *   3. Small touch polish: no tap flash, no long-press menu, no pull-to-refresh glow.
 *   4. window.__androidBack: what the Android Back button does (see MainActivity.java).
 * Every replacement must match exactly once, so a changed game file fails loudly instead of silently. */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = process.env.GAME_HTML || path.join(root, '..', 'grid-snake.html');
const out = path.join(root, 'www');

let html = fs.readFileSync(src, 'utf8');
function swap(find, put) {
  const n = html.split(find).length - 1;
  if (n !== 1) throw new Error('expected exactly 1 match, found ' + n + ' for: ' + find.slice(0, 70));
  html = html.replace(find, () => put);
}

swap('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=Sora:wght@500;600;700&display=swap">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="theme-color" content="#121413">\n<link rel="stylesheet" href="fonts/fonts.css">');

swap('<style>\n', `<style>
/* app polish */
html { -webkit-tap-highlight-color: transparent; overscroll-behavior: none; }
body { -webkit-touch-callout: none; }
</style>
<style>
`);

swap('/*TEST_HOOK*/', `/* Android Back button: close the open dialog, or leave the run for the menu. Returns true when it handled Back. */
  window.__androidBack = function () {
    var w = $('welcomeDlg');
    if (w.open) return true;                                  // the name box is required: Back cannot skip it
    var ds = [pfDlg, shopDlg, achDlg, dlg];
    for (var i = 0; i < ds.length; i++) if (ds[i].open) { closeDialog(ds[i]); return true; }
    if (view === 'duel') return duelBack();                    // Duel: pause, then its menu, then the game's menu
    if (view === 'game') { if (game.state.phase === 'running') pauseRun(); goMenu(); return true; }
    return false;                                              // already on the menu: let the app go to the background
  };
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  /*TEST_HOOK*/`);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
for (const f of ['Sora.ttf', 'InstrumentSans.ttf']) fs.copyFileSync(path.join(root, 'assets/fonts', f), path.join(out, 'fonts', f));
fs.cpSync(path.join(root, '..', 'assets', 'skins'), path.join(out, 'assets', 'skins'), { recursive: true });   // shop pictures and heads
fs.writeFileSync(path.join(out, 'fonts/fonts.css'), `/* Sora and Instrument Sans, SIL Open Font License (see assets/fonts/OFL-*.txt). Variable fonts: one file, all weights. */
@font-face { font-family: "Sora"; font-weight: 100 800; font-style: normal; font-display: swap; src: url("Sora.ttf") format("truetype"); }
@font-face { font-family: "Instrument Sans"; font-weight: 400 700; font-style: normal; font-display: swap; src: url("InstrumentSans.ttf") format("truetype"); }
`);
console.log('www/ built: index.html ' + html.length + ' bytes');
