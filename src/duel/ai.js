/* Grid Snake Duel: the rival (AIController)
 * The AI is just another controller: once per tick it returns a direction, and the engine checks that move
 * exactly like the player's. It moves at the same speed and plays by the same rules.
 * It reads only what the screen shows: walls, bodies, food, the Core, portals and the hazard warnings
 * (round.warn(x, y) is the countdown drawn on that cell). It never reads the round's random generator.
 *
 * Levels differ only in how well they think:
 *  easy    the nearest food by the shortest safe path; checks it will not box itself in; reacts to warnings
 *          late, and now and then makes a poor (never suicidal) choice.
 *  medium  plans with the rival's possible replies, keeps enough room to live (flood fill), weighs food it can
 *          reach first, avoids warned cells in time, takes risks only when it is behind late in the round,
 *          and steals space from the rival when that is cheap.
 *  hard    looks two ticks ahead over both snakes' moves, scores positions by territory (the cells it reaches
 *          before the rival, a Voronoi split), predicts the rival's likely move, races for food it can win,
 *          cuts the rival off, and uses the rules: when it is ahead on points, a double crash is a win for it.
 */
var SnakeDuelAI = (function () {
  'use strict';

  var node = typeof module !== 'undefined' && module.exports && typeof require === 'function';
  var Duel = node ? require('./engine.js') : SnakeDuel;
  var DIRS = Duel.DIRS;
  var LEVELS = ['easy', 'medium', 'hard'];

  var CONF = {
    easy:   { mistake: 0.07, warnSeen: 6, depth: 0 },
    medium: { mistake: 0, warnSeen: 99, depth: 1 },
    hard:   { mistake: 0, warnSeen: 99, depth: 2 }
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
    S.foods.forEach(function (f) { value[f.y * N + f.x] = 1; });
    function cells(s) { return s.body.map(function (c) { return c.y * N + c.x; }); }
    return {
      N: N, wall: wall, warnT: warnT, portal: portal, value: value,
      me: { body: cells(S.snakes[me]), dir: S.snakes[me].dir, grow: S.snakes[me].grow, score: S.snakes[me].score },
      op: { body: cells(S.snakes[1 - me]), dir: S.snakes[1 - me].dir, grow: S.snakes[1 - me].grow, score: S.snakes[1 - me].score },
      timeLeft: round.timeLeft(), overtime: S.overtime
    };
  }

  function nextCell(B, from, d) {
    var N = B.N, x = from % N + d.x, y = (from - from % N) / N + d.y;
    if (x < 0 || y < 0 || x >= N || y >= N) return -1;
    return y * N + x;
  }
  /* Where a head moving d from cell `from` ends up `k` ticks from now: -1 = crash on the board itself. */
  function landing(B, from, d, k, warnSeen) {
    var c = nextCell(B, from, d);
    if (c < 0 || B.wall[c]) return -1;
    if (B.portal[c] === -2) return -1;
    if (B.portal[c] >= 0) c = B.portal[c];
    if (B.wall[c]) return -1;
    var w = B.warnT[c];
    if (w > 0 && w <= warnSeen && w <= k + 1) return -1;               // the warning runs out as we arrive
    return c;
  }
  function moves(dir) { return DIRS.filter(function (d) { return !(d.x === -dir.x && d.y === -dir.y); }); }

  /* One simultaneous tick on a copy, with the engine's rules. Returns the new snakes and who crashed. */
  function simulate(B, me, op, dm, dop, k, warnSeen, foodsTaken) {
    var lm = landing(B, me.body[0], dm, k, warnSeen), lo = landing(B, op.body[0], dop, k, warnSeen);
    var val = function (c) { return c >= 0 && !foodsTaken[c] ? B.value[c] : 0; };
    var gm = me.grow > 0 || val(lm) > 0, go = op.grow > 0 || val(lo) > 0;
    function hits(c) {
      if (c < 0) return true;
      var nm = gm ? me.body.length : me.body.length - 1, no = go ? op.body.length : op.body.length - 1, i;
      for (i = 0; i < nm; i++) if (me.body[i] === c) return true;
      for (i = 0; i < no; i++) if (op.body[i] === c) return true;
      return false;
    }
    var deadM = hits(lm), deadO = hits(lo);
    if (!deadM && !deadO && lm === lo) deadM = deadO = true;
    function moved(s, l, g, dir) {
      var b = [l].concat(s.body);
      var grow = s.grow;
      if (val(l) > 0) grow += val(l) === 3 ? 2 : 0; else if (grow > 0) grow--; else b.pop();
      return { body: b, dir: dir, grow: grow, score: s.score + val(l) };
    }
    var taken = foodsTaken;
    var nm2 = deadM ? me : moved(me, lm, gm, dm), no2 = deadO ? op : moved(op, lo, go, dop);
    if ((!deadM && val(lm)) || (!deadO && val(lo))) {
      taken = Object.assign({}, foodsTaken);
      if (!deadM && val(lm)) taken[lm] = 1;
      if (!deadO && val(lo)) taken[lo] = 1;
    }
    return { me: nm2, op: no2, deadM: deadM, deadO: deadO, taken: taken };
  }

  /* Breadth-first distances from a head, round walls, bodies (each segment frees up as the tail passes) and
     warnings that will have run out by the time we get there. */
  function distances(B, s, other, warnSeen) {
    var N = B.N, d = new Int16Array(N * N).fill(-1), freeAt = new Int16Array(N * N);
    var i, L = s.body.length;
    for (i = 0; i < L; i++) freeAt[s.body[i]] = L - i;                 // own segment i frees after L-i ticks
    for (i = 0; i < other.body.length; i++) freeAt[other.body[i]] = Math.max(freeAt[other.body[i]], other.body.length - i);
    var q = [s.body[0]], qi = 0;
    d[s.body[0]] = 0;
    while (qi < q.length) {
      var c = q[qi++], dc = d[c];
      for (var k = 0; k < 4; k++) {
        var n = nextCell(B, c, DIRS[k]);
        if (n < 0 || B.wall[n] || d[n] >= 0 || B.portal[n] === -2) continue;
        if (B.portal[n] >= 0) { n = B.portal[n]; if (d[n] >= 0 || B.wall[n]) continue; }
        if (freeAt[n] > dc + 1) continue;
        var w = B.warnT[n];
        if (w > 0 && w <= warnSeen && w <= dc + 2) continue;
        d[n] = dc + 1;
        q.push(n);
      }
    }
    return d;
  }
  function area(d, cap) { var a = 0; for (var i = 0; i < d.length; i++) if (d[i] >= 0) { a++; if (a >= cap) break; } return a; }

  /* Positional value for `me` (higher is better). */
  function evaluate(B, st, C, deep) {
    var me = st.me, op = st.op;
    var dm = distances(B, me, op, C.warnSeen), dop = distances(B, op, me, C.warnSeen);
    var len = me.body.length, room = area(dm, 220), v = 0;
    var urge = (B.timeLeft < 20000 || B.overtime) && me.score <= op.score ? 2.2 : 1;   // behind and running out of time
    if (room < len + 3) v -= 4000 * (len + 3 - room) / (len + 3);       // boxed in: about to die
    var oroom = area(dop, 220);
    if (oroom < op.body.length + 3) v += 1500 * (op.body.length + 3 - oroom) / (op.body.length + 3);
    // food: what we reach first is worth its points, shrinking with distance
    for (var c = 0; c < B.value.length; c++) {
      var pts = st.taken[c] ? 0 : B.value[c];
      if (!pts || dm[c] < 0) continue;
      var mine = dop[c] < 0 || dm[c] < dop[c] || (dm[c] === dop[c] && me.score <= op.score);
      v += (mine ? 90 : 18) * urge * pts / (dm[c] + 1);
    }
    if (deep) {                                                       // territory: cells we reach before the rival
      var t = 0;
      for (var j = 0; j < dm.length; j++) {
        if (dm[j] < 0 && dop[j] < 0) continue;
        if (dop[j] < 0 || (dm[j] >= 0 && dm[j] < dop[j])) t++;
        else if (dm[j] < 0 || dop[j] < dm[j]) t--;
      }
      v += t * 2.2;
    } else {
      v += Math.min(room, 120) * 0.6 - Math.min(oroom, 120) * 0.25;
    }
    v += (me.score - op.score) * 160;
    return v;
  }

  /* The outcome of a crash, by the round's rules. */
  function crashValue(st, scoreMe, scoreOp) {
    if (st.deadM && st.deadO) return scoreMe > scoreOp ? -5000 : scoreMe < scoreOp ? -60000 : -30000;   // even ahead it is a last resort, not a plan
    if (st.deadM) return -100000;
    if (st.deadO) return 100000;
    return null;
  }

  /* Likely rival move: toward its nearest food by the shortest safe way (what a sensible player does). */
  function predict(B, st, C) {
    var op = st.op, best = null, bestD = 1e9;
    var d = distances(B, op, st.me, C.warnSeen), goal = -1, gd = 1e9;
    for (var c = 0; c < B.value.length; c++) if (B.value[c] && !st.taken[c] && d[c] >= 0 && d[c] < gd) { gd = d[c]; goal = c; }
    moves(op.dir).forEach(function (m) {
      var l = landing(B, op.body[0], m, 0, C.warnSeen);
      if (l < 0) return;
      var dd = goal < 0 ? 0 : Math.abs(l % B.N - goal % B.N) + Math.abs((l - l % B.N) / B.N - (goal - goal % B.N) / B.N);
      if (dd < bestD) { bestD = dd; best = m; }
    });
    return best;
  }

  /* Value of `me` choosing dm now, searching `depth` simultaneous ticks. Worst case over the rival's replies,
     blended with the reply we predict, so the AI is careful but not frozen by fear. */
  function search(B, st, dm, depth, k, C, guess) {
    var replies = moves(st.op.dir), worst = Infinity, sum = 0, n = 0, pv = null;
    for (var r = 0; r < replies.length; r++) {
      var nx = simulate(B, st.me, st.op, dm, replies[r], k, C.warnSeen, st.taken);
      var cv = crashValue(nx, nx.me.score, nx.op.score), v;
      if (cv !== null) v = cv;
      else if (depth <= 1) v = evaluate(B, { me: nx.me, op: nx.op, taken: nx.taken }, C, C.depth >= 2);
      else {
        var best = -Infinity, child = { me: nx.me, op: nx.op, taken: nx.taken };
        moves(nx.me.dir).forEach(function (m2) { var v2 = search(B, child, m2, depth - 1, k + 1, C, null); if (v2 > best) best = v2; });
        v = best;
      }
      if (v < worst) worst = v;
      sum += v; n++;
      if (guess && replies[r].x === guess.x && replies[r].y === guess.y) pv = v;
    }
    var avg = n ? sum / n : 0;
    return 0.6 * worst + 0.25 * (pv === null ? avg : pv) + 0.15 * avg;
  }

  /* Easy: shortest safe path to the nearest food, with a basic "do not box yourself in" check. */
  function easyMove(B, st, C, rng) {
    var safe = moves(st.me.dir).filter(function (m) {
      var nx = simulate(B, st.me, st.op, m, st.op.dir, 0, C.warnSeen, st.taken);
      return !nx.deadM;
    });
    if (!safe.length) {                                               // nothing looks safe: at least not a wall or a body
      var open = moves(st.me.dir).filter(function (m) { var c = nextCell(B, st.me.body[0], m); return c >= 0 && !B.wall[c] && st.me.body.indexOf(c) < 0 && st.op.body.indexOf(c) < 0; });
      return open.length ? open[0] : null;
    }
    var roomy = safe.filter(function (m) {
      var nx = simulate(B, st.me, st.op, m, st.op.dir, 0, C.warnSeen, st.taken);
      return area(distances(B, nx.me, nx.op, C.warnSeen), st.me.body.length + 2) > st.me.body.length;
    });
    var pool = roomy.length ? roomy : safe;
    if (rng() < C.mistake) return pool[Math.floor(rng() * pool.length)];
    var best = null, bestD = Infinity;                                // no food in reach still picks a move
    pool.forEach(function (m) {
      var nx = simulate(B, st.me, st.op, m, st.op.dir, 0, C.warnSeen, st.taken);
      if (nx.me.score > st.me.score) { bestD = -1; best = m; return; }
      var d = distances(B, nx.me, nx.op, C.warnSeen), dd = 1e9;
      for (var c = 0; c < B.value.length; c++) if (B.value[c] && d[c] >= 0 && d[c] < dd) dd = d[c];
      if (dd < bestD || (dd === bestD && m.x === st.me.dir.x && m.y === st.me.dir.y)) { bestD = dd; best = m; }
    });
    return best;
  }

  /* opts.budgetMs (the page sets it): when a decision takes longer than this on a slow device, the next ones look one
     tick ahead instead of two for a while, so the game never stutters. Without it (tests) the AI is fully deterministic. */
  function create(level, seed, opts) {
    if (LEVELS.indexOf(level) < 0) level = 'medium';
    var budget = opts && opts.budgetMs, easeOff = 0;
    var C = CONF[level], rng = Duel.seededRng((seed == null ? 99 : seed) ^ 0x5bd1e995);
    var stats = { decisions: 0, maxMs: 0, totalMs: 0 };
    var clock = (typeof performance !== 'undefined' && performance.now) ? function () { return performance.now(); } : function () { return Date.now(); };
    return {
      kind: 'ai', level: level, stats: stats,
      bind: function () {},
      next: function (round, me) {
        var t0 = clock();
        var B = readBoard(round, me), st = { me: B.me, op: B.op, taken: {} }, choice;
        if (C.depth === 0) choice = easyMove(B, st, C, rng);
        else {
          var best = -Infinity, guess = predict(B, st, C), depth = C.depth;
          if (easeOff > 0) { easeOff--; depth = 1; }
          moves(st.me.dir).forEach(function (m) {
            var v = search(B, st, m, depth, 0, C, guess);
            if (m.x === st.me.dir.x && m.y === st.me.dir.y) v += 0.5;  // ties: keep going straight
            if (v > best) { best = v; choice = m; }
          });
        }
        var ms = clock() - t0;
        if (budget && ms > budget && C.depth > 1) easeOff = 25;
        stats.decisions++; stats.totalMs += ms; if (ms > stats.maxMs) stats.maxMs = ms; if (ms > 8) stats.slow = (stats.slow || 0) + 1;
        return choice || null;
      }
    };
  }

  return { LEVELS: LEVELS, CONF: CONF, create: create };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeDuelAI;
