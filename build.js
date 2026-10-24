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
const FRAME = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#fff;color:#000}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style></head><body>\n';
fs.writeFileSync(path.join(root, 'index.html'), FRAME + html + '\n</body></html>');
console.log('built index.html (web page)');
