/* Grid Snake and the Atherbyte account (WEB PAGE ONLY: build.js adds it to index.html, never to grid-snake.html,
 * so the Android app and the claude.ai copy are unchanged).
 *
 * On atherbyte.online the game does not start until the visitor is signed in to Atherbyte:
 *  - build.js ships the game's script as inert text (type="text/plain"). boot() checks the session with the server
 *    (GET /v1/me, refreshed when needed) and runs the game only after that. Signed out, expired or unreachable: the
 *    sign-in screen stays and the game code never runs. The local "choose a name" box is never shown.
 *  - What really protects the board and the saves is the server: scores and saves need a verified Atherbyte session
 *    (the Worker reads the account from the token). A page someone edits can only change their own screen.
 *  - The name in the game is the account's username, set by the server from the account (same player row and id).
 *
 * Old players: the recovery code on this device (or one the player types) links the old player to the account, with
 * its id, score and rank. A device with progress but no code is never linked by guess: its progress is kept, a backup
 * code is shown, and the player chooses (enter a code, or start a new player and keep this device's progress).
 *  - Save: copies this device's progress (coins, shop items, achievements, settings, local bests) to the account.
 *    Every save carries the version it was based on; if another device saved in between, nothing is written and the
 *    player chooses. One device never silently replaces another's progress.
 *  - Before ANY import, and before linking, the device's progress is kept as a backup code (GS2., the same format as
 *    Profile > Backup and restore), the last five of them.
 *  - Ranked Time Attack scores go through the Worker (the browser cannot write to the board).
 *  - Coins and shop items belong to the server (supabase/wallet.sql). A signed-in page shows the server's wallet and buys
 *    through the Worker, which prices the item and takes the coins. A ranked round pays the score the Worker replayed, any
 *    other run pays what its time allows (opened with the server when it starts, claimed when it ends), and achievement
 *    tiers are claimed once each. The device's own coin count is only what the screen shows until the server answers;
 *    editing it earns nothing. A Worker without the wallet leaves the game on its own coins, as before.
 *
 * The core (create, patchBoard) has no DOM and is tested in tests/account_link.test.js; boot() is tested in a browser
 * by tests/account_link_ui.test.js.
 */
