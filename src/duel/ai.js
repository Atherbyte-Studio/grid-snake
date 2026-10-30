/* Grid Snake Duel: the rival (AIController)
 * The AI is just another controller: once per tick it returns a direction, and the engine checks that move
 * exactly like the player's. Same speed, same rules. It reads only what the screen shows: walls, bodies, food,
 * the Core, portals and hazard warnings (round.warn(x, y) is the countdown drawn on that cell). It never reads
 * the round's random generator.
 *
 * How it decides (one picture of the board per tick):
 *  1. Candidate moves: the three non-reversing directions. A move is dropped if it lands on a wall, a body, an
 *     active hazard, a blocked portal, or a warned cell whose countdown runs out before the snake would leave.
 *  2. Room check (flood fill, aware of tails moving away): a move that leaves less room than the snake needs is a
 *     trap. A move that a rival head could also enter is a head-on risk.
 *  3. A target: the food worth going for. Then the move that brings it closest.
 *
 * Levels differ only in how well they do this:
 *  easy    a beginner. Aims at the food nearest in a straight line (not by path), changes its mind slowly, sees
 *          warnings late, now and then dawdles or wanders, never tries to block you. Still never drives into
 *          a wall or a body it can see.
 *  medium  a solid player. Real path distances, skips food you will reach first, checks for traps, respects
 *          every warning, does not chase you. Makes the odd poor choice of target.
 *  hard    looks ahead over both snakes' moves (two ticks when you are close, one otherwise). Points come first:
 *          it races for food it can win, takes the Core, and adapts to the score and the clock (behind late:
 *          calculated risks; ahead late: bigger safety margins, still eating). It cuts you off when a move
 *          would leave you no room, and keeps its own escape routes.
 */
