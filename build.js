/* Builds the single-file game: node build.js
 * Inlines src/*.js into src/index.template.html (the page is published as one self-contained file). */
const fs = require('fs');
const path = require('path');
const root = __dirname;
let html = fs.readFileSync(path.join(root, 'src/index.template.html'), 'utf8');
html = html.replace(/\/\*@include ([\w./-]+)\*\//g, (m, f) => fs.readFileSync(path.join(root, f), 'utf8'));
fs.writeFileSync(path.join(root, 'grid-snake.html'), html);
console.log('built grid-snake.html (' + html.length + ' bytes)');

/* index.html = the same game inside the small page frame that claude.ai adds when it hosts it, so it opens
   as an ordinary web page (GitHub Pages, any host). Never edit index.html by hand: this file rebuilds it. */
const FRAME_HEAD = '<!doctype html><html lang="en"><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#fff;color:#000}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style>\n';

/* Everything below is for the web page only (the claude.ai copy and the Android app stay as they are):
   search-engine title and description, its own canonical address, link-preview (Open Graph / Twitter) tags,
   icons, structured data, the Google AdSense account tag, and a small link back to the studio site. */
const PAGE = 'https://atherbyte.online/grid-snake/';
const TITLE = 'Grid Snake \u2013 Free Online Snake Game | Atherbyte';
const DESC = 'Play Grid Snake, a free online snake game by Atherbyte Studio. Guide your snake, collect food, grow longer, and challenge yourself to beat your high score.';
const SHARE_DESC = 'A free online snake game with four modes: Classic, Time Attack, Survival and Apple Run.';
const LD = { '@context': 'https://schema.org', '@type': 'VideoGame', name: 'Grid Snake', url: PAGE, description: DESC, genre: 'Arcade',
  gamePlatform: 'Web browser', applicationCategory: 'Game', operatingSystem: 'Any', playMode: 'SinglePlayer', isAccessibleForFree: true,
  image: PAGE + 'og-image.png', publisher: { '@type': 'Organization', name: 'Atherbyte Studio', url: 'https://atherbyte.online/' } };
const WEB_HEAD = [
  '<title>' + TITLE + '</title>',
  '<meta name="description" content="' + DESC + '">',
  '<meta name="google-adsense-account" content="ca-pub-3219161174659178">',
  '<link rel="canonical" href="' + PAGE + '">',
  '<meta name="theme-color" content="#121413">',
  '<link rel="icon" href="favicon.ico" sizes="any">',
  '<link rel="icon" href="favicon.png" type="image/png">',
  '<link rel="apple-touch-icon" href="apple-touch-icon.png">',
  '<meta property="og:type" content="website">',
  '<meta property="og:site_name" content="Atherbyte Studio">',
  '<meta property="og:title" content="' + TITLE + '">',
  '<meta property="og:description" content="' + SHARE_DESC + '">',
  '<meta property="og:url" content="' + PAGE + '">',
  '<meta property="og:image" content="' + PAGE + 'og-image.png">',
  '<meta property="og:image:type" content="image/png">',
  '<meta property="og:image:width" content="1200">',
  '<meta property="og:image:height" content="630">',
  '<meta property="og:image:alt" content="Grid Snake game by Atherbyte Studio">',
  '<meta name="twitter:card" content="summary_large_image">',
  '<meta name="twitter:title" content="' + TITLE + '">',
  '<meta name="twitter:description" content="' + SHARE_DESC + '">',
  '<meta name="twitter:image" content="' + PAGE + 'og-image.png">',
  '<meta name="twitter:image:alt" content="Grid Snake game by Atherbyte Studio">',
  '<script type="application/ld+json">' + JSON.stringify(LD) + '</script>',
  '<style>.studio-credit{font-size:13px;color:var(--muted)}.studio-credit a{display:inline-block;padding:10px 0;color:var(--accent-strong)}.studio-credit a:hover{color:var(--text)}</style>'
].join('\n') + '\n</head><body>\n';
const CREDIT = '\n    <p class="studio-credit">A game by <a href="https://atherbyte.online/">Atherbyte Studio</a></p>';

let web = html.replace('<title>Grid Snake</title>\n', '');
if (web === html) throw new Error('build.js: <title>Grid Snake</title> not found, cannot build the web page');
const meta = web.match(/<p class="home-meta">[\s\S]*?<\/p>/);
if (!meta) throw new Error('build.js: home-meta line not found, cannot add the studio link');
web = web.replace(meta[0], () => meta[0] + CREDIT);
fs.writeFileSync(path.join(root, 'index.html'), FRAME_HEAD + WEB_HEAD + web + '\n</body></html>');
console.log('built index.html (web page)');
