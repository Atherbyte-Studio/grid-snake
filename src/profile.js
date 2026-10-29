/* Grid Snake profile
 * Everything that must survive between sessions: preferences, lifetime totals, unlocked
 * achievements and best scores. No DOM. Storage is injected (localStorage in the page, a fake in tests).
 * A failing or missing storage never breaks the game: values are mirrored in memory.
 */
var SnakeProfile = (function () {
  'use strict';

  var KEY = 'gridsnake-profile-v2';
  var EDGES = ['walls', 'wrap'];
  var MOTIONS = ['auto', 'on', 'off'];
  var DIFFS = ['auto', 'easy', 'normal', 'hard'];          // auto: easy on a touch screen, hard (the original) elsewhere
  var CONTROLS = ['auto', 'turn', 'arrows', 'swipe'];      // auto: two turn buttons on a touch screen

  function create(storage, opts) {
    opts = opts || {};
    var modes = opts.modes || ['classic'];
    var ids = opts.achievementIds || [];
    var skins = opts.skins || ['emerald'];
    /* Looks only: each is one of a fixed list, the first being the default. */
    var LOOKS = { skin: skins, style: opts.styles || ['solid'], board: opts.boards || ['midnight'], food: opts.foods || ['dot'] };
    var LOOK_KEYS = Object.keys(LOOKS);
    var premium = opts.premium || [];            // shop items such as 'skin:jordan': usable only once bought
    function allowed(k, id, owned) { return premium.indexOf(k + ':' + id) < 0 || !!owned[k + ':' + id]; }
    var now = opts.now || function () { return Date.now(); };
    var mem = {};

    function read(key) {
      try {
        var v = storage && storage.getItem(key);
        if (v !== null && v !== undefined) return v;
      } catch (e) {}
      return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null;
    }
    function write(key, value) {
      mem[key] = value;
      try { if (storage) storage.setItem(key, value); } catch (e) {}
    }
    function cleanName(v) {                                   // a short display name, safe to show anywhere
      if (typeof v !== 'string') return '';
      var t = v.replace(/[\u0000-\u001f\u007f<>&"]/g, '').replace(/\s+/g, ' ').trim();
      return Array.from(t).slice(0, 16).join('').trim();
    }
    function count(v) { return typeof v === 'number' && isFinite(v) && v > 0 ? Math.floor(v) : 0; }

    function sanitize(d) {
      var out = { prefs: { mode: modes[0], edge: 'walls', skin: skins[0], style: LOOKS.style[0], board: LOOKS.board[0], food: LOOKS.food[0], golden: false, sound: true, volume: 1, haptics: true, motion: 'auto', difficulty: 'auto', controls: 'auto' }, totals: { foods: 0, bonus: 0, runs: 0 }, ach: {}, coins: 0, owned: {}, name: '', savedAt: 0 };
      if (!d || typeof d !== 'object') return out;
      if (d.prefs && modes.indexOf(d.prefs.mode) >= 0) out.prefs.mode = d.prefs.mode;
      if (d.prefs && EDGES.indexOf(d.prefs.edge) >= 0) out.prefs.edge = d.prefs.edge;
      if (d.coins !== undefined) out.coins = count(d.coins);
      if (d.owned && typeof d.owned === 'object') premium.forEach(function (id) { if (d.owned[id] === true) out.owned[id] = true; });
      LOOK_KEYS.forEach(function (k) { if (d.prefs && LOOKS[k].indexOf(d.prefs[k]) >= 0 && allowed(k, d.prefs[k], out.owned)) out.prefs[k] = d.prefs[k]; });
      if (d.prefs && d.prefs.golden === true) out.prefs.golden = true;
      if (d.prefs && d.prefs.sound === false) out.prefs.sound = false;
      if (d.prefs && typeof d.prefs.volume === 'number' && d.prefs.volume >= 0 && d.prefs.volume <= 1) out.prefs.volume = Math.round(d.prefs.volume * 20) / 20;
      if (d.prefs && d.prefs.haptics === false) out.prefs.haptics = false;
      if (d.prefs && MOTIONS.indexOf(d.prefs.motion) >= 0) out.prefs.motion = d.prefs.motion;
      if (d.prefs && DIFFS.indexOf(d.prefs.difficulty) >= 0) out.prefs.difficulty = d.prefs.difficulty;
      if (d.prefs && CONTROLS.indexOf(d.prefs.controls) >= 0) out.prefs.controls = d.prefs.controls;
      if (d.totals && typeof d.totals === 'object') {
        out.totals.foods = count(d.totals.foods);
        out.totals.bonus = count(d.totals.bonus);
        out.totals.runs = count(d.totals.runs);
      }
      if (d.ach && typeof d.ach === 'object') {              // achievement chains: { tier, progress } per id
        ids.forEach(function (id) {
          var a = d.ach[id];
          if (a && typeof a === 'object') out.ach[id] = { tier: Math.min(99, count(a.tier)), progress: count(a.progress) };
        });
      }
      out.name = cleanName(d.name);
      out.savedAt = count(d.savedAt);
      return out;
    }

    var data;
    try { data = sanitize(JSON.parse(read(KEY))); } catch (e) { data = sanitize(null); }

    var listeners = [];
    function save() {
      data.savedAt = now();
      write(KEY, JSON.stringify(data));
      listeners.forEach(function (fn) { try { fn(); } catch (e) {} });
    }
    function allBestKeys() {
      var keys = [];
      modes.forEach(function (m) { EDGES.forEach(function (e) { [false, true].forEach(function (g) { keys.push(bestKey(m, e, g)); }); }); });
      return keys;
    }
    function b64(str) {
      if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64');
      return btoa(unescape(encodeURIComponent(str)));
    }
    function unb64(str) {
      if (typeof Buffer !== 'undefined') return Buffer.from(str, 'base64').toString('utf8');
      return decodeURIComponent(escape(atob(str)));
    }

    /* Best scores keep their older key for Classic, so a score set before modes existed is still there. */
    function bestKey(mode, edge, golden) {
      var k = mode === 'classic' ? 'gridsnake-best-' + edge : 'gridsnake-best-' + mode + '-' + edge;
      return golden ? k + '-golden' : k;      // golden apples add points, so those scores are kept apart
    }
    function getBest(mode, edge, golden) {
      var n = parseInt(read(bestKey(mode, edge, golden)), 10);
      return n > 0 ? n : 0;
    }
    function setBest(mode, edge, value, golden) {
      if (!(value > getBest(mode, edge, golden))) return false;
      write(bestKey(mode, edge, golden), String(Math.floor(value)));
      return true;
    }

    return {
      getPrefs: function () { var o = {}; Object.keys(data.prefs).forEach(function (k) { o[k] = data.prefs[k]; }); return o; },
      setPrefs: function (p) {
        if (p && modes.indexOf(p.mode) >= 0) data.prefs.mode = p.mode;
        if (p && EDGES.indexOf(p.edge) >= 0) data.prefs.edge = p.edge;
        LOOK_KEYS.forEach(function (k) { if (p && LOOKS[k].indexOf(p[k]) >= 0 && allowed(k, p[k], data.owned)) data.prefs[k] = p[k]; });
        if (p && typeof p.golden === 'boolean') data.prefs.golden = p.golden;
        if (p && typeof p.sound === 'boolean') data.prefs.sound = p.sound;
        if (p && typeof p.volume === 'number' && p.volume >= 0 && p.volume <= 1) data.prefs.volume = Math.round(p.volume * 20) / 20;
        if (p && typeof p.haptics === 'boolean') data.prefs.haptics = p.haptics;
        if (p && MOTIONS.indexOf(p.motion) >= 0) data.prefs.motion = p.motion;
        if (p && DIFFS.indexOf(p.difficulty) >= 0) data.prefs.difficulty = p.difficulty;
        if (p && CONTROLS.indexOf(p.controls) >= 0) data.prefs.controls = p.controls;
        save();
      },
      getTotals: function () { return { foods: data.totals.foods, bonus: data.totals.bonus, runs: data.totals.runs }; },
      addTotal: function (key, n) {
        if (!(key in data.totals)) return;
        data.totals[key] += count(n === undefined ? 1 : n);
        save();
      },
      /* Achievement chains: the page and tracker keep the rules, the profile only remembers { tier, progress }. */
      getAch: function (id) { var a = data.ach[id]; return a ? { tier: a.tier, progress: a.progress } : { tier: 0, progress: 0 }; },
      achMap: function () { var o = {}; Object.keys(data.ach).forEach(function (k) { o[k] = { tier: data.ach[k].tier, progress: data.ach[k].progress }; }); return o; },
      setAch: function (id, st) {
        if (ids.indexOf(id) < 0 || !st) return false;
        data.ach[id] = { tier: Math.min(99, count(st.tier)), progress: count(st.progress) };
        save();
        return true;
      },
      getName: function () { return data.name; },
      setName: function (v) { data.name = cleanName(v); save(); return data.name; },
      getSavedAt: function () { return data.savedAt; },
      onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
      /* Everything worth keeping, as one plain object (for a backup code or an online copy). */
      exportData: function () {
        var bests = {};
        allBestKeys().forEach(function (k) { var n = parseInt(read(k), 10); if (n > 0) bests[k] = n; });
        return { v: 2, savedAt: data.savedAt, data: JSON.parse(JSON.stringify(data)), bests: bests };
      },
      /* Replace this profile with exported data. False (and nothing changed) when it is not valid. */
      importData: function (o) {
        if (!o || typeof o !== 'object' || o.v !== 2 || !o.data || typeof o.data !== 'object') return false;
        data = sanitize(o.data);
        var bests = o.bests && typeof o.bests === 'object' ? o.bests : {};
        allBestKeys().forEach(function (k) { var n = Math.floor(bests[k]); write(k, n > 0 && n < 1e9 ? String(n) : '0'); });
        save();
        return true;
      },
      exportCode: function () { return 'GS2.' + b64(JSON.stringify(this.exportData())); },
      importCode: function (code) {
        try {
          var c = String(code || '').replace(/\s+/g, '');
          if (c.indexOf('GS2.') !== 0) return false;
          return this.importData(JSON.parse(unb64(c.slice(4))));
        } catch (e) { return false; }
      },
      getCoins: function () { return data.coins; },
      /* The server's wallet replaces the coins and the owned items on this device (web page, signed in). It is not progress:
         it does not touch savedAt and does not wake the listeners, so it never looks like a change to sync. An equipped look
         the wallet does not hold goes back to the default. */
      setWallet: function (w) {
        if (!w || typeof w !== 'object') return false;
        var o = {};
        premium.forEach(function (id) { if (w.owned && w.owned[id] === true) o[id] = true; });
        data.coins = count(w.coins);
        data.owned = o;
        LOOK_KEYS.forEach(function (k) { if (!allowed(k, data.prefs[k], data.owned)) data.prefs[k] = LOOKS[k][0]; });
        write(KEY, JSON.stringify(data));
        return true;
      },
      addCoins: function (n) { n = count(n); if (n) { data.coins += n; save(); } return data.coins; },
      /* A shop item is owned once bought. A free look (skin:emerald, board:midnight) is always owned. Anything else is not:
         an unknown id used to count as owned, which was wrong. */
      owns: function (id) {
        if (premium.indexOf(id) >= 0) return !!data.owned[id];
        var p = String(id).split(':');
        return p.length === 2 && LOOKS[p[0]] !== undefined && LOOKS[p[0]].indexOf(p[1]) >= 0;
      },
      /* Spend coins on a shop item. False when unknown, already owned, or too expensive. */
      buy: function (id, price) {
        if (premium.indexOf(id) < 0 || data.owned[id] || !(price >= 0) || data.coins < price) return false;
        data.coins -= Math.floor(price); data.owned[id] = true; save();
        return true;
      },
      getBest: getBest,
      setBest: setBest,
      /* Forget scores, totals and achievements. Preferences (looks, sound, mode) are kept. */
      resetProgress: function () {
        data.totals = { foods: 0, bonus: 0, runs: 0 };
        data.ach = {};
        data.coins = 0; data.owned = {};
        LOOK_KEYS.forEach(function (k) { if (!allowed(k, data.prefs[k], data.owned)) data.prefs[k] = LOOKS[k][0]; });
        save();
        modes.forEach(function (m) {
          EDGES.forEach(function (e) {
            [false, true].forEach(function (g) {
              var k = bestKey(m, e, g);
              if (read(k) !== null) write(k, '0');
            });
          });
        });
      }
    };
  }

  return { KEY: KEY, create: create };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeProfile;