var SnakeDuelAI = (function () {
  'use strict';

  var node = typeof module !== 'undefined' && module.exports && typeof require === 'function';
  var Duel = node ? require('./engine.js') : SnakeDuel;
  var DIRS = Duel.DIRS;
  var LEVELS = ['easy', 'medium', 'hard'];

  /* react: how many ticks ahead a warning is taken seriously. margin: room the snake wants beyond its length.
     retarget: ticks before a chosen target is reconsidered. dawdle: chance to keep going straight instead of
     turning toward the target. slip: chance of a random (safe) move. misjudge: chance to pick a worse target.
     avoidHeadon: chance it notices that the rival's head could enter the same cell. */
  var CONF = {
    easy:   { react: 3, margin: 0, retarget: 14, dawdle: 0.18, slip: 0.07, misjudge: 0.25, avoidHeadon: 0.85, depth: 0 },
    medium: { react: 99, margin: 2, retarget: 1, dawdle: 0, slip: 0.015, misjudge: 0.06, avoidHeadon: 1, depth: 0 },
    hard:   { react: 99, margin: 3, retarget: 1, dawdle: 0, slip: 0, misjudge: 0, avoidHeadon: 1, depth: 2 }
  };

  /* ---------- a picture of the board for one decision ---------- */
  function readBoard(round, me) {
    var S = round.state, N = round.size, n2 = N * N;
    var wall = new Uint8Array(n2), warnT = new Int16Array(n2), portal = new Int32Array(n2).fill(-1), value = new Int8Array(n2);
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      var i = y * N + x;
      if (round.isWall(x, y) || round.lethal(x, y)) wall[i] = 1;
      warnT[i] = round.warn(x, y) || 0;
      var p = round.portalAt(x, y);
      if (p) portal[i] = p.open ? p.exit.y * N + p.exit.x : -2;
      if (round.coreAt(x, y)) value[i] = 3;
    }
    var foods = [];
    S.foods.forEach(function (f) { value[f.y * N + f.x] = 1; });
    for (var c = 0; c < n2; c++) if (value[c]) foods.push(c);
    function snake(s) { return { body: s.body.map(function (q) { return q.y * N + q.x; }), dir: s.dir, grow: s.grow, score: s.score }; }
    return {
      N: N, wall: wall, warnT: warnT, portal: portal, value: value, foods: foods,
      me: snake(S.snakes[me]), op: snake(S.snakes[1 - me]),
      timeLeft: round.timeLeft(), overtime: S.overtime
    };
  }

  function xy(B, c) { var x = c % B.N; return { x: x, y: (c - x) / B.N }; }
  function manhattan(B, a, b) { var p = xy(B, a), q = xy(B, b); return Math.abs(p.x - q.x) + Math.abs(p.y - q.y); }
  function nextCell(B, from, d) {
    var p = xy(B, from), x = p.x + d.x, y = p.y + d.y;
    if (x < 0 || y < 0 || x >= B.N || y >= B.N) return -1;
    return y * B.N + x;
  }
  function moves(dir) { return DIRS.filter(function (d) { return !(d.x === -dir.x && d.y === -dir.y); }); }
  function same(a, b) { return a && b && a.x === b.x && a.y === b.y; }

  /* Where a head moving d from `from` lands `k` ticks from now; -1 = a crash on the board itself. */
  function landing(B, from, d, k, react) {
    var c = nextCell(B, from, d);
    if (c < 0 || B.wall[c] || B.portal[c] === -2) return -1;
    if (B.portal[c] >= 0) c = B.portal[c];
    if (B.wall[c]) return -1;
    var w = B.warnT[c];
    if (w > 0 && w <= react && w <= k + 2) return -1;                   // the warning runs out while we are there
    return c;
  }

  /* One simultaneous tick on a copy, with the engine's rules. dop null = the rival is left where it is. */
  function simulate(B, me, op, dm, dop, k, react, taken) {
    var lm = landing(B, me.body[0], dm, k, react), lo = dop ? landing(B, op.body[0], dop, k, react) : -1;
    var val = function (c) { return c >= 0 && !taken[c] ? B.value[c] : 0; };
    var gm = me.grow > 0 || val(lm) > 0, go = op.grow > 0 || val(lo) > 0;
    function hits(c) {
      if (c < 0) return true;
      var nm = gm ? me.body.length : me.body.length - 1, no = go ? op.body.length : op.body.length - 1, i;
      for (i = 0; i < nm; i++) if (me.body[i] === c) return true;
      for (i = 0; i < no; i++) if (op.body[i] === c) return true;
      return false;
    }
    var deadM = hits(lm), deadO = dop ? hits(lo) : false;
    if (dop && !deadM && !deadO && lm === lo) deadM = deadO = true;
    function moved(s, l, dir) {
      var b = [l].concat(s.body), grow = s.grow, v = val(l);
      if (v === 3) grow += 2; else if (!v) { if (grow > 0) grow--; else b.pop(); }
      return { body: b, dir: dir, grow: grow, score: s.score + v };
    }
    var t2 = taken;
    if ((!deadM && val(lm)) || (!deadO && dop && val(lo))) {
      t2 = Object.assign({}, taken);
      if (!deadM && val(lm)) t2[lm] = 1;
      if (!deadO && dop && val(lo)) t2[lo] = 1;
    }
    return { me: deadM ? me : moved(me, lm, dm), op: deadO || !dop ? op : moved(op, lo, dop), deadM: deadM, deadO: deadO, taken: t2, lm: lm };
  }

  /* Steps from a head to every cell, round walls and bodies (each segment frees up as its tail passes) and
     warnings that will have run out by the time we get there. */
  function distances(B, s, other, react) {
    var N = B.N, d = new Int16Array(N * N).fill(-1), freeAt = new Int16Array(N * N);
    var i, L = s.body.length;
    for (i = 0; i < L; i++) freeAt[s.body[i]] = L - i;
    for (i = 0; i < other.body.length; i++) freeAt[other.body[i]] = Math.max(freeAt[other.body[i]], other.body.length - i);
    var q = [s.body[0]];
    d[s.body[0]] = 0;
    for (var qi = 0; qi < q.length; qi++) {
      var c = q[qi], dc = d[c];
      for (var k = 0; k < 4; k++) {
        var n = nextCell(B, c, DIRS[k]);
        if (n < 0 || B.wall[n] || B.portal[n] === -2) continue;
        if (B.portal[n] >= 0) n = B.portal[n];
        if (d[n] >= 0 || B.wall[n] || freeAt[n] > dc + 1) continue;
        var w = B.warnT[n];
        if (w > 0 && w <= react && w <= dc + 3) continue;
        d[n] = dc + 1;
        q.push(n);
      }
    }
    return d;
  }
  /* Steps to the nearest cell that is not warned (0 = already safe). Used to leave a warned zone in time. */
  function escape(B, d) {
    var best = 999;
    for (var i = 0; i < d.length; i++) if (d[i] >= 0 && d[i] < best && B.warnT[i] === 0) best = d[i];
    return best;
  }
  function area(d, cap) { var a = 0; for (var i = 0; i < d.length; i++) if (d[i] >= 0 && ++a >= cap) break; return a; }

  /* ---------- candidates: safe moves, with their room and head-on risk ---------- */
  function candidates(B, st, C, k) {
    var me = st.me, op = st.op, out = [];
    var opCells = moves(op.dir).map(function (m) { return landing(B, op.body[0], m, k, 99); }).filter(function (c) { return c >= 0; });
    moves(me.dir).forEach(function (m) {
      var nx = simulate(B, me, op, m, null, k, C.react, st.taken);
      if (nx.deadM) return;
      var D = distances(B, nx.me, op, C.react), need = me.body.length + C.margin + 1;
      var room = area(D, need + 40);
      var w = B.warnT[nx.lm], esc = w > 0 ? escape(B, D) : 0;
      out.push({ m: m, cell: nx.lm, D: D, room: room, trap: room < need, headon: opCells.indexOf(nx.lm) >= 0, warn: w, esc: esc,
                 caught: w > 0 && w <= C.react && esc + 1 >= w });             // it would still be in the zone when it fires
    });
    return out;
  }
  function filterSafe(cands, C, rng) {
    var avoidHeadon = rng() < C.avoidHeadon;
    var tiers = [
      cands.filter(function (c) { return !c.trap && !c.caught && !(avoidHeadon && c.headon); }),
      cands.filter(function (c) { return !c.trap && !c.caught; }),
      cands.filter(function (c) { return !c.trap; }),
      cands.filter(function (c) { return !(avoidHeadon && c.headon); })
    ];
    for (var i = 0; i < tiers.length; i++) if (tiers[i].length) return tiers[i];
    return cands.slice().sort(function (a, b) { return b.room - a.room; }).slice(0, 1);
  }

  /* ---------- targets ---------- */
  /* What a food is worth to us now: points, shrunk by distance and by who gets there first; with `chain`, a food
     close to another one is worth a little more, so pick-ups follow each other instead of zig-zagging. */
  function targetScores(B, st, Dme, Dop, mode) {
    var out = [];
    B.foods.forEach(function (c) {
      if (st.taken[c]) return;
      var dm = Dme[c];
      if (dm < 0) return;
      var dop = Dop[c], pts = B.value[c], contest = 1;
      if (dop >= 0) {
        if (dop < dm) contest = mode.urgent ? 0.45 : 0.18;               // the rival is nearer: most likely lost
        else if (dop === dm) contest = mode.urgent ? 0.8 : 0.5;            // a race to the same cell
      }
      var v = pts * contest / (dm + 2);
      if (mode.chain) {
        var best = 1e9;
        B.foods.forEach(function (o) { if (o !== c) { var dd = manhattan(B, c, o); if (dd < best) best = dd; } });
        if (best < 1e9) v += 0.25 / (best + 4);
      }
      out.push({ c: c, v: v, dm: dm, dop: dop });
    });
    out.sort(function (a, b) { return b.v - a.v; });
    return out;
  }

  /* ---------- easy and medium: follow a target ---------- */
  function planner(B, st, C, mem, rng, level) {
    var cands = candidates(B, st, C, 0);
    if (!cands.length) {                                              // nothing safe: at least not a wall or a body
      var open = moves(st.me.dir).filter(function (m) { var c = nextCell(B, st.me.body[0], m); return c >= 0 && !B.wall[c] && st.me.body.indexOf(c) < 0 && st.op.body.indexOf(c) < 0; });
      return open[0] || null;
    }
    var pool = filterSafe(cands, C, rng), straight = null;
    pool.forEach(function (c) { if (same(c.m, st.me.dir)) straight = c; });
    if (C.slip && rng() < C.slip) return pool[Math.floor(rng() * pool.length)].m;

    // choose (or keep) a target
    var head = st.me.body[0], t = mem.target;
    if (t != null && (!B.value[t] || mem.age >= C.retarget)) t = null;
    if (t == null) {
      if (level === 'easy') {                                         // nearest in a straight line, sometimes the second
        var byLine = B.foods.slice().sort(function (a, b) { return manhattan(B, head, a) - manhattan(B, head, b); });
        t = byLine.length > 1 && rng() < C.misjudge ? byLine[1] : byLine[0];
      } else {
        var Dme = distances(B, st.me, st.op, C.react), Dop = distances(B, st.op, st.me, C.react);
        var ts = targetScores(B, st, Dme, Dop, { urgent: false, chain: false });
        if (ts.length) t = (ts.length > 1 && rng() < C.misjudge ? ts[1] : ts[0]).c;
      }
      mem.target = t; mem.age = 0;
    }
    mem.age++;
    if (t == null) return (straight || pool.sort(function (a, b) { return b.room - a.room; })[0]).m;

    var inZone = pool.filter(function (c) { return c.warn > 0 && c.warn <= C.react; });
    if (inZone.length === pool.length && pool.length) {                  // every way is warned: take the quickest way out
      return pool.slice().sort(function (a, b) { return a.esc - b.esc || b.room - a.room; })[0].m;
    }
    var eat = pool.filter(function (c) { return c.cell === t; });
    if (eat.length) return eat[0].m;
    if (straight && C.dawdle && rng() < C.dawdle) return straight.m;
    var best = null, bestV = Infinity;
    pool.forEach(function (c) {
      var d = level === 'easy' ? manhattan(B, c.cell, t) : (c.D[t] >= 0 ? c.D[t] : 999);
      var v = d * 10 - (level === 'easy' ? 0 : Math.min(c.room, 60) * 0.05) - (c === straight ? 1 : 0);
      if (v < bestV) { bestV = v; best = c; }
    });
    return best.m;
  }

  /* ---------- hard: look ahead, points first ---------- */
  function mood(B) {
    var lead = B.me.score - B.op.score, late = B.overtime || B.timeLeft < 25000;
    return { urgent: late && lead <= 0, guard: late && lead > 0, chain: true };
  }
  function evaluate(B, st, C, M) {
    var me = st.me, op = st.op;
    var Dm = distances(B, me, op, C.react), Do = distances(B, op, me, C.react);
    var need = me.body.length + (M.guard ? C.margin + 4 : C.margin) + 1;
    var room = area(Dm, need + 40), oroom = area(Do, op.body.length + 44), v = 0;
    if (room < need) v -= (M.urgent ? 1800 : 3200) * (need - room) / need;           // boxed in
    if (oroom < op.body.length + 3) v += 900 * (op.body.length + 3 - oroom) / (op.body.length + 3);   // rival boxed in
    var hw = B.warnT[me.body[0]];
    if (hw > 0) { var e = escape(B, Dm); if (e + 1 >= hw) v -= 6000; else v -= 40 * e; }   // still in a warned zone
    var ts = targetScores(B, st, Dm, Do, M);
    if (ts.length) v += 900 * ts[0].v + (ts[1] ? 250 * ts[1].v : 0);
    v += (me.score - op.score) * 1000;                                // a point eaten always beats being near one (max 300)
    // a little territory: cells we reach first (a Voronoi split), capped so it never outweighs food
    var t = 0;
    for (var j = 0; j < Dm.length; j++) {
      if (Dm[j] < 0 && Do[j] < 0) continue;
      if (Do[j] < 0 || (Dm[j] >= 0 && Dm[j] < Do[j])) t++; else if (Dm[j] < 0 || Do[j] < Dm[j]) t--;
    }
    v += Math.max(-60, Math.min(60, t * 0.25));
    return v;
  }
  function crashValue(n) {
    if (n.deadM && n.deadO) return n.me.score > n.op.score ? -4000 : n.me.score < n.op.score ? -60000 : -30000;
    if (n.deadM) return -100000;
    if (n.deadO) return 100000;
    return null;
  }
  /* The rival's likely move: toward its best food by path. */
  function predict(B, st, C) {
    var flip = { me: st.op, op: st.me, taken: st.taken };
    var Do = distances(B, st.op, st.me, C.react), Dm = distances(B, st.me, st.op, C.react);
    var ts = targetScores(B, flip, Do, Dm, { urgent: false, chain: false });
    var goal = ts.length ? ts[0].c : -1, best = null, bestD = 1e9;
    moves(st.op.dir).forEach(function (m) {
      var l = landing(B, st.op.body[0], m, 0, C.react);
      if (l < 0 || st.me.body.indexOf(l) >= 0 || st.op.body.slice(0, -1).indexOf(l) >= 0) return;
      var dd = goal < 0 ? 0 : manhattan(B, l, goal);
      if (dd < bestD) { bestD = dd; best = m; }
    });
    return best;
  }
  function search(B, st, dm, depth, k, C, M, guess) {
    var replies = moves(st.op.dir), worst = Infinity, sum = 0, n = 0, pv = null;
    for (var r = 0; r < replies.length; r++) {
      var nx = simulate(B, st.me, st.op, dm, replies[r], k, C.react, st.taken);
      var v = crashValue(nx);
      if (v === null) {
        var child = { me: nx.me, op: nx.op, taken: nx.taken };
        if (depth <= 1) v = evaluate(B, child, C, M);
        else {
          var best = -Infinity;
          moves(nx.me.dir).forEach(function (m2) { var v2 = search(B, child, m2, depth - 1, k + 1, C, M, null); if (v2 > best) best = v2; });
          v = best;
        }
      }
      if (v < worst) worst = v;
      sum += v; n++;
      if (guess && same(replies[r], guess)) pv = v;
    }
    var avg = n ? sum / n : 0, w = M.guard ? 0.5 : M.urgent ? 0.2 : 0.35;     // how much it fears the worst reply
    return w * worst + (0.8 - w) * (pv === null ? avg : pv) + 0.2 * avg;
  }
  function hardMove(B, st, C, depth) {
    var M = mood(B);
    if (manhattan(B, st.me.body[0], st.op.body[0]) > 7) depth = Math.min(depth, 1);   // far apart: one tick is enough
    var guess = predict(B, st, C), best = null, bestV = -Infinity;
    moves(st.me.dir).forEach(function (m) {
      var v = search(B, st, m, depth, 0, C, M, guess);
      if (same(m, st.me.dir)) v += 0.5;
      if (v > bestV) { bestV = v; best = m; }
    });
    return best;
  }

  /* opts.budgetMs (the page sets it): when a decision takes longer than this on a slow device, the next ones look one
     tick ahead instead of two for a while, so the game never stutters. Without it (tests) the AI is fully deterministic. */
  function create(level, seed, opts) {
    if (LEVELS.indexOf(level) < 0) level = 'medium';
    var C = CONF[level], rng = Duel.seededRng((seed == null ? 99 : seed) ^ 0x5bd1e995);
    var budget = opts && opts.budgetMs, easeOff = 0, mem = { target: null, age: 0 };
    var stats = { decisions: 0, maxMs: 0, totalMs: 0 };
    var clock = (typeof performance !== 'undefined' && performance.now) ? function () { return performance.now(); } : function () { return Date.now(); };
    return {
      kind: 'ai', level: level, stats: stats,
      bind: function () { mem = { target: null, age: 0 }; },
      next: function (round, me) {
        var t0 = clock();
        var B = readBoard(round, me), st = { me: B.me, op: B.op, taken: {} }, choice;
        if (C.depth === 0) choice = planner(B, st, C, mem, rng, level);
        else {
          var depth = C.depth;
          if (easeOff > 0) { easeOff--; depth = 1; }
          choice = hardMove(B, st, C, depth);
        }
        var ms = clock() - t0;
        if (budget && ms > budget && C.depth > 1) easeOff = 25;
        stats.decisions++; stats.totalMs += ms; if (ms > stats.maxMs) stats.maxMs = ms;
        return choice || null;
      }
    };
  }

  return { LEVELS: LEVELS, CONF: CONF, create: create };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeDuelAI;
