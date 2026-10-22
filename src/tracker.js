/* Grid Snake tracker
 * The only glue between a running game and the saved profile: it listens to engine events,
 * keeps lifetime totals and best scores, moves achievement chains forward and pays coins.
 * No DOM; the page passes hooks (onUnlock, onBest) to react visually. Call tick() now and then so
 * time-based goals (Survival, Apple Run) are seen even when no event happens.
 */
var SnakeTracker = (function () {
  'use strict';

  var Achievements = (typeof module !== 'undefined' && module.exports && typeof require === 'function')
    ? require('./achievements.js') : SnakeAchievements;

  var COINS = { perPoint: 1 };   // the shop currency: one coin per point when a run ends, plus each achievement's reward

  /* The value of each "single run" metric, read from the engine snapshot. */
  var RUN_VALUE = {
    score:    function (r) { return r.score; },
    length:   function (r) { return r.maxLength || r.length; },
    level:    function (r) { return r.level; },
    taScore:  function (r) { return r.mode === 'timeattack' ? r.score : 0; },
    survSec:  function (r) { return r.mode === 'survival' ? Math.floor((r.elapsed || 0) / 1000) : 0; },
    chaseSec: function (r) { return r.mode === 'chase' ? Math.floor((r.elapsed || 0) / 1000) : 0; }
  };

  function attach(game, profile, hooks) {
    hooks = hooks || {};
    var info = { best: profile.getBest(game.mode, game.edge, game.golden), newBest: false, unlocked: [], coins: 0 };
    var lastChaseSec = 0;

    function finish(chain, res) {
      var was = profile.getAch(chain.id);
      if (res.state.tier !== was.tier || res.state.progress !== was.progress) profile.setAch(chain.id, res.state);   // no needless saves
      res.finished.forEach(function (f) {
        profile.addCoins(f.reward); info.coins += f.reward;
        info.unlocked.push(f);
        if (hooks.onUnlock) hooks.onUnlock(f);
      });
    }
    function bump(metric, n) {                                 // "sum" goals: add to every chain that counts this metric
      Achievements.CHAINS.forEach(function (c) {
        if (c.kind !== 'sum' || c.metric !== metric) return;
        finish(c, Achievements.advance(c, profile.getAch(c.id), n));
      });
    }
    function check() {
      var r = game.snapshot();
      Achievements.CHAINS.forEach(function (c) {
        if (c.kind !== 'run') return;
        var v = RUN_VALUE[c.metric] ? RUN_VALUE[c.metric](r) : 0;
        if (v > 0) finish(c, Achievements.advance(c, profile.getAch(c.id), v));
      });
      if (r.mode === 'chase') {                                // seconds run in total, counted as they pass
        var sec = Math.floor((r.elapsed || 0) / 1000);
        if (sec > lastChaseSec) { var d = sec - lastChaseSec; lastChaseSec = sec; bump('chaseTotal', d); }
      }
    }
    function bumpBest() {
      var score = game.state.score;
      if (score <= info.best) return;
      info.best = score;
      info.newBest = true;
      profile.setBest(game.mode, game.edge, score, game.golden);
      if (hooks.onBest) hooks.onBest(score);
    }

    game.on(function (e) {
      if (e.type === 'food') {
        profile.addTotal('foods', 1);
        bump('foods', 1); bumpBest(); check();
      } else if (e.type === 'pickup') {
        if (e.kind === 'bonus') { profile.addTotal('bonus', 1); bump('bonus', 1); bumpBest(); }
        check();
      } else if (e.type === 'score') {
        bumpBest();                                            // Apple Run scores as time passes
        check();
      } else if (e.type === 'gold') {
        bump('golden', 1); bumpBest(); check();
      } else if (e.type === 'shield') {
        bump('shields', 1); check();
      } else if (e.type === 'slip') {
        bump('slips', 1); check();
      } else if (e.type === 'fooled') {
        bump('fooled', 1); check();
      } else if (e.type === 'level') {
        check();
      } else if (e.type === 'over') {
        profile.addTotal('runs', 1);
        var won = Math.max(0, Math.floor(game.state.score)) * COINS.perPoint;
        profile.addCoins(won); info.coins += won;
        bumpBest();
        bump('runs', 1);
        check();
      }
    });

    return { info: info, tick: check };
  }

  return { attach: attach, COINS: COINS };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeTracker;
