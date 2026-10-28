/* Grid Snake and the Atherbyte account (WEB PAGE ONLY: build.js adds it to index.html, never to grid-snake.html,
 * so the Android app and the claude.ai copy are unchanged).
 *
 * What it does, through the Atherbyte API (the Worker), with the signed-in Atherbyte session:
 *  - Link: proves this device's player is ours by sending its recovery code once; the server links that player
 *    (same id, name, score and rank) to the account. A name alone never links anything.
 *  - Save: copies this device's progress (coins, shop items, achievements, settings, local bests) to the account.
 *    Every save carries the version it was based on; if another device saved in between, nothing is written and the
 *    player chooses. One device never silently replaces another's progress.
 *  - Restore: an empty device takes the account's copy. A device with its own progress asks first.
 *  - Before ANY import, and before linking, the device's progress is kept as a backup code (GS2., the same format as
 *    Profile > Backup and restore), the last five of them.
 *  - Ranked Time Attack scores of the linked player go through the Worker (the browser cannot write to the board).
 *
 * The core (create) has no DOM and is tested in tests/account_link.test.js. mount() adds the panel to the page.
 */
var SnakeAccountLink = (function () {
  'use strict';

  var PLAYER_KEY = 'gridsnake-player-v1';
  var PENDING_KEY = 'gridsnake-pending-player-v1';
  var PROFILE_KEY = 'gridsnake-profile-v2';
  var BEST_PREFIX = 'gridsnake-best-';
  var BACKUP_KEY = 'gridsnake-backups-v1';
  var SYNC_KEY = 'gridsnake-account-sync-v1';     // { [account id]: { version } }: the save version this device last had
  var BACKUPS_KEPT = 5;
  var API = '/v1/games/grid-snake/';

  function b64(str) {
    if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64');
    return btoa(unescape(encodeURIComponent(str)));
  }
  function parse(v) { try { return JSON.parse(v); } catch (e) { return null; } }
  function sameName(a, b) { return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase(); }

  /* o: { account (AtherbyteAccount client), storage, now } */
  function create(o) {
    var account = o.account, storage = o.storage;
    var now = o.now || function () { return Date.now(); };
    var state = { phase: 'idle', linked: false, name: '', server: null, message: '' };

    function get(k) { try { return storage.getItem(k); } catch (e) { return null; } }
    function set(k, v) { try { storage.setItem(k, v); return true; } catch (e) { return false; } }
    function keys() {
      var out = [];
      try { for (var i = 0; i < storage.length; i++) out.push(storage.key(i)); } catch (e) {}
      return out;
    }

    function localPlayer() {
      var p = parse(get(PLAYER_KEY));
      return p && typeof p.name === 'string' && typeof p.secret === 'string' ? p : null;
    }
    function accountId() {
      var s = account && account.getSession ? account.getSession() : null;
      return s && s.user && s.user.id ? String(s.user.id) : '';
    }
    function syncInfo() {
      var all = parse(get(SYNC_KEY)) || {};
      return all[accountId()] || null;
    }
    /* version: the account's save version this device now matches; at: the device's savedAt at that moment. */
    function setSync(version, at) {
      var all = parse(get(SYNC_KEY)) || {};
      all[accountId()] = { version: version, at: at || 0 };
      set(SYNC_KEY, JSON.stringify(all));
    }

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

    /* Keeps the device's progress as a GS2 code before anything replaces it. Returns the code. */
    function backup(reason) {
      var code = 'GS2.' + b64(JSON.stringify(exportLocal()));
      var list = parse(get(BACKUP_KEY));
      if (!Array.isArray(list)) list = [];
      list.unshift({ at: now(), reason: reason, code: code });
      if (!set(BACKUP_KEY, JSON.stringify(list.slice(0, BACKUPS_KEPT)))) return null;
      return code;
    }
    function backups() { var l = parse(get(BACKUP_KEY)); return Array.isArray(l) ? l : []; }

    /* Replaces the device's progress with a save (only ever called after backup() and, if the device had progress,
       after the player chose it). The game reads it on the next page load. */
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

    function call(path, method, body) {
      return account.authed(API + path, method === 'GET' ? undefined : { method: method, body: body });
    }
    function fail(message) { state.message = message; return { ok: false, message: message }; }

    /* Reads the account's player. Then: nothing to do, a first upload, an automatic restore into an empty device,
       or a conflict for the player to settle. Never overwrites progress on either side by itself. */
    function refresh() {
      if (!account || !account.isConfigured() || !account.hasSession()) { state.phase = 'signed-out'; return Promise.resolve(state); }
      state.phase = 'loading';
      return call('player', 'GET').then(function (r) {
        if (!r.ok) { state.phase = 'error'; fail(r.status === 503 ? 'Account linking is not available yet.' : 'Could not reach your Atherbyte account.'); return state; }
        state.server = r.data;
        state.linked = !!r.data.linked;
        state.name = r.data.linked ? r.data.name : '';
        if (!state.linked) { state.phase = 'unlinked'; return state; }
        var lp = localPlayer();
        if (lp && !sameName(lp.name, state.name)) { state.phase = 'other-player'; return state; }
        var save = r.data.save, mine = syncInfo();
        if (!save) {
          // the first copy comes from the linked player's device; progress of a device with no player is only sent if chosen
          if (lp || localIsEmpty()) return upload(null).then(function () { return state; });
          state.phase = 'conflict';
          return state;
        }
        if (mine && mine.version === save.version) { state.phase = 'linked'; return state; }
        // take the account's newer copy only when this device has nothing of its own to lose
        if (localIsEmpty() || (mine && mine.version < save.version && !changedSince(mine))) {
          if (!backup('before-restore')) { state.phase = 'conflict'; return state; }
          importSave(save.data);
          setSync(save.version, save.data && save.data.savedAt);
          state.phase = 'restored';
          return state;
        }
        state.phase = 'conflict';
        return state;
      });
    }
    /* Progress written on this device after its last sync (the game stamps every profile save with savedAt). */
    function changedSince(mine) { return exportLocal().savedAt > (mine.at || 0); }

    function upload(base) {
      var data = exportLocal();
      return call('save', 'POST', { data: data, base_version: base }).then(function (r) {
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

    /* Link this device's player to the signed-in account. */
    function link() {
      var lp = localPlayer();
      if (!lp) return Promise.resolve(fail(get(PENDING_KEY) ? 'Finish creating your player first.' : 'This device has no player with a recovery code to link.'));
      if (!backup('before-link')) return Promise.resolve(fail('This browser will not keep a backup, so linking is not started.'));
      return call('link', 'POST', { recovery_code: lp.secret }).then(function (r) {
        if (!r.ok) {
          var code = r.data && r.data.error;
          if (code === 'player_linked_elsewhere') return fail('This player is already linked to another Atherbyte account.');
          if (code === 'account_has_player') return fail('This Atherbyte account is already linked to another player.');
          if (code === 'unknown_player') return fail('The board does not know this device\'s player. Restore it with your recovery code first.');
          if (r.status === 429) return fail('Too many tries. Wait a minute and try again.');
          return fail('Linking did not work just now. Nothing was changed.');
        }
        return refresh().then(function () { return { ok: true }; });
      });
    }

    /* The player settles a conflict. Both choices keep a backup of what is replaced: the device's as a GS2 code here,
       the account's as a server-side copy (the database keeps the replaced saves). */
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
      if (state.phase !== 'linked') return Promise.resolve({ ok: false });
      var mine = syncInfo();
      if (mine && !changedSince(mine)) return Promise.resolve({ ok: true });   // nothing new since the last save
      return upload(mine ? mine.version : null);
    }

    /* Ranked scores of the linked player go through the Worker. Another player on this device keeps the old path. */
    function routesScores() {
      var lp = localPlayer();
      return !!(state.linked && lp && sameName(lp.name, state.name) && account.hasSession());
    }
    function submitScore(score) {
      return call('score', 'POST', { score: score, walls: true, golden: true, difficulty: 'hard' }).then(function (r) {
        if (r.ok) return { ok: true, improved: !!r.data.improved, best: Number(r.data.best) || 0, rank: r.data.rank == null ? null : Number(r.data.rank) };
        if (r.status === 0) return { ok: false, reason: r.code === 'timeout' ? 'timeout' : 'network' };
        if (r.status >= 500) return { ok: false, reason: 'server' };
        if (r.status === 400) return { ok: false, reason: 'invalid' };
        return { ok: false, reason: 'rejected' };
      });
    }

    return {
      state: state, refresh: refresh, link: link, useAccountSave: useAccountSave, useDeviceSave: useDeviceSave,
      syncNow: syncNow, routesScores: routesScores, submitScore: submitScore,
      exportLocal: exportLocal, backup: backup, backups: backups, localPlayer: localPlayer, localIsEmpty: localIsEmpty
    };
  }

  /* ---------- the page: a panel in Profile, and the score route ---------- */
  function mount(win) {
    var doc = win.document;
    var Account = win.AtherbyteAccount && win.AtherbyteAccount.get ? win.AtherbyteAccount.get() : null;
    if (!Account || !Account.isConfigured() || !Account.storageAvailable()) return null;
    var core = create({ account: Account, storage: win.localStorage });
    var dlg = doc.getElementById('profileDlg');
    if (!dlg) return null;

    var box = doc.createElement('details');
    box.className = 'pf-backup';
    box.open = true;
    box.innerHTML = '<summary>Atherbyte account</summary><p class="pf-status" id="acStatus" aria-live="polite"></p>' +
      '<div class="pf-row" id="acActions"></div><textarea class="pf-code" id="acBackup" readonly hidden aria-label="Backup code"></textarea>';
    var anchor = doc.getElementById('pfBackupSummary');
    (anchor && anchor.parentNode ? anchor.parentNode.parentNode : dlg).insertBefore(box, anchor && anchor.parentNode ? anchor.parentNode : null);
    var statusEl = box.querySelector('#acStatus'), actions = box.querySelector('#acActions'), codeEl = box.querySelector('#acBackup');

    function button(label, fn) {
      var b = doc.createElement('button');
      b.className = 'btn'; b.type = 'button'; b.textContent = label;
      b.addEventListener('click', function () {
        b.disabled = true;
        Promise.resolve().then(fn).then(render, render);
      });
      actions.appendChild(b);
    }
    function showBackup() {
      var last = core.backups()[0];
      codeEl.hidden = !last; codeEl.value = last ? last.code : '';
    }
    function render() {
      var s = core.state;
      actions.textContent = '';
      var text = {
        'signed-out': 'Sign in to keep this player, your coins, shop items and achievements on your Atherbyte account.',
        loading: 'Checking your Atherbyte account…',
        unlinked: 'Signed in as ' + Account.username() + '. Link this device\'s player to keep it with your account.',
        linked: 'Linked: ' + s.name + ' is kept with your account ' + Account.username() + '.',
        restored: 'Your saved progress was restored. A backup of this device\'s progress was kept first. Reload to play with it.',
        conflict: 'This device and your account have different progress. Choose which one to keep. The other is kept as a backup.',
        'other-player': 'Your account is linked to ' + s.name + ', but this device plays as another player. Nothing is shared until this device uses ' + s.name + '.',
        error: s.message
      }[s.phase] || '';
      statusEl.textContent = s.message && s.phase !== 'error' && s.phase !== 'linked' ? text + ' ' + s.message : text;
      s.message = '';
      if (s.phase === 'signed-out') button('Sign in', function () { Account.requireAccount({ next: win.location.pathname }); });
      if (s.phase === 'unlinked') button('Link this player', function () {
        var lp = core.localPlayer();
        if (lp && !win.confirm('Link ' + lp.name + ' to the Atherbyte account ' + Account.username() + '?\n\nYour name, best score and rank stay the same. ' +
          'This cannot be moved to another account later. A backup of this device\'s progress is kept first.')) return null;
        return core.link().then(showBackup);
      });
      if (s.phase === 'conflict') {
        button('Use the account\'s progress', function () { return core.useAccountSave().then(showBackup); });
        button('Keep this device\'s progress', function () { return core.useDeviceSave(); });
      }
      if (s.phase === 'restored') button('Reload', function () { win.location.reload(); });
      if (s.phase !== 'signed-out' && s.phase !== 'loading') button('Show my last backup code', showBackup);
    }

    /* Ranked scores: the linked player's go to the Worker. */
    var Board = win.SnakeLeaderboard;
    if (Board && typeof Board.submitBest === 'function') {
      var original = Board.submitBest;
      Board.submitBest = function (o) {
        if (!core.routesScores()) return original.apply(Board, arguments);
        if (!Board.isRanked(o && o.settings)) return Promise.resolve({ ok: false, reason: Board.REASON.notRanked });
        var v = Board.validateScore(o.score);
        if (!v.ok) return Promise.resolve({ ok: false, reason: Board.REASON.invalid });
        return core.submitScore(v.score).then(function (r) { core.syncNow(); return r; });
      };
    }

    dlg.addEventListener('close', function () { core.syncNow(); });
    doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'hidden') core.syncNow(); });
    // sign-in, sign-out or another account (a token refresh alone changes nothing here)
    var who = Account.username();
    Account.onChange(function () {
      if (Account.username() === who) return;
      who = Account.username();
      core.refresh().then(render);
    });
    render();
    core.refresh().then(render);
    return core;
  }

  /* Only on the studio site: there, the site's config and account client are served at /js/. Anywhere else (a local
     file, a test page, another host) nothing is loaded and the game is exactly as before. */
  var SITE = 'https://atherbyte.online';
  function boot(win) {
    if (!win.location || win.location.origin !== SITE) return;
    var doc = win.document;
    function load(src, next) {
      var s = doc.createElement('script');
      s.src = src;
      s.onload = next;
      doc.body.appendChild(s);
    }
    load('/js/site-config.js', function () {
      load('/js/atherbyte-account.js', function () { try { mount(win); } catch (e) { /* the game never depends on this */ } });
    });
  }

  return { create: create, mount: mount, boot: boot, BACKUP_KEY: BACKUP_KEY, SYNC_KEY: SYNC_KEY };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeAccountLink;
else if (typeof window !== 'undefined') { try { SnakeAccountLink.boot(window); } catch (e) { /* the game never depends on this */ } }
