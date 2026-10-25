/* Grid Snake global leaderboard (Time Attack only)
 * A shared online board kept in Supabase, reached over its plain REST API (no SDK, no service key).
 * Pure module: no DOM, no storage. The page passes in fetch, so tests can run without a network.
 *
 * Honest limits, also written in the setup notes (supabase/README.md):
 *  - A score sent from a browser can be forged. The database checks the shape and the range of a row
 *    (name length, score 0..1000), not whether the run really happened. Stronger checks need a trusted
 *    Edge Function that replays the run. This is not cheat-proof.
 *  - The public anon key is meant for browsers, and row-level security decides what it may do. Never put
 *    the service-role key in this file or anywhere in the repository.
 */
var SnakeLeaderboard = (function () {
  'use strict';

  /* Fill these from your Supabase project (Project Settings > API): the Project URL and the public anon key.
     Left empty, the game reports "not set up yet" and sends nothing. */
  var CONFIG = {
    url: '',                       // e.g. 'https://xyzcompany.supabase.co'
    anonKey: '',                   // the public "anon" key only
    table: 'time_attack_scores',
    pageSize: 20,
    timeoutMs: 8000,
    maxScore: 1000                 // a sanity bound from the rules: a Time Attack run is 60 s and steps are at least 60 ms apart
  };

  var MODE = 'timeattack';
  var NAME_MAX = 16;

  var REASON = {
    notConfigured: 'not-configured', wrongMode: 'wrong-mode', offline: 'offline', timeout: 'timeout',
    network: 'network', rejected: 'rejected', server: 'server', badResponse: 'bad-response', invalid: 'invalid'
  };

  function configured(cfg) { cfg = cfg || CONFIG; return !!(cfg.url && cfg.anonKey); }

  /* A display name: trimmed, single spaces, no control characters, no markup, 1 to 16 characters. Letters of
     any script are allowed, so Arabic names work, and apostrophes and hyphens are fine. */
  function validateName(v) {
    if (typeof v !== 'string') return { ok: false, reason: REASON.invalid };
    if (/[\u0000-\u001f\u007f<>&"`\\]/.test(v)) return { ok: false, reason: REASON.invalid };   // apostrophes are fine: names are shown as plain text
    var t = v.replace(/\s+/g, ' ').trim();
    if (!t) return { ok: false, reason: REASON.invalid };
    if (Array.from(t).length > NAME_MAX) return { ok: false, reason: REASON.invalid };
    if (!/^[\p{L}\p{N} _.'\-]+$/u.test(t)) return { ok: false, reason: REASON.invalid };
    if (!/[\p{L}\p{N}]/u.test(t)) return { ok: false, reason: REASON.invalid };   // at least one letter or digit
    return { ok: true, name: t };
  }

  function validateScore(v, maxScore) {
    var max = maxScore || CONFIG.maxScore;
    if (typeof v !== 'number' || !isFinite(v) || Math.floor(v) !== v) return { ok: false, reason: REASON.invalid };
    if (v < 0 || v > max) return { ok: false, reason: REASON.invalid };
    return { ok: true, score: v };
  }

  /* A random id per run, so the database can refuse the same run twice. */
  function makeRunId(random) {
    var b = new Uint8Array(16), i;
    if (random) { for (i = 0; i < 16; i++) b[i] = Math.floor(random() * 256); }
    else if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;          // version 4
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function headers(cfg) {
    return { apikey: cfg.anonKey, Authorization: 'Bearer ' + cfg.anonKey, 'Content-Type': 'application/json' };
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
      if (res.status === 409) return { ok: true, duplicate: true };          // this run is already on the board
      if (res.status >= 500) return { ok: false, reason: REASON.server, status: res.status };
      if (res.status >= 400) return { ok: false, reason: REASON.rejected, status: res.status };
      return { ok: true, status: res.status, response: res };
    }, function (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') return { ok: false, reason: REASON.timeout };
      return { ok: false, reason: REASON.network };
    });
  }

  /* Post one finished Time Attack run. Other modes are refused here as well as in the page. */
  function submitRun(o) {
    o = o || {};
    var cfg = o.config || CONFIG;
    if (o.mode !== MODE) return Promise.resolve({ ok: false, reason: REASON.wrongMode });
    if (!configured(cfg)) return Promise.resolve({ ok: false, reason: REASON.notConfigured });
    var name = validateName(o.name), score = validateScore(o.score, cfg.maxScore);
    if (!name.ok || !score.ok) return Promise.resolve({ ok: false, reason: REASON.invalid });
    var body = JSON.stringify({ run_id: o.runId || makeRunId(), name: name.name, score: score.score });
    var url = cfg.url.replace(/\/+$/, '') + '/rest/v1/' + cfg.table;
    return call(o.fetch, cfg, url, { method: 'POST', headers: Object.assign(headers(cfg), { Prefer: 'return=minimal' }), body: body }, o.nav).then(function (r) {
      if (r.ok && !r.duplicate) return { ok: true };
      return r;
    });
  }

  /* One page of the board: best score first, and the earlier run first on a tie. */
  function fetchTop(o) {
    o = o || {};
    var cfg = o.config || CONFIG;
    if (!configured(cfg)) return Promise.resolve({ ok: false, reason: REASON.notConfigured });
    var size = Math.max(1, Math.min(50, o.pageSize || cfg.pageSize)), page = Math.max(0, o.page || 0), offset = page * size;
    var q = '?select=name,score,created_at&order=score.desc,created_at.asc&limit=' + size + '&offset=' + offset;
    var url = cfg.url.replace(/\/+$/, '') + '/rest/v1/' + cfg.table + q;
    return call(o.fetch, cfg, url, { method: 'GET', headers: headers(cfg) }, o.nav).then(function (r) {
      if (!r.ok) return r;
      return r.response.json().then(function (rows) {
        if (!Array.isArray(rows)) return { ok: false, reason: REASON.badResponse };
        var out = rows.slice(0, size).map(function (row, i) {
          return { rank: offset + i + 1, name: String(row.name || '').slice(0, NAME_MAX), score: Number(row.score) || 0, date: row.created_at || '' };
        });
        return { ok: true, rows: out, page: page, hasMore: rows.length === size };
      }, function () { return { ok: false, reason: REASON.badResponse }; });
    });
  }

  return {
    CONFIG: CONFIG, MODE: MODE, REASON: REASON, NAME_MAX: NAME_MAX,
    configured: configured, validateName: validateName, validateScore: validateScore, makeRunId: makeRunId,
    submitRun: submitRun, fetchTop: fetchTop
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeLeaderboard;
