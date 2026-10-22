/* Grid Snake achievements
 * Pure rules, no DOM and no storage. Every achievement is a CHAIN of tiers: finish one goal, collect its
 * coins, and the next, bigger goal starts again from zero. A chain's state is { tier, progress }:
 *   kind "sum"  counts things over many runs ("eat 25 apples"); progress restarts at 0 on each new tier.
 *   kind "run"  needs one single run to reach a value ("score 50 in one run"); progress is the best run
 *               value so far for the current tier.
 * When the last tier is done the chain is complete.
 */
var SnakeAchievements = (function () {
  'use strict';

  function tiers(goals, rewards) { return goals.map(function (g, i) { return { goal: g, reward: rewards[i] }; }); }

  var CHAINS = [
    { id: 'apples',   group: 'Food',      kind: 'sum', metric: 'foods',   name: 'Apple Eater',      text: 'Eat {n} foods.',                tiers: tiers([25, 100, 250, 500, 1000, 2500], [20, 40, 80, 150, 250, 500]) },
    { id: 'golden',   group: 'Food',      kind: 'sum', metric: 'golden',  name: 'Gold Digger',      text: 'Eat {n} golden apples.', one: 'Eat a golden apple.',        tiers: tiers([1, 5, 15, 40, 100], [20, 40, 100, 200, 400]) },
    { id: 'bonus',    group: 'Power-ups', kind: 'sum', metric: 'bonus',   name: 'Bonus Hunter',     text: 'Collect {n} Bonus Foods.',      tiers: tiers([5, 20, 60, 150], [20, 50, 120, 300]) },
    { id: 'shields',  group: 'Power-ups', kind: 'sum', metric: 'shields', name: 'Shield Bearer',    text: 'Survive {n} crashes with a Shield.', one: 'Survive a crash with a Shield.', tiers: tiers([1, 5, 20, 60], [20, 50, 120, 300]) },
    { id: 'runs',     group: 'Play',      kind: 'sum', metric: 'runs',    name: 'Regular',          text: 'Finish {n} runs.',              tiers: tiers([3, 10, 30, 100, 300], [15, 30, 80, 200, 500]) },
    { id: 'score',    group: 'Score',     kind: 'run', metric: 'score',   name: 'High Roller',      text: 'Score {n} points in one run.',  tiers: tiers([10, 25, 50, 100, 200], [15, 30, 60, 120, 250]) },
    { id: 'length',   group: 'Score',     kind: 'run', metric: 'length',  name: 'Long One',         text: 'Reach a length of {n}.',        tiers: tiers([10, 20, 35, 60], [15, 40, 90, 200]) },
    { id: 'level',    group: 'Score',     kind: 'run', metric: 'level',   name: 'Climber',          text: 'Reach level {n}.',              tiers: tiers([3, 5, 8, 12], [15, 40, 90, 200]) },
    { id: 'clock',    group: 'Modes',     kind: 'run', metric: 'taScore', name: 'Clock Beater',     text: 'Score {n} points in one Time Attack run.', tiers: tiers([15, 30, 50, 80], [20, 50, 110, 250]) },
    { id: 'survivor', group: 'Modes',     kind: 'run', metric: 'survSec', name: 'Survivor',         text: 'Last {n} seconds in Survival.', tiers: tiers([30, 90, 180, 300], [20, 50, 110, 250]) },
    { id: 'slips',    group: 'Apple Run', kind: 'sum', metric: 'slips',   name: 'Banana Trouble',   text: 'Make the snake slip {n} times.', tiers: tiers([3, 15, 50, 150], [20, 50, 120, 300]) },
    { id: 'fooled',   group: 'Apple Run', kind: 'sum', metric: 'fooled',  name: 'Master of Disguise', text: 'Fool the snake with a decoy {n} times.', tiers: tiers([2, 10, 30, 100], [20, 50, 120, 300]) },
    { id: 'steel',    group: 'Apple Run', kind: 'run', metric: 'chaseSec', name: 'Apple of Steel',  text: 'Survive {n} seconds in one Apple Run.', tiers: tiers([30, 60, 120, 240], [20, 50, 120, 280]) },
    { id: 'fleeing',  group: 'Apple Run', kind: 'sum', metric: 'chaseTotal', name: 'Fleeing Fruit', text: 'Run for {n} seconds in total in Apple Run.', tiers: tiers([60, 300, 900, 3600], [20, 60, 150, 400]) }
  ];

  function byId(id) {
    for (var i = 0; i < CHAINS.length; i++) if (CHAINS[i].id === id) return CHAINS[i];
    return null;
  }
  function num(v) { return typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : 0; }
  function clean(chain, st) {                                // a safe { tier, progress } whatever was stored
    var t = Math.min(chain.tiers.length, num(st && st.tier));
    return { tier: t, progress: t >= chain.tiers.length ? 0 : num(st && st.progress) };
  }
  function done(chain, st) { return clean(chain, st).tier >= chain.tiers.length; }
  function describe(chain, tierIndex) {
    var g = chain.tiers[tierIndex].goal;
    return g === 1 && chain.one ? chain.one : chain.text.replace('{n}', String(g));
  }

  /* Move a chain forward. `value` is an amount to add (sum) or this run's value (run).
     Returns the new state and the tiers that were completed by this change (each with its reward). */
  function advance(chain, st, value) {
    var s = clean(chain, st), finished = [], v = num(value);
    if (s.tier >= chain.tiers.length || !v) return { state: s, finished: finished };
    if (chain.kind === 'sum') s.progress += v; else s.progress = Math.max(s.progress, v);
    while (s.tier < chain.tiers.length && s.progress >= chain.tiers[s.tier].goal) {
      var t = chain.tiers[s.tier];
      finished.push({ chain: chain.id, name: chain.name, tier: s.tier + 1, of: chain.tiers.length, goal: t.goal, reward: t.reward, desc: describe(chain, s.tier) });
      s.progress = chain.kind === 'sum' ? s.progress - t.goal : v;   // a new tier starts again from zero (run goals keep this run's value)
      s.tier++;
    }
    if (s.tier >= chain.tiers.length) s.progress = 0;
    return { state: s, finished: finished };
  }

  /* What the list shows for a chain right now. */
  function view(chain, st) {
    var s = clean(chain, st), isDone = s.tier >= chain.tiers.length, cur = isDone ? null : chain.tiers[s.tier];
    return {
      id: chain.id, name: chain.name, group: chain.group, kind: chain.kind,
      tier: isDone ? chain.tiers.length : s.tier + 1, of: chain.tiers.length, complete: isDone,
      goal: cur ? cur.goal : 0, progress: cur ? Math.min(s.progress, cur.goal) : 0, reward: cur ? cur.reward : 0,
      desc: isDone ? 'All tiers complete.' : describe(chain, s.tier)
    };
  }
  function completedTiers(map) {
    var n = 0;
    CHAINS.forEach(function (c) { n += clean(c, map && map[c.id]).tier; });
    return n;
  }
  function totalTiers() { return CHAINS.reduce(function (n, c) { return n + c.tiers.length; }, 0); }

  return { CHAINS: CHAINS, byId: byId, advance: advance, view: view, clean: clean, done: done, completedTiers: completedTiers, totalTiers: totalTiers };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeAchievements;
