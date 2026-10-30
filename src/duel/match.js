/* Grid Snake Duel: the match (MatchManager)
 * Best of three: the first side to win two rounds wins. A drawn round gives nobody a point and is played
 * again (a fresh round, new arena and event). After maxDraws drawn rounds the match is settled: more round
 * wins, then more total points, else the match is a draw. So a match always ends, in at most 6 rounds.
 * Each round gets its own arena, event and seed from the match seed. No DOM.
 */
var SnakeDuelMatch = (function () {
  'use strict';

  var node = typeof module !== 'undefined' && module.exports && typeof require === 'function';
  var Duel = node ? require('./engine.js') : SnakeDuel;
  var Maps = node ? require('./maps.js') : SnakeDuelMaps;
  var Events = node ? require('./events.js') : SnakeDuelEvents;

  var RULES = { winsNeeded: 2, maxDraws: 3 };
  var MAX_ROUNDS = RULES.winsNeeded * 2 - 1 + RULES.maxDraws;

  function create(opts) {
    opts = opts || {};
    var seed = (opts.seed == null ? Math.floor(Math.random() * 4294967296) : opts.seed) >>> 0;
    var rng = Duel.seededRng(seed);
    var maps = Maps.ids.slice();
    for (var i = maps.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)), t = maps[i]; maps[i] = maps[j]; maps[j] = t; }
    var events = Events.order(rng, MAX_ROUNDS);
    var seeds = [];
    for (var k = 0; k < MAX_ROUNDS; k++) seeds.push(Math.floor(rng() * 4294967296) >>> 0);

    var M = {
      seed: seed, difficulty: opts.difficulty || 'medium',
      phase: 'ready', wins: [0, 0], draws: 0, totals: [0, 0], rounds: [], current: null,
      winner: null, settledBy: null
    };

    /* The next round. controllers: [player, rival] for this round (fresh ones each round). */
    function nextRound(controllers, extra) {
      if (M.phase === 'over') return null;
      var n = M.rounds.length;
      var spec = { number: n + 1, map: maps[n % maps.length], event: events[n], seed: seeds[n] };
      var round = Duel.createRound(Object.assign({ map: spec.map, event: spec.event, seed: spec.seed, controllers: controllers }, extra || {}));
      M.current = { spec: spec, round: round };
      M.phase = 'round';
      return round;
    }

    /* Book a finished round. Returns the match phase afterwards ('between' or 'over'). */
    function record(result) {
      if (!M.current || M.phase !== 'round') return M.phase;
      var spec = M.current.spec;
      M.rounds.push({ number: spec.number, map: spec.map, event: spec.event, winner: result.winner, draw: result.draw,
                      reason: result.reason, scores: result.scores.slice(), overtime: !!result.overtime });
      M.totals[0] += result.scores[0]; M.totals[1] += result.scores[1];
      if (result.draw) M.draws++; else M.wins[result.winner]++;
      M.current = null;
      if (M.wins[0] >= RULES.winsNeeded || M.wins[1] >= RULES.winsNeeded) {
        settle(M.wins[0] > M.wins[1] ? 0 : 1, 'rounds');
      } else if (M.draws >= RULES.maxDraws || M.rounds.length >= MAX_ROUNDS) {
        if (M.wins[0] !== M.wins[1]) settle(M.wins[0] > M.wins[1] ? 0 : 1, 'rounds');
        else if (M.totals[0] !== M.totals[1]) settle(M.totals[0] > M.totals[1] ? 0 : 1, 'points');
        else settle(-1, 'draw');
      } else {
        M.phase = 'between';
      }
      return M.phase;
    }
    function settle(winner, by) { M.phase = 'over'; M.winner = winner; M.settledBy = by; }

    /* Leaving mid-match: the match ends with no winner and is not counted as played. */
    function abandon() { if (M.phase !== 'over') { M.phase = 'over'; M.winner = null; M.settledBy = 'abandoned'; M.current = null; } }

    function results() {
      return { winner: M.winner, settledBy: M.settledBy, wins: M.wins.slice(), totals: M.totals.slice(), draws: M.draws,
               rounds: M.rounds.map(function (r) { return Object.assign({}, r, { scores: r.scores.slice() }); }),
               difficulty: M.difficulty, seed: M.seed };
    }

    function upcoming() { var n = M.rounds.length; return { number: n + 1, map: maps[n % maps.length], event: events[n] }; }

    return { state: M, nextRound: nextRound, record: record, abandon: abandon, results: results, upcoming: upcoming };
  }

  return { RULES: RULES, MAX_ROUNDS: MAX_ROUNDS, create: create };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeDuelMatch;
