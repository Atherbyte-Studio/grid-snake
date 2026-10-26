/* Grid Snake global board, version 2: one permanent player per name, one personal best per player.
 * Pure module: no DOM, no storage. The page passes in fetch, so tests can run without a network.
 *
 * How identity works (see supabase/README.md):
 *  - Registering creates a player row with a unique name (case-insensitive) and a recovery code.
 *    The code is 128 random bits shown once to the player. The server stores only its SHA-256 hash.
 *  - Every later call sends the code. The server finds the player by hash, so a name alone never
 *    grants access. Losing the code (cleared storage, no copy) means the player cannot prove ownership.
 *  - Scores are written with a single update that only raises the best. The name is never sent when
 *    submitting, so a score can never be written under someone else's name.
 *
 * Honest limits: a browser-side game can be modified, so the ranked settings and scores are checked by
 * shape and range, not by replaying the run. This is not cheat-proof.
 */
var SnakeLeaderboard = (function () {
  'use strict';

  /* Project URL and publishable key (Project Settings > API). Left empty, the board is off and nothing is sent. */
  var CONFIG = {
    url: 'https://tmmzahzkqmcgbtjimtjn.supabase.co',
    anonKey: 'sb_publishable_HC2_4BGM2Foe0SIduZBMwg__Ln0bKx4',   // public by design; row rules protect the data
    timeoutMs: 8000,
    maxScore: 1000,      // a Time Attack run is 60 s; this is a sanity bound, not a proof
    topSize: 10
  };

  /* The only settings a ranked Time Attack round may use. */
  var RANKED = { walls: true, golden: true, difficulty: 'hard' };
  var NAME_MAX = 16;

  var REASON = {
    notConfigured: 'not-configured', offline: 'offline', timeout: 'timeout', network: 'network',
    rejected: 'rejected', server: 'server', badResponse: 'bad-response', invalid: 'invalid',
    setup: 'setup', notRanked: 'not-ranked', taken: 'taken', unknownPlayer: 'unknown-player', alreadyRegistered: 'already-registered', storage: 'storage'
  };

  function configured(cfg) { cfg = cfg || CONFIG; return !!(cfg.url && cfg.anonKey); }

  /* A display name: trimmed, single spaces, 1 to 16 characters. Letters of any script (Arabic included),
     digits, space, underscore, dot, apostrophe and hyphen. No markup, quotes, backslashes or control characters. */
  function validateName(v) {
    if (typeof v !== 'string') return { ok: false, reason: REASON.invalid };
    if (/[\u0000-\u001f\u007f<>&"`\\]/.test(v)) return { ok: false, reason: REASON.invalid };
    var t = v.replace(/\s+/g, ' ').trim();
    if (!t) return { ok: false, reason: REASON.invalid };
    if (Array.from(t).length > NAME_MAX) return { ok: false, reason: REASON.invalid };
    if (!/^[\p{L}\p{N} _.'\-]+$/u.test(t)) return { ok: false, reason: REASON.invalid };
    if (!/[\p{L}\p{N}]/u.test(t)) return { ok: false, reason: REASON.invalid };
    return { ok: true, name: t };
  }

  /* The recovery code: 32 hex characters. Users may type dashes or spaces and any letter case. */
  function normalizeSecret(v) {
    if (typeof v !== 'string') return '';
    return v.replace(/[\s-]/g, '').toLowerCase();
  }
  function validateSecret(v) {
    var s = normalizeSecret(v);
    return /^[0-9a-f]{32}$/.test(s) ? { ok: true, secret: s } : { ok: false, reason: REASON.invalid };
  }
  /* Shown to the player in groups of four, for example 1a2b-3c4d-... */
  function formatSecret(hex) {
    var s = normalizeSecret(hex);
    return s.replace(/(.{4})(?=.)/g, '$1-');
  }
  /* A new code: 16 random bytes. */
  function newSecret(random) {
    var b = new Uint8Array(16), i;
    if (random) { for (i = 0; i < 16; i++) b[i] = Math.floor(random() * 256); }
    else if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }

  function validateScore(v, maxScore) {
    var max = maxScore || CONFIG.maxScore;
    if (typeof v !== 'number' || !isFinite(v) || Math.floor(v) !== v) return { ok: false, reason: REASON.invalid };
    if (v < 0 || v > max) return { ok: false, reason: REASON.invalid };
    return { ok: true, score: v };
  }

  /* True only for the exact ranked rule set. Any other combination is not ranked. */
  function isRanked(settings) {
    return !!settings && settings.walls === RANKED.walls && settings.golden === RANKED.golden && settings.difficulty === RANKED.difficulty;
  }

  function headers(cfg) {
    var h = { apikey: cfg.anonKey, 'Content-Type': 'application/json' };
    if (/^eyJ/.test(cfg.anonKey)) h.Authorization = 'Bearer ' + cfg.anonKey;   // legacy JWT-style keys only
    return h;
  }

  /* One request with a timeout. Never throws: every failure comes back as { ok:false, reason }. */
  function call(fetchImpl, cfg, url, init, nav) {
    var online = nav ? nav.onLine !== false : (typeof navigator === 'undefined' || navigator.onLine !== false);
    if (!online) return Promise.resolve({ ok: false, reason: REASON.offline });
    if (typeof fetchImpl !== 'function') return Promise.resolve({ ok: false, reason: REASON.network });
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, cfg.timeoutMs);
    var opts = Object.assign({}, init, ctrl ? { signal: ctrl.signal } : {});
    return Promise.resolve().then(function () { return fetchImpl(url, opts); }).then(function (res) {
      clearTimeout(timer);
      if (res.status === 404) return { ok: false, reason: REASON.setup, status: res.status };   // migration not run yet
      if (res.status >= 500) return { ok: false, reason: REASON.server, status: res.status };
      if (res.status >= 400) return { ok: false, reason: REASON.rejected, status: res.status };
      return res.json().then(function (body) { return { ok: true, body: body }; },
                             function () { return { ok: false, reason: REASON.badResponse }; });
    }, function (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') return { ok: false, reason: REASON.timeout };
      return { ok: false, reason: REASON.network };
    });
  }

  /* Calls one database function (RPC). Returns { ok:true, body } or { ok:false, reason }. */
  function rpc(o, fn, args) {
    var cfg = o.config || CONFIG;
    if (!configured(cfg)) return Promise.resolve({ ok: false, reason: REASON.notConfigured });
    var url = cfg.url.replace(/\/+$/, '') + '/rest/v1/rpc/' + fn;
    return call(o.fetch, cfg, url, { method: 'POST', headers: headers(cfg), body: JSON.stringify(args) }, o.nav);
  }

  /* ----- the pending code: a recovery code kept on this device until the server confirms it -----
   * The code is created once and written to storage BEFORE the registration request leaves. If the answer is
   * lost (timeout, dropped connection, closed tab), the same code is sent again, so the server either creates the
   * player or says it already exists for this code. Either way the player gets their identity back, and no
   * name is reserved for a code this device no longer has. The code is never logged. */
  var PENDING_KEY = 'gridsnake-pending-player-v1';

  function readPending(storage) {
    try {
      var v = JSON.parse(storage.getItem(PENDING_KEY) || 'null');
      if (v && validateSecret(v.secret).ok) return { name: typeof v.name === 'string' ? v.name : '', secret: normalizeSecret(v.secret) };
    } catch (e) {}
    return null;
  }
  function writePending(storage, p) {
    try { storage.setItem(PENDING_KEY, JSON.stringify(p)); return true; } catch (e) { return false; }
  }
  function clearPending(storage) {
    try { storage.removeItem(PENDING_KEY); } catch (e) {}
  }

  /* Register a player with the safe mechanism. o: { name, storage, fetch, nav, config }.
   * Returns { ok:true, name, secret, restored } on success. restored is true when the server already had this
   * code (a lost answer, or a second tab), so the caller saves the identity and does not treat it as a failure.
   * Returns { ok:false, reason, secret } otherwise; a taken name keeps the same pending code for a second try. */
  function enrollPlayer(o) {
    o = o || {};
    var name = validateName(o.name);
    if (!name.ok) return Promise.resolve({ ok: false, reason: REASON.invalid });
    if (!o.storage) return Promise.resolve({ ok: false, reason: REASON.storage });
    var pend = readPending(o.storage);
    var secret = pend ? pend.secret : newSecret(o.random);
    if (!writePending(o.storage, { name: name.name, secret: secret })) return Promise.resolve({ ok: false, reason: REASON.storage });
    return registerPlayer({ config: o.config, fetch: o.fetch, nav: o.nav, name: name.name, secret: secret }).then(function (r) {
      if (r.ok) { clearPending(o.storage); return { ok: true, name: r.name, secret: secret, restored: false }; }
      if (r.reason === REASON.alreadyRegistered) { clearPending(o.storage); return { ok: true, name: r.name, secret: secret, restored: true }; }
      return { ok: false, reason: r.reason, secret: secret };
    });
  }

  /* On page load: a pending code that the server already knows means the earlier answer was lost. Recover it.
   * Returns { ok:true, name, secret } or { ok:false, reason }. An unknown code stays pending for the next try. */
  function resumePending(o) {
    o = o || {};
    var pend = o.storage ? readPending(o.storage) : null;
    if (!pend) return Promise.resolve({ ok: false, reason: 'none' });
    return getMe({ config: o.config, fetch: o.fetch, nav: o.nav, secret: pend.secret }).then(function (r) {
      if (!r.ok) return { ok: false, reason: r.reason };
      clearPending(o.storage);
      return { ok: true, name: r.name, secret: pend.secret };
    });
  }

  /* Register a new player name. The server answers ok, taken, or invalid. Nothing is stored locally here. */
  function registerPlayer(o) {
    o = o || {};
    var name = validateName(o.name), sec = validateSecret(o.secret);
    if (!name.ok || !sec.ok) return Promise.resolve({ ok: false, reason: REASON.invalid });
    return rpc(o, 'register_player', { p_name: name.name, p_secret: sec.secret }).then(function (r) {
      if (!r.ok) return r;
      var st = r.body && r.body.status;
      if (st === 'ok') return { ok: true, name: r.body.name };
      if (st === 'taken') return { ok: false, reason: REASON.taken };
      if (st === 'already-registered') return { ok: false, reason: REASON.alreadyRegistered, name: r.body.name };
      if (st === 'invalid') return { ok: false, reason: REASON.invalid };
      return { ok: false, reason: REASON.badResponse };
    });
  }

  /* Send a finished Time Attack round. The server raises the personal best only when the score is higher.
   * Refused here, before any request, if the round did not use the ranked settings. */
  function submitBest(o) {
    o = o || {};
    if (!isRanked(o.settings)) return Promise.resolve({ ok: false, reason: REASON.notRanked });
    var sec = validateSecret(o.secret), score = validateScore(o.score, (o.config || CONFIG).maxScore);
    if (!sec.ok || !score.ok) return Promise.resolve({ ok: false, reason: REASON.invalid });
    return rpc(o, 'submit_best', { p_secret: sec.secret, p_score: score.score, p_walls: RANKED.walls, p_golden: RANKED.golden, p_difficulty: RANKED.difficulty }).then(function (r) {
      if (!r.ok) return r;
      var st = r.body && r.body.status;
      if (st === 'improved' || st === 'kept') return { ok: true, improved: st === 'improved', best: Number(r.body.best) || 0, rank: r.body.rank == null ? null : Number(r.body.rank) };
      if (st === 'unknown-player') return { ok: false, reason: REASON.unknownPlayer };
      if (st === 'invalid') return { ok: false, reason: REASON.invalid };
      return { ok: false, reason: REASON.badResponse };
    });
  }

  /* The player's own record: name, personal best and the true global rank (null if not ranked yet). */
  function getMe(o) {
    o = o || {};
    var sec = validateSecret(o.secret);
    if (!sec.ok) return Promise.resolve({ ok: false, reason: REASON.invalid });
    return rpc(o, 'get_me', { p_secret: sec.secret }).then(function (r) {
      if (!r.ok) return r;
      var b = r.body || {};
      if (b.status === 'unknown-player') return { ok: false, reason: REASON.unknownPlayer };
      if (typeof b.name !== 'string') return { ok: false, reason: REASON.badResponse };
      return { ok: true, name: b.name, best: b.best == null ? null : Number(b.best), rank: b.rank == null ? null : Number(b.rank) };
    });
  }

  /* The top of the board, best first. Only the top ten are ever requested. */
  function fetchTop(o) {
    o = o || {};
    var size = Math.max(1, Math.min(10, o.limit || CONFIG.topSize));
    return rpc(o, 'get_top', { p_limit: size }).then(function (r) {
      if (!r.ok) return r;
      if (!Array.isArray(r.body)) return { ok: false, reason: REASON.badResponse };
      var rows = r.body.slice(0, size).map(function (row, i) {
        return { rank: Number(row.rank) || i + 1, name: String(row.name || '').slice(0, NAME_MAX), score: Number(row.score) || 0, date: row.achieved_at || '' };
      });
      return { ok: true, rows: rows };
    });
  }

  return {
    CONFIG: CONFIG, RANKED: RANKED, REASON: REASON, NAME_MAX: NAME_MAX,
    configured: configured, validateName: validateName, validateScore: validateScore,
    validateSecret: validateSecret, normalizeSecret: normalizeSecret, formatSecret: formatSecret, newSecret: newSecret,
    isRanked: isRanked, registerPlayer: registerPlayer, submitBest: submitBest, getMe: getMe, fetchTop: fetchTop,
    enrollPlayer: enrollPlayer, resumePending: resumePending, PENDING_KEY: PENDING_KEY
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeLeaderboard;
