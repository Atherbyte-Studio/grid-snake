'use strict';
/* Reference opponents for measuring the Duel AI (tests and scripts/duel-sim.js only, never shipped).
 * They stand in for human play styles. All use the public round API, like the real AI and the player. */
const Duel = require('../../src/duel/engine.js');
const DIRS = Duel.DIRS;

function seeded(seed) { return Duel.seededRng(seed >>> 0); }
function rev(a, b) { return a.x === -b.x && a.y === -b.y; }
function occupiedSoon(r, x, y) {                       // a body cell that will still be there next tick
  const S = r.state;
  for (const s of S.snakes) for (let k = 0; k < s.body.length - 1; k++) if (s.body[k].x === x && s.body[k].y === y) return true;
  return false;
}
function deadly(r, x, y, react) {
  if (r.isWall(x, y) || occupiedSoon(r, x, y) || r.lethal(x, y)) return true;
  const w = r.warn(x, y);
  if (w > 0 && w <= react) return true;
  const p = r.portalAt(x, y);
  return !!(p && !p.open);
}
function bfs(r, from, react) {
  const N = r.size, d = new Int16Array(N * N).fill(-1), first = new Int8Array(N * N).fill(-1), q = [];
  DIRS.forEach((m, i) => {
    const x = from.x + m.x, y = from.y + m.y;
    if (deadly(r, x, y, react)) return;
    const c = y * N + x;
    if (d[c] >= 0) return;
    d[c] = 1; first[c] = i; q.push(c);
  });
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi], cx = c % N, cy = (c - cx) / N;
    for (const m of DIRS) {
      const x = cx + m.x, y = cy + m.y;
      if (r.isWall(x, y) || occupiedSoon(r, x, y) || r.lethal(x, y)) continue;
      const n = y * N + x;
      if (d[n] >= 0) continue;
      d[n] = d[c] + 1; first[n] = first[c]; q.push(n);
    }
  }
  return { d, first };
}
function area(r, x, y, cap) {
  const N = r.size, seen = new Uint8Array(N * N), q = [y * N + x];
  if (deadly(r, x, y, 99)) return 0;
  seen[q[0]] = 1;
  for (let qi = 0; qi < q.length && q.length < cap; qi++) {
    const c = q[qi], cx = c % N, cy = (c - cx) / N;
    for (const m of DIRS) {
      const nx = cx + m.x, ny = cy + m.y, n = ny * N + nx;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N || seen[n] || deadly(r, nx, ny, 99)) continue;
      seen[n] = 1; q.push(n);
    }
  }
  return q.length;
}
function safeMoves(r, s, react) {
  return DIRS.filter(m => !rev(m, s.dir) && !deadly(r, s.body[0].x + m.x, s.body[0].y + m.y, react));
}

/* greedy: shortest safe path to the nearest food; checks it keeps some room. A solid, food-first player. */
function greedy(opts) {
  const o = Object.assign({ react: 3, slip: 0, seed: 1, roomy: true }, opts || {}), rng = seeded(o.seed);
  return { kind: 'bot', next(r, i) {
    const s = r.state.snakes[i], h = s.body[0], safe = safeMoves(r, s, o.react);
    if (!safe.length) return null;
    if (o.slip && rng() < o.slip) return safe[Math.floor(rng() * safe.length)];
    const { d, first } = bfs(r, h, o.react);
    let best = -1, bd = 1e9;
    for (const f of r.state.foods) { const c = f.y * r.size + f.x; if (d[c] > 0 && d[c] < bd) { bd = d[c]; best = first[c]; } }
    let pick = best >= 0 ? DIRS[best] : null;
    if (o.roomy) {
      const roomOf = m => area(r, h.x + m.x, h.y + m.y, s.body.length * 2 + 4);
      if (!pick || roomOf(pick) <= s.body.length) pick = safe.slice().sort((a, b) => roomOf(b) - roomOf(a))[0];
    }
    return pick || safe[0];
  } };
}
/* novice: like greedy but reacts late to warnings and wanders now and then (a beginner). */
function novice(seed) { return greedy({ react: 2, slip: 0.12, seed, roomy: false }); }
/* cautious: keeps away from the rival and only eats food that is close. */
function cautious(seed) {
  const g = greedy({ seed });
  return { kind: 'bot', next(r, i) {
    const s = r.state.snakes[i], o = r.state.snakes[1 - i], h = s.body[0], safe = safeMoves(r, s, 4);
    if (!safe.length) return null;
    const near = r.state.foods.some(f => Math.abs(f.x - h.x) + Math.abs(f.y - h.y) <= 6);
    if (near) return g.next(r, i);
    return safe.slice().sort((a, b) => {
      const da = Math.abs(h.x + a.x - o.body[0].x) + Math.abs(h.y + a.y - o.body[0].y), db = Math.abs(h.x + b.x - o.body[0].x) + Math.abs(h.y + b.y - o.body[0].y);
      return (area(r, h.x + b.x, h.y + b.y, 80) - area(r, h.x + a.x, h.y + a.y, 80)) * 2 + (db - da);
    })[0];
  } };
}
/* aggressive: heads for the cell in front of the rival's head (trying to cut it off), eats on the way. */
function aggressive(seed) {
  const g = greedy({ seed });
  return { kind: 'bot', next(r, i) {
    const s = r.state.snakes[i], o = r.state.snakes[1 - i], h = s.body[0], safe = safeMoves(r, s, 3);
    if (!safe.length) return null;
    const tx = o.body[0].x + o.dir.x * 3, ty = o.body[0].y + o.dir.y * 3;
    const foodNext = safe.find(m => r.foodAt(h.x + m.x, h.y + m.y) >= 0);
    if (foodNext) return foodNext;
    if (Math.abs(tx - h.x) + Math.abs(ty - h.y) > 14) return g.next(r, i);
    return safe.slice().sort((a, b) => (Math.abs(h.x + a.x - tx) + Math.abs(h.y + a.y - ty)) - (Math.abs(h.x + b.x - tx) + Math.abs(h.y + b.y - ty)))[0];
  } };
}

const BOTS = { greedy: s => greedy({ seed: s }), novice, cautious, aggressive };
module.exports = { BOTS, greedy, novice, cautious, aggressive };