var SnakeAccountLink = (function () {
  'use strict';

  var PLAYER_KEY = 'gridsnake-player-v1';
  var PENDING_KEY = 'gridsnake-pending-player-v1';
  var PROFILE_KEY = 'gridsnake-profile-v2';
  var BEST_PREFIX = 'gridsnake-best-';
  var BACKUP_KEY = 'gridsnake-backups-v1';
  var SYNC_KEY = 'gridsnake-account-sync-v1';     // { [account id]: { version, at, checked } }
  var LOCAL_ONLY_KEY = 'gridsnake-account-identity-v1';   // { secret }: the stand-in code of an account player (not a real code)
  /* One device, several accounts: the game's data on this device (player, code, progress, bests, backups) belongs to
     ONE account at a time, OWNER_KEY. Signing in as another account moves the current data, unchanged, into
     SLOT_PREFIX + <owner id> and brings that account's own slot back (or starts it empty). Data that predates this
     (no owner) is an old, unclaimed player: only its recovery code links it, never a sign-in alone. */
  var OWNER_KEY = 'gridsnake-device-owner-v1';
  var SLOT_PREFIX = 'gridsnake-slot-v1:';
  var BACKUPS_KEPT = 5;
  var API = '/v1/games/grid-snake/';
  var CODE_RE = /^[0-9a-f]{32}$/;

  /* The engine's fingerprint: build.js replaces 'dev' with the SHA-256 of src/engine.js. The Worker replays with a copy of
     that engine (atherbyte-api/src/game/snake-engine.js) and refuses a round recorded by another version. */
  var ENGINE_SHA = 'dev';
  /* The record format this page writes when the Worker reads it (atherbyte-api src/game/replay.js), and one frame time in
     a format: decimal in format 2, base 36 in format 1. */
  var RECORD_FORMAT = 2;
  function recordFrame(q, format) { return format === RECORD_FORMAT ? String(q) : q.toString(36); }
  /* The 32-bit generator for a seeded round; the same as the Worker's (atherbyte-api/src/game/replay.js, seededRng). */
  function seededRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function b64(str) {
    if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64');
    return btoa(unescape(encodeURIComponent(str)));
  }
  function parse(v) { try { return JSON.parse(v); } catch (e) { return null; } }
  function normalizeCode(v) { return typeof v === 'string' ? v.replace(/[\s-]/g, '').toLowerCase() : ''; }
  function randomCode(random) {
    var b = new Uint8Array(16), i;
    if (random) { for (i = 0; i < 16; i++) b[i] = Math.floor(random() * 256); }
    else crypto.getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }

  /* o: { account (AtherbyteAccount client), storage, now, random } */
  function create(o) {
    var account = o.account, storage = o.storage;
    var now = o.now || function () { return Date.now(); };
    var state = { phase: 'idle', linked: false, name: '', server: null, message: '' };

    function get(k) { try { return storage.getItem(k); } catch (e) { return null; } }
    function set(k, v) { try { storage.setItem(k, v); return true; } catch (e) { return false; } }
    function remove(k) { try { storage.removeItem(k); } catch (e) {} }
    function keys() {
      var out = [];
      try { for (var i = 0; i < storage.length; i++) out.push(storage.key(i)); } catch (e) {}
      return out;
    }

    /* ---------- one account's data at a time ---------- */
    function slotted(k) { return !!k && k.indexOf('gridsnake-') === 0 && k !== SYNC_KEY && k !== OWNER_KEY && k.indexOf(SLOT_PREFIX) !== 0; }
    function liveData() { var o = {}; keys().filter(slotted).forEach(function (k) { o[k] = get(k); }); return o; }
    /* The account whose data is on the device. Before OWNER_KEY existed, the account this device's player was confirmed
       for (its code checked, or a player made for the account) is the owner; otherwise nobody (an unclaimed player). */
    function owner() {
      var v = get(OWNER_KEY);
      if (v) return v;
      var all = parse(get(SYNC_KEY)) || {}, cur = parse(get(PLAYER_KEY)), stand = parse(get(LOCAL_ONLY_KEY));
      if (!cur || typeof cur.secret !== 'string') return '';
      var code = normalizeCode(cur.secret);
      var ids = Object.keys(all).filter(function (id) {
        var m = all[id] || {};
        return (m.checked && m.checked === code) || (m.fresh && stand && stand.secret === cur.secret);
      });
      return ids.length === 1 ? ids[0] : '';
    }
    /* Puts the signed-in account's data on the device. Returns 'same', 'switched', 'unclaimed' (an old player without
       an owner is on the device, left as it is) or 'storage' (nothing was moved: the browser would not keep it). */
    function useSlotOf(id) {
      if (!id) return 'storage';
      var cur = owner();
      if (cur === id) { set(OWNER_KEY, id); return 'same'; }
      var live = liveData();
      if (!cur && Object.keys(live).length) return 'unclaimed';
      if (cur) {
        // the other account's data goes aside exactly as it is; it is removed from the device only once kept
        var text = JSON.stringify(live);
        if (!set(SLOT_PREFIX + cur, text) || get(SLOT_PREFIX + cur) !== text) return 'storage';
        Object.keys(live).forEach(remove);
      }
      var saved = parse(get(SLOT_PREFIX + id));
      if (saved && typeof saved === 'object') {
        Object.keys(saved).forEach(function (k) { if (slotted(k) && typeof saved[k] === 'string') set(k, saved[k]); });
        remove(SLOT_PREFIX + id);
      }
      set(OWNER_KEY, id);
      return 'switched';
    }
    function claimDevice() { var id = accountId(); if (id) set(OWNER_KEY, id); }

    /* This device's own player: a real recovery code (never the stand-in written for an account player). */
    function localPlayer() {
      var p = parse(get(PLAYER_KEY));
      var stand = parse(get(LOCAL_ONLY_KEY));
      if (p && typeof p.name === 'string' && CODE_RE.test(normalizeCode(p.secret)) && !(stand && stand.secret === p.secret)) return p;
      var pend = parse(get(PENDING_KEY));     // created here, answer lost: the code may be on the board
      if (pend && CODE_RE.test(normalizeCode(pend.secret))) return { name: typeof pend.name === 'string' ? pend.name : '', secret: pend.secret, pending: true };
      return null;
    }
    function accountId() {
      var s = account && account.getSession ? account.getSession() : null;
      return s && s.user && s.user.id ? String(s.user.id) : '';
    }
    function syncInfo() { return (parse(get(SYNC_KEY)) || {})[accountId()] || null; }
    function patchSync(fields) {
      var all = parse(get(SYNC_KEY)) || {};
      var cur = all[accountId()] || {};
      Object.keys(fields).forEach(function (k) { cur[k] = fields[k]; });
      all[accountId()] = cur;
      set(SYNC_KEY, JSON.stringify(all));
    }
    /* version: the account's save version this device now matches; at: the device's savedAt at that moment. */
    function setSync(version, at) { patchSync({ version: version, at: at || 0 }); }

    /* The device's progress, in the exact shape of the game's own export (profile.exportData). */
    function exportLocal() {
      var data = parse(get(PROFILE_KEY));
      if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
      var bests = {};
      keys().forEach(function (k) {
        if (k && k.indexOf(BEST_PREFIX) === 0) { var n = parseInt(get(k), 10); if (n > 0) bests[k] = n; }
      });
      var savedAt = typeof data.savedAt === 'number' && data.savedAt >= 0 ? Math.floor(data.savedAt) : 0;
      return { v: 2, savedAt: savedAt, data: data, bests: bests };
    }
    /* Nothing worth keeping on this device: no coins, no runs, no shop items, no achievements, no bests. */
    function localIsEmpty() {
      var e = exportLocal(), d = e.data;
      var totals = d.totals || {};
      return !d.coins && !totals.runs && !totals.foods && !Object.keys(d.owned || {}).length &&
        !Object.keys(d.ach || {}).length && !Object.keys(e.bests).length;
    }

    /* Keeps the device's progress (and its player's recovery code, if any) as a GS2 code before anything replaces it. */
    function backup(reason) {
      var code = 'GS2.' + b64(JSON.stringify(exportLocal()));
      var list = parse(get(BACKUP_KEY));
      if (!Array.isArray(list)) list = [];
      if (list[0] && list[0].code === code) return code;   // the same progress is already the latest backup
      var lp = localPlayer();
      list.unshift({ at: now(), reason: reason, code: code, player: lp && !lp.pending ? { name: lp.name, secret: lp.secret } : null });
      if (!set(BACKUP_KEY, JSON.stringify(list.slice(0, BACKUPS_KEPT)))) return null;
      return code;
    }
    function backups() { var l = parse(get(BACKUP_KEY)); return Array.isArray(l) ? l : []; }

    /* Replaces the device's progress with a save (only ever called after backup() and, if the device had progress,
       after the player chose it). Runs before the game starts, so the game reads it as its saved data. */
    function importSave(save) {
      if (!save || save.v !== 2 || !save.data || typeof save.data !== 'object') return false;
      if (!set(PROFILE_KEY, JSON.stringify(save.data))) return false;
      var bests = save.bests && typeof save.bests === 'object' ? save.bests : {};
      keys().forEach(function (k) { if (k && k.indexOf(BEST_PREFIX) === 0 && !(k in bests)) set(k, '0'); });
      Object.keys(bests).forEach(function (k) {
        var n = Math.floor(bests[k]);
        if (k.indexOf(BEST_PREFIX) === 0 && n > 0 && n < 1e9) set(k, String(n));
      });
      return true;
    }

    /* A running game belongs to the account it started for. If the browser's session changes under it (sign-out, or
       another account signed in, in this tab or another), it sends nothing more: one account's progress can never be
       saved or scored with another account's session. */
    var boundTo = '';
    function bind() { boundTo = accountId(); }
    function call(path, method, body) {
      if (boundTo && accountId() !== boundTo) { state.phase = 'locked'; return Promise.resolve({ ok: false, status: 401, data: null, code: 'account_changed' }); }
      return account.authed(API + path, method === 'GET' ? undefined : { method: method, body: body });
    }
    function fail(message, code) { state.message = message; return { ok: false, message: message, code: code || '' }; }

    /* Is the session valid on the server? 'ok', 'signed-out' (none, expired or refused) or 'offline'. */
    function verifySession() {
      if (!account || !account.isConfigured()) return Promise.resolve('offline');
      if (!account.hasSession()) return Promise.resolve('signed-out');
      return account.me().then(function (r) {
        if (r.ok) return 'ok';
        return !account.hasSession() || r.status === 401 || r.status === 403 || r.status === 404 ? 'signed-out' : 'offline';
      });
    }

    /* The account's player, as the server knows it. */
    function fetchPlayer() {
      return call('player', 'GET').then(function (r) {
        if (!r.ok) { state.phase = 'error'; fail(r.status === 503 ? 'Grid Snake accounts are not available right now.' : 'Could not reach your Atherbyte account.'); return false; }
        state.server = r.data;
        state.linked = !!r.data.linked;
        state.name = r.data.linked ? r.data.name : '';
        return true;
      });
    }

    /* After the player is known: nothing to do, a first upload, an automatic restore into an empty or unchanged device,
       or a conflict for the player to settle. Never overwrites progress on either side by itself. */
    function decideSync() {
      if (!state.linked) { state.phase = 'unlinked'; return Promise.resolve(state); }
      var save = state.server.save, mine = syncInfo();
      if (!save) {
        if (mine && mine.fresh) { state.phase = 'linked'; return Promise.resolve(state); }
        return upload(null).then(function () { return state; });
      }
      if (mine && mine.version === save.version) { state.phase = 'linked'; return Promise.resolve(state); }
      if (localIsEmpty() || (mine && mine.version < save.version && !changedSince(mine))) {
        if (!backup('before-restore')) { state.phase = 'conflict'; return Promise.resolve(state); }
        importSave(save.data);
        setSync(save.version, save.data && save.data.savedAt);
        state.phase = 'restored';
        return Promise.resolve(state);
      }
      state.phase = 'conflict';
      return Promise.resolve(state);
    }
    function refresh() {
      if (!account || !account.isConfigured() || !account.hasSession()) { state.phase = 'signed-out'; return Promise.resolve(state); }
      state.phase = 'loading';
      return fetchPlayer().then(function (ok) { return ok ? decideSync() : state; });
    }
    /* Progress written on this device after its last sync (the game stamps every profile save with savedAt). */
    function changedSince(mine) { return exportLocal().savedAt > (mine.at || 0); }

    /* A new account plays at once; its player is made on the server the first time something is saved or scored. */
    function ensurePlayer() {
      return useAccountName(true).then(function (r) { if (r.ok) { claimDevice(); loadWallet(); } return r; });
    }
    function notLinked(r) { return r.status === 409 && r.data && r.data.error === 'not_linked'; }

    function upload(base, again) {
      var data = exportLocal();
      return call('save', 'POST', { data: data, base_version: base }).then(function (r) {
        if (notLinked(r) && !again) return ensurePlayer().then(function (e) { return e.ok ? upload(null, true) : e; });
        if (r.ok) {
          setSync(r.data.version, data.savedAt);
          if (state.server) state.server.save = { version: r.data.version, data: data };
          state.phase = 'linked';
          return { ok: true };
        }
        if (r.status === 409 && r.data && r.data.error === 'save_conflict') { state.phase = 'conflict'; return fail('Another device saved to this account. Choose which progress to keep.'); }
        return fail('Your progress could not be saved to the account just now. It is still on this device.');
      });
    }

    /* Link the player that owns this recovery code to the signed-in account (a backup of the device comes first). */
    function linkWithCode(raw) {
      var code = normalizeCode(raw);
      if (!CODE_RE.test(code)) return Promise.resolve(fail('That recovery code is not valid. It has 32 letters and digits.', 'invalid_recovery_code'));
      if (!backup('before-link')) return Promise.resolve(fail('This browser will not keep a backup, so linking is not started.', 'storage'));
      return call('link', 'POST', { recovery_code: code }).then(function (r) {
        if (r.ok) { patchSync({ checked: code }); state.linked = true; state.name = r.data.name; return { ok: true, status: r.data.status, name: r.data.name }; }
        var c = r.data && r.data.error;
        if (c === 'player_linked_elsewhere') return fail('That player is already linked to another Atherbyte account.', c);
        if (c === 'account_has_player') return fail('Your Atherbyte account already has a Grid Snake player.', c);
        if (c === 'unknown_player') return fail('That recovery code does not match any player.', c);
        if (r.status === 429) return fail('Too many tries. Wait a minute and try again.', 'rate_limited');
        return fail('Linking did not work just now. Nothing was changed.', 'network');
      });
    }
    /* Link this device's own player (its stored recovery code). */
    function link() {
      var lp = localPlayer();
      if (!lp) return Promise.resolve(fail(get(PENDING_KEY) ? 'Finish creating your player first.' : 'This device has no player with a recovery code to link.', 'no_player'));
      return linkWithCode(lp.secret).then(function (r) { return r.ok ? refresh().then(function () { return r; }) : r; });
    }
    /* Already checked for this account on this device: no need to send the code again. */
    function localPlayerChecked() { var lp = localPlayer(), m = syncInfo(); return !!(lp && m && m.checked === normalizeCode(lp.secret)); }

    /* The server sets the player's name from the account's username (create: make a player if the account has none). */
    function useAccountName(createPlayer) {
      return call('name', 'POST', { create: createPlayer === true }).then(function (r) {
        if (r.ok) {
          state.linked = true; state.name = r.data.name;
          if (r.data.status === 'created') patchSync({ fresh: true });
          return { ok: true, status: r.data.status, name: r.data.name, reason: r.data.reason };
        }
        var c = r.data && r.data.error;
        if (c === 'name_taken') return fail('Another Grid Snake player already uses your username. Your progress is safe; please contact Atherbyte Studio.', c);
        if (c === 'name_unavailable') return fail('Your username cannot be used as a Grid Snake name (16 characters at most).', c);
        return fail('Could not reach your Atherbyte account.', 'network');
      });
    }

    /* The game's own identity record, written before the game starts. A device whose player is the account's player
       keeps its real recovery code; otherwise a stand-in code is written (it is never sent: every board call goes
       through the Worker). Any previous player of this device stays in the backups with its code. */
    function writeIdentity(name) {
      var cur = parse(get(PLAYER_KEY)), m = syncInfo();
      // the device's own code if it is this account's player, else a code the player typed and the server accepted
      var secret = localPlayerChecked() && cur && CODE_RE.test(normalizeCode(cur.secret)) ? cur.secret : (m && CODE_RE.test(m.checked || '') ? m.checked : null);
      if (!secret) {
        var stand = parse(get(LOCAL_ONLY_KEY));
        secret = stand && CODE_RE.test(stand.secret || '') ? stand.secret : randomCode(o.random);
        set(LOCAL_ONLY_KEY, JSON.stringify({ secret: secret }));
      }
      return set(PLAYER_KEY, JSON.stringify({ name: name, secret: secret }));
    }

    function useAccountSave() {
      var save = state.server && state.server.save;
      if (!save) return Promise.resolve(fail('There is no saved progress on the account.'));
      if (!backup('before-restore')) return Promise.resolve(fail('This browser will not keep a backup, so nothing was replaced.'));
      importSave(save.data);
      setSync(save.version, save.data && save.data.savedAt);
      state.phase = 'restored';
      return Promise.resolve({ ok: true });
    }
    function useDeviceSave() {
      var save = state.server && state.server.save;
      return upload(save ? save.version : null);
    }
    /* After play: send the progress if this device is in step with the account. */
    function syncNow() {
      if (state.phase !== 'linked' && state.phase !== 'restored') return Promise.resolve({ ok: false });
      var mine = syncInfo();
      if (mine && mine.version != null && !changedSince(mine)) return Promise.resolve({ ok: true });
      return upload(mine && mine.version != null ? mine.version : null);
    }

    /* The account's player for the game's "who am I" check. */
    function boardMe() {
      return call('player', 'GET').then(function (r) {
        if (r.ok && r.data.linked) return { ok: true, name: r.data.name, best: r.data.best == null ? null : Number(r.data.best), rank: r.data.rank == null ? null : Number(r.data.rank) };
        if (r.ok) return { ok: true, name: account.username(), best: null, rank: null };   // a new account, no player yet
        if (r.status === 0) return { ok: false, reason: 'network' };
        return { ok: false, reason: 'rejected' };
      });
    }
    /* ---------- ranked rounds (supabase/score_rounds.sql, score_replay.sql) ----------
       A Time Attack run uses a round the server opened BEFORE the run was created. The round carries a seed, and the run
       is built from it, so food, pick-ups and golden apples come out exactly as they will when the server replays the
       run. The run records what the game feeds its engine (start, frame times, turns, pause, resume); the Worker replays
       that record with the same engine and counts the score it reaches, never a number this page claims. Rounds are
       fetched ahead (prefetch), so starting a run never waits for the network.
       The game's queue sends scores oldest first; each one goes out with the round and record of the run that earned it:
         counted (200)                                -> done
         refused for good (400 404 409 410 422)       -> done: the game drops it, and the message says why
         no answer (no connection, timeout, 5xx, 429) -> kept, with the SAME round and record, for Try again. If the lost
                                                         request did reach the server, the retry is answered "round
                                                         closed", reported as already counted, never counted twice
         the run had no round ready when it was created -> done: it cannot be ranked, and the message says so
       Rollout: a Worker whose rounds carry no seed gets the round without a record (as before replay); a Worker with no
       /round at all gets the old request (LEGACY). Whatever any page sends, the server decides what counts. */
    var runs = [], next = null, fetching = null;
    var ROUND_LIFE_MS = 15 * 60 * 1000;       // the server's limit
    var PREFETCH_LIFE_MS = 10 * 60 * 1000;    // a round fetched ahead is used within this, or fetched again
    var LEGACY = 'legacy-worker';
    function openRound(again) {
      return call('round', 'POST', {}).then(function (r) {
        if (notLinked(r) && !again) return ensurePlayer().then(function (e) { return e.ok ? openRound(true) : null; });
        if (r.status === 404 && r.data && r.data.error === 'not_found') return LEGACY;
        if (!r.ok || !r.data || typeof r.data.round_id !== 'string') return null;
        var seed = typeof r.data.seed === 'number' && r.data.seed >= 0 && r.data.seed <= 4294967295 ? r.data.seed : null;
        // the record format the Worker reads: 2 when it says so (or a later one, which still reads 2), otherwise 1
        var format = typeof r.data.record_format === 'number' && r.data.record_format >= RECORD_FORMAT ? RECORD_FORMAT : 1;
        return { id: r.data.round_id, seed: seed, engine: typeof r.data.engine === 'string' ? r.data.engine : null, format: format };
      }, function () { return null; });
    }
    /* Fetch the next run's round now, unless a fresh one is waiting or on its way. */
    function prefetch() {
      if (fetching) return fetching;
      if (next && now() - next.at < PREFETCH_LIFE_MS) return Promise.resolve(next);
      fetching = openRound().then(function (v) { fetching = null; next = v ? { v: v, at: now() } : null; return next; },
                                  function () { fetching = null; return null; });
      return fetching;
    }
    /* The round for a run being created right now (synchronous), and the next one is fetched. */
    function takeRound() {
      var n = next;
      next = null;
      prefetch();
      return n && now() - n.at < PREFETCH_LIFE_MS ? n.v : null;
    }
    function prune() {
      var t = now();
      runs = runs.filter(function (r) { return r.state !== 'done' && t - r.createdAt < ROUND_LIFE_MS; });
    }
    function runCreated(v) {
      // a run created but never started (the player picked another mode, or restarted) is let go
      runs.forEach(function (r) { if (r.state === 'ready') r.state = 'done'; });
      var seeded = v && v !== LEGACY && v.seed != null;
      var run = { round: v === LEGACY ? LEGACY : v ? v.id : null, seed: seeded ? v.seed : null, engine: v && v !== LEGACY ? v.engine : null,
                  record: seeded ? [] : null, format: seeded && v.format === RECORD_FORMAT ? RECORD_FORMAT : 1,
                  score: null, state: 'ready', tries: 0, createdAt: now() };
      runs.push(run);
      prune();
      return run;
    }
    function runStarted(run) { run.state = 'playing'; }
    function runFinished(run, score) {
      run.score = Math.floor(score) || 0;
      run.state = run.score > 0 ? 'finished' : 'done';     // the game does not send a score of 0
      prune();
    }
    /* The game's queue gives the score, not the run: the oldest run still waiting with that score is the one it sends
       (the queue is oldest first too). */
    function runFor(score) {
      prune();
      for (var i = 0; i < runs.length; i++) {
        var r = runs[i];
        if ((r.state === 'finished' || r.state === 'retry') && r.score === score) return r;
      }
      return null;
    }
    var UNRANKABLE = ['no-round', 'switched', 'outdated', 'expired'];   // not the player's doing: the run still pays by its time
    function done(run, why, extra) {
      run.state = 'done'; prune();
      if (run.casual && run.casual.deferred) {
        run.casual.deferred = false;
        if (UNRANKABLE.indexOf(why) >= 0) casualClaim(run.casual);       // refused for another reason (a replay that does not match): no coins
      }
      var out = { ok: false, reason: 'invalid', why: why };      // 'invalid' is a reason the game drops from its queue
      if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
      return out;
    }
    function submitScore(score) {
      var run = runFor(Math.floor(score));
      if (!run) return Promise.resolve({ ok: false, reason: 'invalid', why: 'no-round' });
      if (run.state === 'sending') return Promise.resolve({ ok: false, reason: 'rejected', why: 'busy' });
      if (!run.round) return Promise.resolve(done(run, 'no-round'));
      if (run.record && run.engine && run.engine !== ENGINE_SHA) return Promise.resolve(done(run, 'outdated'));
      run.state = 'sending';
      run.tries++;
      var body = { score: run.score, walls: true, golden: true, difficulty: 'hard' };
      if (run.round !== LEGACY) body.round_id = run.round;
      if (run.record) { body.record = (run.format === RECORD_FORMAT ? '@' + RECORD_FORMAT + ',' : '') + run.record.join(','); body.engine = ENGINE_SHA; }
      return call('score', 'POST', body).then(function (r) {
        var err = r.data && r.data.error;
        // a run that started under the previous Worker and ended after the new one went live cannot be ranked; the round
        // fetched ahead came from that Worker too, so it is dropped and a new one fetched for the next run
        if (r.status === 400 && (err === 'round_required' || err === 'replay_required')) { next = null; prefetch(); return done(run, 'switched'); }
        if (r.ok) {
          run.state = 'done'; prune();
          if (run.casual) { run.casual.byRank = r.data && r.data.wallet === true; run.casual.deferred = false; }
          if (r.data && r.data.wallet === true) walletApply(r.data);
          claimSoon();
          return { ok: true, improved: !!r.data.improved, best: Number(r.data.best) || 0, rank: r.data.rank == null ? null : Number(r.data.rank) };
        }
        if (r.code === 'account_changed' || r.status === 401) { run.state = 'retry'; return { ok: false, reason: 'rejected', why: 'signed-out' }; }
        if (r.status === 0 || r.status >= 500 || r.status === 429) {
          run.state = 'retry';
          return { ok: false, reason: r.code === 'timeout' ? 'timeout' : r.status === 0 ? 'network' : 'server', why: 'retry' };
        }
        if (err === 'round_closed' && run.tries > 1) {
          // an earlier try of this same round reached the server: it was counted then (or this round was replaced)
          return boardMe().then(function (me) { return done(run, 'already', { best: me.ok ? me.best : null }); });
        }
        return done(run, err === 'round_closed' ? 'closed' : err === 'round_expired' ? 'expired'
          : err === 'score_not_plausible' ? 'implausible' : err === 'round_not_found' ? 'no-round'
          : err === 'replay_mismatch' ? 'mismatch' : err === 'engine_mismatch' ? 'outdated' : 'refused');
      });
    }
    /* ---------- the wallet (supabase/wallet.sql) ---------- */
    var wallet = { on: false, pending: false, coins: 0, owned: {}, sink: null };
    var claimedTier = {};     // achievement tiers already sent this session: id -> highest tier
    function walletApply(d) {
      if (!d || d.wallet !== true) return;
      wallet.on = true; wallet.pending = false;
      wallet.coins = Math.max(0, Math.floor(Number(d.coins) || 0));
      wallet.owned = d.owned && typeof d.owned === 'object' && !Array.isArray(d.owned) ? d.owned : {};
      if (wallet.sink) wallet.sink({ coins: wallet.coins, owned: wallet.owned });
    }
    /* Ask for the server's wallet. False when this Worker has none (the game keeps its own coins) or the player's progress
       is not on the server yet. */
    function loadWallet() {
      return call('wallet', 'GET').then(function (r) {
        if (!r.ok || !r.data || r.data.wallet !== true) return false;
        if (r.data.pending) { wallet.pending = true; return false; }
        walletApply(r.data);
        claimSoon();
        return true;
      }, function () { return false; });
    }
    function walletBuy(id) {
      if (!wallet.on) return Promise.resolve({ ok: false, message: 'The shop needs a connection to your account.' });
      return call('wallet/buy', 'POST', { item: id }).then(function (r) {
        if (r.data && r.data.wallet === true) walletApply(r.data);       // the answer of a refused purchase carries the true balance
        if (r.ok || (r.status === 409 && r.data && r.data.error === 'already_owned')) return { ok: true };
        if (r.status === 402) return { ok: false, message: 'Not enough coins.' };
        return { ok: false, message: 'The purchase did not go through. Check your connection and try again.' };
      });
    }
    /* Every achievement tier the game shows as finished, once each; the server pays what it has not paid and no more. */
    function claimAchievements() {
      if (!wallet.on) return Promise.resolve();
      var a = exportLocal().data.ach, list = [];
      if (a && typeof a === 'object') Object.keys(a).forEach(function (id) {
        var t = a[id] && typeof a[id].tier === 'number' ? Math.floor(a[id].tier) : 0;
        for (var i = (claimedTier[id] || 0) + 1; i <= Math.min(t, 20); i++) list.push({ c: id, t: i });
      });
      if (!list.length) return Promise.resolve();
      list = list.slice(0, 80);
      return call('wallet/claims', 'POST', { claims: list }).then(function (r) {
        if (r.ok && r.data && r.data.wallet === true) {
          list.forEach(function (c) { claimedTier[c.c] = Math.max(claimedTier[c.c] || 0, c.t); });
          walletApply(r.data);
        }
      });
    }
    var claimTimer = null;
    function claimSoon() {
      if (!wallet.on || claimTimer) return;
      claimTimer = setTimeout(function () { claimTimer = null; claimAchievements(); }, 1500);
    }
    /* A run that is not paid by a ranked round: opened with the server when it starts, claimed when it ends. */
    function casualStart(mode) {
      if (!wallet.on) return null;
      var h = { id: null, score: 0, ended: false, byRank: false, claimed: false, deferred: false, opened: null };
      h.opened = call('run', 'POST', { mode: mode }).then(function (r) {
        if (r.ok && r.data && typeof r.data.run_id === 'string') h.id = r.data.run_id;
        return h;
      }, function () { return h; });
      return h;
    }
    function casualClaim(h) {
      if (!h || h.claimed || h.byRank || !h.ended || h.score <= 0) { claimSoon(); return Promise.resolve(); }
      h.claimed = true;
      return h.opened.then(function () {
        if (!h.id) return null;
        return call('run/claim', 'POST', { run_id: h.id, score: h.score }).then(function (r) { if (r.ok) walletApply(r.data); });
      }).then(function () { claimSoon(); });
    }
    /* The run is over. A ranked run waits for the board's answer first (it pays by replay, or, if it cannot be ranked, by time). */
    function casualEnd(h, score) {
      if (!h) return;
      h.ended = true; h.score = Math.max(0, Math.floor(score) || 0);
      if (!h.deferred) casualClaim(h);
    }
    function walletApi() {
      return {
        isOn: function () { return wallet.on; },
        buy: walletBuy,
        attach: function (sink) { wallet.sink = sink; if (wallet.on) sink({ coins: wallet.coins, owned: wallet.owned }); }
      };
    }

    function pendingRuns() { return runs.map(function (r) { return { round: r.round, seed: r.seed, score: r.score, state: r.state, tries: r.tries }; }); }

    return {
      account: account, bind: bind, state: state, verifySession: verifySession, owner: owner, useSlotOf: useSlotOf, claimDevice: claimDevice, ensurePlayer: ensurePlayer, fetchPlayer: fetchPlayer, decideSync: decideSync, refresh: refresh,
      link: link, linkWithCode: linkWithCode, localPlayerChecked: localPlayerChecked, useAccountName: useAccountName,
      writeIdentity: writeIdentity, useAccountSave: useAccountSave, useDeviceSave: useDeviceSave, syncNow: syncNow,
      boardMe: boardMe, prefetch: prefetch, takeRound: takeRound, runCreated: runCreated, runStarted: runStarted,
      runFinished: runFinished, submitScore: submitScore, pendingRuns: pendingRuns,
      loadWallet: loadWallet, walletApi: walletApi, casualStart: casualStart, casualEnd: casualEnd, claimAchievements: claimAchievements,
      walletOn: function () { return wallet.on; },
      exportLocal: exportLocal, backup: backup, backups: backups, localPlayer: localPlayer, localIsEmpty: localIsEmpty
    };
  }

  /* The game's board client, made account-only: who-am-I and scores go through the Worker, and no local player can be
     created or restored by name or code from inside the game. Reading the top ten stays as it is. */
  /* The engine: a Time Attack run is built from the seed of a round fetched ahead, and records what the page feeds it:
     s (start), p / r (pause / resume), ^ v < > (turns), and each frame's time as a whole number of milliseconds.
     Frame times are passed to the engine as whole milliseconds too (the remainder carries to the next frame), so what
     is recorded is exactly what ran. The 'over' listener is added before the page's own, so the run is closed before
     the game sends its score.
     Record format 2 (the Worker asks for it in its round): frame times in decimal, sent after an "@2" header. No control
     token contains a digit, so a frame time is never read back as a control. Format 1 (a round from a Worker that does
     not ask): base 36, as before. It is ambiguous: 25, 27, 28 and 31 ms are written p, r, s and v. */
  var TURN_TOKEN = { '0,-1': '^', '0,1': 'v', '-1,0': '<', '1,0': '>' };
  /* The coins of a run that is not paid by a ranked round: the server opens the run when it starts and the claim goes out when
     it ends (see the wallet in create()). deferred: a ranked run waits for the board's answer first. onOpen gets the handle. */
  function casualHook(g, core, mode, deferred, onOpen) {
    var h = null, start = g.start;
    g.start = function () {
      var was = g.state && g.state.phase, out = start.apply(g, arguments);
      if (was === 'ready' && g.state.phase !== 'ready' && !h) {
        h = core.casualStart(mode);
        if (h) { h.deferred = !!deferred; if (onOpen) onOpen(h); }
      }
      return out;
    };
    if (typeof g.on === 'function') g.on(function (e, S) { if (e && e.type === 'over' && h) core.casualEnd(h, S.score); });
  }
  function patchChase(chase, core) {
    if (!chase || chase.__account) return chase;
    var create = chase.create;
    chase.create = function () {
      var g = create.apply(chase, arguments);
      casualHook(g, core, 'chase', false);
      return g;
    };
    chase.__account = true;
    return chase;
  }
  function patchEngine(engine, core) {
    if (!engine || engine.__account) return engine;
    var create = engine.create;
    engine.create = function (opts) {
      if (!opts || opts.mode !== 'timeattack') {
        var g0 = create.apply(engine, arguments);
        casualHook(g0, core, opts && typeof opts.mode === 'string' ? opts.mode : 'classic', false);
        return g0;
      }
      var rankedRun = opts.tuning === engine.DIFFICULTY.hard;     // only the hard Time Attack run is a ranked round
      var v = core.takeRound();
      var seeded = v && typeof v === 'object' && v.seed != null;
      var g = create.call(engine, seeded ? Object.assign({}, opts, { rng: seededRng(v.seed) }) : opts);
      var run = core.runCreated(v), rec = run.record, carry = 0;
      casualHook(g, core, 'timeattack', rankedRun, function (h) { run.casual = h; });
      var start = g.start, pause = g.pause, resume = g.resume, turn = g.turn, update = g.update;
      g.start = function () {
        if (g.state.phase === 'ready') { if (rec) rec.push('s'); core.runStarted(run); }
        return start.apply(g, arguments);
      };
      if (rec) {
        g.pause = function () { if (g.state.phase === 'running') rec.push('p'); return pause.apply(g, arguments); };
        g.resume = function () { if (g.state.phase === 'paused') rec.push('r'); return resume.apply(g, arguments); };
        g.turn = function (dx, dy) { var t = TURN_TOKEN[dx + ',' + dy]; if (t && g.state.phase !== 'over') rec.push(t); return turn.apply(g, arguments); };
        g.update = function (dt) {
          if (g.state.phase !== 'running') return update.apply(g, arguments);
          carry += Math.min(Math.max(+dt || 0, 0), 100);
          var q = Math.floor(carry);
          carry -= q;
          rec.push(recordFrame(q, run.format));
          return update.call(g, q);
        };
      }
      if (typeof g.on === 'function') g.on(function (e, S) { if (e && e.type === 'over' && run.state === 'playing') core.runFinished(run, S.score); });
      return g;
    };
    engine.__account = true;
    return engine;
  }

  /* Why a score was not counted, in the game's own words (shown on the game-over screen in place of the generic text). */
  var WHY = {
    'no-round': 'This run was not registered with the board when it started, so it cannot be ranked.',
    switched: 'The board was updated during this run, so this one score cannot be ranked. The next run will be.',
    closed: 'This round was already sent to the board.',
    already: 'This round was already counted.',
    expired: 'This round is more than 15 minutes old, so it can no longer be ranked.',
    implausible: 'The board could not accept this score for the time this round took.',
    mismatch: 'The board could not verify this round from its replay, so it was not ranked.',
    outdated: 'The game was updated. Reload the page to play ranked rounds.',
    refused: 'The board did not accept this round.'
  };

  function patchBoard(board, core, explain) {
    if (!board || board.__account) return board;
    var no = function () { return Promise.resolve({ ok: false, reason: board.REASON ? board.REASON.rejected : 'rejected' }); };
    board.enrollPlayer = no;
    board.registerPlayer = no;
    board.resumePending = function () { return Promise.resolve({ ok: false, reason: 'none' }); };
    board.getMe = function () { return core.boardMe(); };
    board.submitBest = function (o) {
      if (!board.isRanked(o && o.settings)) return Promise.resolve({ ok: false, reason: board.REASON.notRanked });
      var v = board.validateScore(o.score);
      if (!v.ok) return Promise.resolve({ ok: false, reason: board.REASON.invalid });
      return core.submitScore(v.score).then(function (r) {
        core.syncNow();
        if (explain && r.why && WHY[r.why]) explain(WHY[r.why] + (r.why === 'already' && r.best != null ? ' Your best is ' + r.best + '.' : ''));
        return r;
      });
    };
    board.__account = true;
    return board;
  }

  /* ---------- the page ---------- */
  var SITE = 'https://atherbyte.online';
  var ACCOUNT_PAGE = '/account/?next=' + encodeURIComponent('/grid-snake/');
  var CHECK_EVERY_MS = 60000;    // while playing, the session is checked with the server this often (and on return)

  function runGame(win) {
    var doc = win.document, src = doc.getElementById('gs-game');
    if (!src || src.getAttribute('data-ran')) return;
    src.setAttribute('data-ran', '1');
    var s = doc.createElement('script');
    s.textContent = src.textContent;
    doc.body.appendChild(s);
  }

  var CSS = '#acGate{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;' +
    'background:rgba(8,8,22,.72);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);color:#e8e6f5;overflow:auto;' +
    'font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}' +
    '#acGate .ac-card{width:100%;max-width:420px;box-sizing:border-box;background:#141629;border:1px solid #2c2f52;border-radius:18px;' +
    'padding:28px 26px 22px;box-shadow:0 24px 70px rgba(0,0,0,.55)}' +
    '#acGate .ac-brand{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:20px}' +
    '#acGate .ac-brand img{width:46px;height:46px}#acGate .ac-brand b{display:block;font-size:24px;color:#fff}' +
    '#acGate .ac-brand span{font-size:14px;color:#a9a6c7}' +
    '#acGate .ac-tabs{display:flex;gap:6px;background:#1b1d36;border-radius:12px;padding:4px;margin-bottom:18px}' +
    '#acGate .ac-tabs button{flex:1;border:0;border-radius:9px;padding:10px;background:transparent;color:#c8c5e6;font:inherit;cursor:pointer}' +
    '#acGate .ac-tabs button[aria-selected=true]{background:#4a2fc2;color:#fff;font-weight:600}' +
    '#acGate .ac-field{position:relative;margin-bottom:12px}' +
    '#acGate .ac-field input{width:100%;box-sizing:border-box;padding:14px 44px 14px 14px;border-radius:12px;border:1px solid #33365c;' +
    'background:#101225;color:#fff;font:inherit}#acGate .ac-field input:focus{outline:2px solid #7c5cff;outline-offset:1px}' +
    '#acGate .ac-eye{position:absolute;right:8px;top:50%;transform:translateY(-50%);border:0;background:none;color:#a9a6c7;cursor:pointer;padding:6px;font:inherit}' +
    '#acGate .ac-main{width:100%;border:0;border-radius:12px;padding:14px;background:#6d3df5;color:#fff;font:600 16px/1 inherit;cursor:pointer;margin-top:4px}' +
    '#acGate .ac-main:disabled{opacity:.6;cursor:default}' +
    '#acGate .ac-sub{display:inline-block;border:1px solid #33365c;border-radius:12px;padding:11px 14px;background:#1b1d36;color:#e8e6f5;font:inherit;cursor:pointer;text-decoration:none}' +
    '#acGate .ac-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}' +
    '#acGate .ac-link{display:block;text-align:center;margin-top:14px;color:#a98bff;font-size:14px}' +
    '#acGate .ac-msg{min-height:1.2em;margin:4px 0 10px;color:#ff9ea8;font-size:14px}#acGate .ac-msg.ok{color:#9fe3b7}' +
    '#acGate .ac-text{margin:0 0 6px}#acGate .ac-check{display:flex;gap:8px;align-items:flex-start;font-size:13px;color:#c8c5e6;margin:4px 0 10px}' +
    '#acGate textarea{width:100%;box-sizing:border-box;min-height:70px;margin-top:10px;border-radius:10px;background:#101225;color:#c8c5e6;border:1px solid #33365c}' +
    '#acGate .ac-captcha{margin:6px 0 8px;min-height:0}';

  /* The overlay and its card. show() draws a message with buttons; signIn() draws the sign-in / create-account form. */
  function gateUi(win) {
    var doc = win.document;
    if (!doc.getElementById('acGateCss')) {
      var st = doc.createElement('style'); st.id = 'acGateCss'; st.textContent = CSS; doc.head.appendChild(st);
    }
    var g = doc.createElement('div');
    g.id = 'acGate';
    g.setAttribute('role', 'dialog');
    g.setAttribute('aria-modal', 'true');
    g.setAttribute('aria-labelledby', 'acGateTitle');
    g.innerHTML = '<div class="ac-card"><div class="ac-brand"><img src="/assets/images/atherbyte-mark.webp" alt=""><div>' +
      '<b id="acGateTitle">Atherbyte</b><span>Your games. Your account.</span></div></div><div id="acGateBody"></div></div>';
    doc.body.appendChild(g);
    var body = g.querySelector('#acGateBody');
    function el(tag, cls, text) { var e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    function button(b) {
      var e = el(b.href ? 'a' : 'button', b.primary ? 'ac-main' : 'ac-sub', b.label);
      if (b.href) e.href = b.href; else { e.type = 'button'; e.addEventListener('click', function () { e.disabled = true; b.run(); }); }
      return e;
    }
    return {
      el: g,
      code: null,
      show: function (message, buttons, opts) {
        opts = opts || {};
        body.textContent = '';
        var p = el('p', 'ac-text', message); p.id = 'acGateText'; p.setAttribute('aria-live', 'polite'); body.appendChild(p);
        this.code = null;
        if (opts.code) {
          var f = el('div', 'ac-field'), i = el('input');
          i.id = 'acGateCode'; i.placeholder = 'Recovery code (32 letters and digits)'; i.autocomplete = 'off'; i.spellcheck = false;
          i.setAttribute('aria-label', 'Recovery code');
          f.appendChild(i); body.appendChild(f); this.code = i;
        }
        var row = el('div', 'ac-row'); row.id = 'acGateActions';
        (buttons || []).forEach(function (b) { row.appendChild(button(b)); });
        body.appendChild(row);
        if (opts.backup) { var t = el('textarea'); t.id = 'acGateBackup'; t.readOnly = true; t.value = opts.backup; t.setAttribute('aria-label', 'Backup code'); body.appendChild(t); }
        var first = row.firstChild;
        if (first && first.focus) try { first.focus({ preventScroll: true }); } catch (e) {}
      },
      /* Sign in or create an Atherbyte account right here (the same account as the website). done() runs once signed in. */
      signIn: function (Account, message, done) {
        var cfg = (win.ATHERBYTE_CONFIG && win.ATHERBYTE_CONFIG.account) || {};
        var siteKey = cfg.turnstileSiteKey || '';
        var mode = 'login', widget = null, token = '';
        body.textContent = '';
        if (message) { var lead = el('p', 'ac-text', message); lead.id = 'acGateText'; body.appendChild(lead); }
        var tabs = el('div', 'ac-tabs'); tabs.setAttribute('role', 'tablist');
        var tIn = el('button', '', 'Sign In'), tUp = el('button', '', 'Create Account');
        [tIn, tUp].forEach(function (t) { t.type = 'button'; t.setAttribute('role', 'tab'); tabs.appendChild(t); });
        var form = el('form'); form.id = 'acSignIn'; form.noValidate = true;
        function field(id, type, placeholder, auto) {
          var f = el('div', 'ac-field'), i = el('input'); i.id = id; i.type = type; i.placeholder = placeholder; i.autocomplete = auto;
          i.setAttribute('aria-label', placeholder); f.appendChild(i); form.appendChild(f); return { box: f, input: i };
        }
        var user = field('acUser', 'text', 'Username', 'username');
        user.input.autocapitalize = 'none'; user.input.spellcheck = false;
        var pass = field('acPass', 'password', 'Password', 'current-password');
        var eye = el('button', 'ac-eye', 'Show'); eye.type = 'button'; eye.setAttribute('aria-label', 'Show password');
        eye.addEventListener('click', function () { var on = pass.input.type === 'password'; pass.input.type = on ? 'text' : 'password'; eye.textContent = on ? 'Hide' : 'Show'; });
        pass.box.appendChild(eye);
        var ack = el('label', 'ac-check'); var box = el('input'); box.type = 'checkbox'; box.id = 'acAck';
        ack.appendChild(box); ack.appendChild(doc.createTextNode('I understand: without a verified recovery email (added later in my account), a lost password cannot be recovered.'));
        form.appendChild(ack);
        var cap = el('div', 'ac-captcha'); form.appendChild(cap);
        var msg = el('p', 'ac-msg'); msg.id = 'acSignInMsg'; msg.setAttribute('aria-live', 'polite'); form.appendChild(msg);
        var go = el('button', 'ac-main', 'Sign In'); go.type = 'submit'; form.appendChild(go);
        var forgot = el('a', 'ac-link', 'Forgot your password?'); forgot.href = ACCOUNT_PAGE;
        body.appendChild(tabs); body.appendChild(form); body.appendChild(forgot);

        function select(m) {
          mode = m;
          tIn.setAttribute('aria-selected', String(m === 'login')); tUp.setAttribute('aria-selected', String(m === 'register'));
          ack.hidden = m !== 'register'; forgot.hidden = m !== 'login';
          go.textContent = m === 'login' ? 'Sign In' : 'Create Account';
          pass.input.autocomplete = m === 'login' ? 'current-password' : 'new-password';
          pass.input.placeholder = m === 'login' ? 'Password' : 'Password (8 characters or more)';
          msg.textContent = ''; msg.className = 'ac-msg';
          resetCaptcha();
        }
        function resetCaptcha() { token = ''; if (widget !== null && win.turnstile) { try { win.turnstile.reset(widget); } catch (e) {} } }
        function renderCaptcha() {
          if (!siteKey || !win.turnstile || widget !== null) return;
          widget = win.turnstile.render(cap, { sitekey: siteKey, theme: 'dark',
            callback: function (t) { token = t; }, 'expired-callback': function () { token = ''; }, 'error-callback': function () { token = ''; } });
        }
        if (siteKey) {
          if (win.turnstile) renderCaptcha();
          else {
            win.__gsTurnstileReady = renderCaptcha;
            var s = doc.createElement('script');
            s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__gsTurnstileReady';
            s.async = true; doc.head.appendChild(s);
          }
        }
        tIn.addEventListener('click', function () { select('login'); });
        tUp.addEventListener('click', function () { select('register'); });
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          msg.className = 'ac-msg'; msg.textContent = '';
          if (mode === 'register' && !box.checked) { msg.textContent = 'Please tick the box to confirm you read the recovery note.'; box.focus(); return; }
          if (siteKey && !token) { msg.textContent = Account.messageFor('captcha_missing'); return; }
          go.disabled = true;
          var call = mode === 'login' ? Account.login(user.input.value.trim(), pass.input.value, token) : Account.register(user.input.value.trim(), pass.input.value, token);
          call.then(function (r) {
            go.disabled = false;
            resetCaptcha();
            if (!r.ok) { msg.textContent = r.message; return; }
            pass.input.value = '';
            if (!r.signedIn) { select('login'); user.input.value = (r.user && r.user.username) || ''; msg.className = 'ac-msg ok'; msg.textContent = 'Account created. Please sign in.'; return; }
            done();
          }, function () { go.disabled = false; msg.textContent = Account.messageFor('network'); });
        });
        select('login');
        try { user.input.focus({ preventScroll: true }); } catch (e) {}
      },
      close: function () { g.remove(); }
    };
  }

  /* While playing: the moment the account signs out (here, on the website in another tab, or on the server), the game
     is covered and its keys and clicks stop. The previous player's data is not shown again. A new sign-in restarts the
     page so the next account starts from its own data. */
  function watch(win, core, Account) {
    var who = Account.username(), locked = false, doc = win.document;
    function lock() {
      if (locked) return;
      locked = true;
      ['keydown', 'keyup', 'keypress', 'pointerdown', 'touchstart', 'click', 'wheel'].forEach(function (t) {
        win.addEventListener(t, function (e) { if (!e.target || !e.target.closest || !e.target.closest('#acGate')) { e.stopImmediatePropagation(); if (t !== 'pointerdown' && t !== 'touchstart') e.preventDefault(); } }, true);
      });
      Array.prototype.forEach.call(doc.querySelectorAll('dialog[open]'), function (d) { try { d.close(); } catch (e) {} });
      gateUi(win).signIn(Account, 'You signed out of Atherbyte. Sign in to keep playing.', function () { win.location.reload(); });
    }
    Account.onChange(function () { if (Account.username() !== who) lock(); });
    function check() { if (!locked) core.verifySession().then(function (s) { if (s === 'signed-out') lock(); }); }
    win.setInterval(check, CHECK_EVERY_MS);
    doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'visible') check(); });
    win.addEventListener('focus', check);
    return { lock: lock };
  }

  /* Signed in and the player settled: write the identity, make the board account-only, and start the game. */
  function startGame(win, core, ui, name, Account) {
    core.claimDevice();
    core.bind();
    core.writeIdentity(name);
    var board, engine;
    // after the game has written its own (generic) message for this score, the precise reason replaces it
    function explain(text) {
      win.setTimeout(function () {
        var row = win.document.getElementById('ovRankRow'), msg = win.document.getElementById('ovRankMsg');
        if (row && msg && !row.hidden) msg.textContent = text;
      }, 0);
    }
    try {
      var chase;
      Object.defineProperty(win, 'SnakeChase', { configurable: true, get: function () { return chase; },
        set: function (v) { chase = patchChase(v, core); } });
    } catch (e) { /* defined already: patched below */ }
    try {
      Object.defineProperty(win, 'SnakeLeaderboard', { configurable: true, get: function () { return board; },
        set: function (v) { board = patchBoard(v, core, explain); } });
      Object.defineProperty(win, 'SnakeEngine', { configurable: true, get: function () { return engine; },
        set: function (v) { engine = patchEngine(v, core); } });
    } catch (e) { /* defined already: patched below */ }
    // The game creates its first round as soon as it runs (when Time Attack is the chosen mode), so the first ranked
    // round is fetched BEFORE the game runs. A slow answer delays the start by 4 s at most; a new account (no player
    // yet) gets its player, and its first round, with its first Time Attack run.
    var ready = core.state.linked ? Promise.race([core.prefetch(), new Promise(function (r) { win.setTimeout(r, 4000); })]) : Promise.resolve();
    // The server's wallet is read before the game runs, so the game starts with the true coins and items. A Worker without a
    // wallet (or no answer in 4 s) leaves the game on its own coins; SnakeWallet.isOn() then stays false. When the wallet
    // answers later (a new player is made, or the answer was slow) the game takes it as soon as it arrives.
    win.SnakeWallet = core.walletApi();
    if (core.state.linked) ready = Promise.all([ready, Promise.race([core.loadWallet(), new Promise(function (r) { win.setTimeout(r, 4000); })])]);
    ui.show('Starting Grid Snake…', []);
    return ready.then(function () {
      ui.close();
      runGame(win);
      if (win.SnakeLeaderboard) patchBoard(win.SnakeLeaderboard, core, explain);
      if (win.SnakeEngine) patchEngine(win.SnakeEngine, core);
      if (win.SnakeChase) patchChase(win.SnakeChase, core);
      var w = watch(win, core, Account);
      mountPanel(win, core, name, Account, w);
    });
  }

  function gate(win, Account) {
    var ui = gateUi(win);
    var core = create({ account: Account, storage: win.localStorage });
    var retry = function () { return [{ label: 'Try again', primary: true, run: step }]; };

    function lastBackup() { var b = core.backups()[0]; return b ? b.code : ''; }
    function finish() {
      // the name: the account's username, set by the server on the same player (skipped when it already matches)
      var p = core.state.name === Account.username() ? Promise.resolve({ ok: true, name: core.state.name }) : core.useAccountName(false);
      return p.then(function (r) {
        var name = r.ok ? r.name : core.state.name;
        return core.decideSync().then(function () {
          if (core.state.phase === 'conflict') return conflict(name);
          if (core.state.phase === 'error') return ui.show(core.state.message, retry());
          startGame(win, core, ui, name, Account);
        });
      });
    }
    function conflict(name) {
      ui.show('This device and your Atherbyte account have different Grid Snake progress. Choose which one to keep. ' +
        'The other is kept as a backup.', [
        { label: 'Use my account\'s progress', primary: true, run: function () { core.useAccountSave().then(function () { startGame(win, core, ui, name, Account); }); } },
        { label: 'Keep this device\'s progress', run: function () { core.useDeviceSave().then(function (r) { if (r.ok) startGame(win, core, ui, name, Account); else ui.show(r.message, retry()); }); } }
      ]);
    }
    /* An old player's progress is on this device without an owner and without a code that matches: never guess. */
    function choose(message) {
      core.backup('before-choice');
      ui.show((message ? message + ' ' : '') +
        'This device has Grid Snake progress that is not linked to any account. It is safe (backup code below). ' +
        'If it is yours, enter its recovery code (Profile > Show recovery code on the device you played on). ' +
        'Or start as ' + Account.username() + ' and keep this device\'s progress.', [
        { label: 'Link my recovery code', primary: true, run: function () {
          core.linkWithCode(ui.code ? ui.code.value : '').then(function (r) { if (r.ok) core.fetchPlayer().then(finish); else choose(r.message); });
        } },
        { label: 'Start as ' + Account.username() + ' with this progress', run: function () {
          core.useAccountName(true).then(function (r) {
            if (!r.ok) return choose(r.message);
            return core.fetchPlayer().then(function (ok) { if (!ok) return ui.show(core.state.message, retry()); return core.useDeviceSave().then(finish); });
          });
        } }
      ], { code: true, backup: lastBackup() });
    }

    function step() {
      ui.show('Checking your Atherbyte account…', []);
      core.verifySession().then(function (s) {
        if (s === 'signed-out') return ui.signIn(Account, 'Sign in to play Grid Snake. Your player, coins, skins and achievements stay with your account.', step);
        if (s !== 'ok') return ui.show('Could not reach your Atherbyte account. Check your connection and try again.', retry());
        // this account's own data on the device: another account's data is put aside untouched, this one's comes back
        var slot = core.useSlotOf(Account.getSession().user.id);
        if (slot === 'storage') return ui.show('This browser will not keep game data, so Grid Snake cannot start safely here.', retry());
        return core.fetchPlayer().then(function (ok) {
          if (!ok) return ui.show(core.state.message, retry());
          var lp = core.localPlayer();
          if (lp && !core.localPlayerChecked()) {
            // a player on the device whose code was never confirmed for this account: its code decides, never the name
            return core.linkWithCode(lp.secret).then(function (r) {
              if (r.ok) return core.fetchPlayer().then(finish);
              if (r.code === 'unknown_player') return core.state.linked ? finish() : (core.localIsEmpty() ? startGame(win, core, ui, Account.username(), Account) : choose(''));
              if (r.code === 'account_has_player' || r.code === 'player_linked_elsewhere') return otherPlayer(lp, r.code);
              return ui.show(r.message, retry());
            });
          }
          if (core.state.linked) return finish();
          if (slot === 'unclaimed' && !core.localIsEmpty()) return choose('');
          // a new account: it plays at once; its player is made on the server with its first save or score
          core.state.phase = 'linked';
          startGame(win, core, ui, Account.username(), Account);
        });
      });
    }
    /* A genuine conflict: the code on this device belongs to a different player than this account's. */
    function otherPlayer(lp, code) {
      var other = lp.name || 'The player on this device';
      ui.show(other + (code === 'account_has_player'
        ? ' is a different Grid Snake player from the one linked to your account.'
        : ' is linked to a different Atherbyte account. Sign in with that account to play as ' + other + '.') +
        ' Its progress and recovery code stay on this device as a backup.',
        (code === 'player_linked_elsewhere' ? [{ label: 'Sign in with another account', run: function () { Account.logout().then(step); } }] : []).concat(
          core.state.linked ? [{ label: 'Play as ' + core.state.name, primary: true, run: function () { core.backup('other-player'); finish(); } }]
                            : [{ label: 'Start as ' + Account.username(), primary: true, run: function () { core.backup('other-player'); choose(''); } }]),
        { backup: lastBackup() });
    }
    step();
  }

  /* Profile > Atherbyte account: who is signed in, sign out, an old player's code (until this account has a player),
     and the latest backup code. */
  function mountPanel(win, core, name, Account, w) {
    var doc = win.document, dlg = doc.getElementById('profileDlg');
    if (!dlg) return;
    var box = doc.createElement('details');
    box.className = 'pf-backup';
    box.open = true;
    box.innerHTML = '<summary>Atherbyte account</summary><p class="pf-status" id="acStatus"></p><div class="pf-row" id="acActions"></div>' +
      '<div class="pf-row" id="acLinkRow" hidden><input class="pf-code" id="acLinkCode" placeholder="Old player\'s recovery code" aria-label="Recovery code of an old player"></div>' +
      '<textarea class="pf-code" id="acBackup" readonly hidden aria-label="Backup code"></textarea>';
    var anchor = doc.getElementById('pfBackupSummary');
    (anchor && anchor.parentNode ? anchor.parentNode.parentNode : dlg).insertBefore(box, anchor && anchor.parentNode ? anchor.parentNode : null);
    var status = box.querySelector('#acStatus'), actions = box.querySelector('#acActions');
    status.textContent = 'Signed in as ' + name + '. Your progress is kept with your Atherbyte account.';
    function add(label, fn) { var b = doc.createElement('button'); b.className = 'btn'; b.type = 'button'; b.textContent = label; b.addEventListener('click', fn); actions.appendChild(b); return b; }
    add('Sign out', function () { Account.logout().then(function () { w.lock(); }); });
    add('Show my last backup code', function () { var l = core.backups()[0], t = box.querySelector('#acBackup'); t.hidden = !l; t.value = l ? l.code : ''; });
    if (!core.state.linked) {
      var row = box.querySelector('#acLinkRow'); row.hidden = false;
      var lb = add('Link an old player', function () {
        core.linkWithCode(box.querySelector('#acLinkCode').value).then(function (r) {
          if (r.ok) { status.textContent = 'Linked. Reloading with your player…'; win.location.reload(); }
          else status.textContent = r.message;
        });
      });
      lb.title = 'Played Grid Snake before signing up? Bring your old player here with its recovery code.';
    }
    dlg.addEventListener('close', function () { core.syncNow(); });
    doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'hidden') core.syncNow(); });
  }

  /* On the studio site: sign-in first. Anywhere else (a local file, a test page, another host) the game starts as before:
     the account service only answers atherbyte.online. */
  function boot(win) {
    if (!win.location || win.location.origin !== SITE) { runGame(win); return; }
    var doc = win.document;
    function load(src, next, failed) {
      var s = doc.createElement('script');
      s.src = src; s.onload = next; s.onerror = failed;
      doc.body.appendChild(s);
    }
    function down() {
      gateUi(win).show('Could not load the Atherbyte sign-in. Check your connection and reload the page.',
        [{ label: 'Reload', primary: true, run: function () { win.location.reload(); } }]);
    }
    load('/js/site-config.js', function () {
      load('/js/atherbyte-account.js', function () {
        var Account = win.AtherbyteAccount && win.AtherbyteAccount.get ? win.AtherbyteAccount.get() : null;
        if (!Account || !Account.isConfigured() || !Account.storageAvailable()) return down();
        gate(win, Account);
      }, down);
    }, down);
  }

  return { create: create, patchBoard: patchBoard, patchEngine: patchEngine, patchChase: patchChase, seededRng: seededRng, ENGINE_SHA: ENGINE_SHA,
           RECORD_FORMAT: RECORD_FORMAT, recordFrame: recordFrame, boot: boot, BACKUP_KEY: BACKUP_KEY, SYNC_KEY: SYNC_KEY, LOCAL_ONLY_KEY: LOCAL_ONLY_KEY,
           OWNER_KEY: OWNER_KEY, SLOT_PREFIX: SLOT_PREFIX };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeAccountLink;
else if (typeof window !== 'undefined') { try { SnakeAccountLink.boot(window); } catch (e) { /* see boot: on failure the game stays stopped on the studio site */ } }
