'use strict';
/* Measures the Duel AI with repeatable rounds (fixed seeds, every arena and event).
 * node scripts/duel-sim.js [rounds per pairing]          e.g. node scripts/duel-sim.js 60
 * Side A plays player 0, side B player 1; every pairing is also played with the sides swapped, so the spawn
 * never favours anyone. Prints, per side: win %, points, food, Cores, survival, crash rate and the longest
 * stretch without eating (a high number = a snake that ignores food). */
const Duel = require('../src/duel/engine.js');
const Maps = require('../src/duel/maps.js');
const Events = require('../src/duel/events.js');
const AI = require('../src/duel/ai.js');
const { BOTS } = require('../tests/support/duel-bots.js');

function make(name, seed) {
  if (AI.LEVELS.indexOf(name) >= 0) return AI.create(name, seed);
  return BOTS[name](seed);
}

function playRound(a, b, seed, map, event) {
  const ca = make(a, seed * 3 + 1), cb = make(b, seed * 5 + 2);
  const r = Duel.createRound({ map, event, seed, controllers: [ca, cb] });
  const st = [0, 1].map(() => ({ last: 0, drought: 0 }));
  r.on(e => {
    if ((e.type === 'food' || e.type === 'core') && st[e.who]) {
      st[e.who].drought = Math.max(st[e.who].drought, r.state.tick - st[e.who].last);
      st[e.who].last = r.state.tick;
    }
  });
  r.start();
  let n = 0;
  while (r.state.phase === 'running' && n < 2000) { r.tick(); n++; }
  const S = r.state, res = S.result;
  st.forEach(x => { x.drought = Math.max(x.drought, S.tick - x.last); });
  const ms = [ca, cb].map(c => (c.stats && c.stats.decisions ? c.stats.totalMs / c.stats.decisions : 0));
  return S.snakes.map((s, i) => ({
    win: res.winner === i ? 1 : 0, draw: res.draw ? 1 : 0, points: s.score, foods: s.foods, cores: s.cores,
    crashed: s.reason ? 1 : 0, reason: s.reason, ticks: S.tick, drought: st[i].drought, ms: ms[i]
  }));
}

function pairing(a, b, count) {
  const tot = { [a]: [], [b]: [] };
  for (let k = 0; k < count; k++) {
    const map = Maps.ids[k % Maps.ids.length], event = Events.IDS[Math.floor(k / Maps.ids.length) % Events.IDS.length];
    const r1 = playRound(a, b, 1000 + k, map, event), r2 = playRound(b, a, 1000 + k, map, event);
    tot[a].push(r1[0], r2[1]); tot[b].push(r1[1], r2[0]);
  }
  return tot;
}

function summary(rows) {
  const n = rows.length, avg = f => rows.reduce((t, r) => t + f(r), 0) / n;
  const reasons = {};
  rows.forEach(r => { if (r.reason) reasons[r.reason] = (reasons[r.reason] || 0) + 1; });
  return {
    rounds: n,
    win: Math.round(avg(r => r.win) * 100), draw: Math.round(avg(r => r.draw) * 100),
    points: +avg(r => r.points).toFixed(1), foods: +avg(r => r.foods).toFixed(1), cores: +avg(r => r.cores).toFixed(2),
    crash: Math.round(avg(r => r.crashed) * 100), secs: +(avg(r => r.ticks) * 0.12).toFixed(0),
    drought: +(avg(r => r.drought) * 0.12).toFixed(0), ms: +avg(r => r.ms).toFixed(2), reasons
  };
}

if (require.main === module) {
  const count = +(process.argv[2] || 40);
  const pairs = (process.argv[3] ? process.argv[3].split(',') : ['easy:medium', 'easy:hard', 'medium:hard',
    'easy:novice', 'medium:novice', 'hard:novice', 'easy:greedy', 'medium:greedy', 'hard:greedy',
    'hard:cautious', 'hard:aggressive', 'medium:aggressive']).map(p => p.split(':'));
  for (const [a, b] of pairs) {
    const t = pairing(a, b, count), sa = summary(t[a]), sb = summary(t[b]);
    const line = (name, s) => '  ' + name.padEnd(10) + ' win ' + String(s.win).padStart(3) + '%  pts ' + String(s.points).padStart(5) +
      '  food ' + String(s.foods).padStart(5) + '  cores ' + s.cores + '  crash ' + String(s.crash).padStart(3) + '%  alive ' + s.secs +
      's  drought ' + s.drought + 's  ' + (s.ms ? s.ms + 'ms  ' : '') + JSON.stringify(s.reasons);
    console.log(a + ' vs ' + b + ' (' + sa.rounds + ' rounds each, draws ' + sa.draw + '%)');
    console.log(line(a, sa)); console.log(line(b, sb));
  }
}
module.exports = { pairing, summary, playRound };
