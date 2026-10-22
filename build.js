/* Builds the single-file game: node build.js
 * Inlines src/*.js into src/index.template.html (the page is published as one self-contained file). */
const fs = require('fs');
const path = require('path');
const root = __dirname;
let html = fs.readFileSync(path.join(root, 'src/index.template.html'), 'utf8');
html = html.replace(/\/\*@include ([\w./-]+)\*\//g, (m, f) => fs.readFileSync(path.join(root, f), 'utf8'));
fs.writeFileSync(path.join(root, 'grid-snake.html'), html);
console.log('built grid-snake.html (' + html.length + ' bytes)');
