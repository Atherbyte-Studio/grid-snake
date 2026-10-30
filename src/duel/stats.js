/* Grid Snake Duel: local statistics
 * Kept under their own key, apart from the game's profile, so nothing else is ever overwritten. The key
 * starts with "gridsnake-", so on the website it travels with the signed-in account's data on this device
 * like the rest of the game's local data (it is not uploaded). Storage is injected; anything unreadable or
 * odd in it is replaced with clean numbers instead of breaking the game.
 */
var SnakeDuelStats = (function () {
  'use strict';

  var KEY = 'gridsnake-duel-stats-v1';
  var LEVELS = ['easy', 'medium', 'hard'];

  function count(v) { return typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : 0; }
  function blank() {
    return { played: 0, won: 0, lost: 0, drawn: 0, roundsWon: 0, roundsLost: 0, roundsDrawn: 0,
             streak: 0, bestStreak: 0, winsBy: { easy: 0, medium: 0, hard: 0 }, points: 0, cores: 0 };
  }
  function sanitize(d) {
    var out = blank();
    if (!d || typeof d !== 'object') return out;
    ['played', 'won', 'lost', 'drawn', 'roundsWon', 'roundsLost', 'roundsDrawn', 'streak', 'bestStreak', 'points', 'cores'].forEach(function (k) { out[k] = count(d[k]); });
    if (d.winsBy && typeof d.winsBy === 'object') LEVELS.forEach(function (l) { out.winsBy[l] = count(d.winsBy[l]); });
    if (out.bestStreak < out.streak) out.bestStreak = out.streak;
    return out;
  }

  function create(storage) {
    var mem = null, data;
    function read() { try { var v = storage && storage.getItem(KEY); if (v !== null && v !== undefined) return v; } catch (e) {} return mem; }
    function write() {
      var text = JSON.stringify(data);
      mem = text;
      try { if (storage) storage.setItem(KEY, text); } catch (e) {}
    }
    try { data = sanitize(JSON.parse(read())); } catch (e) { data = blank(); }

    /* results: SnakeDuelMatch results(). The human is side 0. An abandoned match is not counted. */
    function recordMatch(results, extra) {
      if (!results || results.winner === null || results.winner === undefined) return false;
      data.played++;
      if (results.winner === 0) {
        data.won++; data.streak++;
        if (data.streak > data.bestStreak) data.bestStreak = data.streak;
        if (LEVELS.indexOf(results.difficulty) >= 0) data.winsBy[results.difficulty]++;
      } else if (results.winner === 1) { data.lost++; data.streak = 0; }
      else { data.drawn++; data.streak = 0; }
      (results.rounds || []).forEach(function (r) {
        if (r.draw) data.roundsDrawn++; else if (r.winner === 0) data.roundsWon++; else data.roundsLost++;
        data.points += count(r.scores && r.scores[0]);
      });
      data.cores += count(extra && extra.cores);
      write();
      return true;
    }
    function get() { return JSON.parse(JSON.stringify(data)); }
    function reset() { data = blank(); write(); }

    return { recordMatch: recordMatch, get: get, reset: reset };
  }

  return { KEY: KEY, create: create, sanitize: sanitize };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeDuelStats;
