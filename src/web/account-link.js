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
  var BACKUPS_KEPT = 5;
  var API = '/v1/games/grid-snake/';
  var CODE_RE = /^[0-9a-f]{32}$/;

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
    function keys() {
      var out = [];
      try { for (var i = 0; i < storage.length; i++) out.push(storage.key(i)); } catch (e) {}
      return out;
    }

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

    function call(path, method, body) {
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
        if (r.status === 0) return { ok: false, reason: 'network' };
        return { ok: false, reason: 'rejected' };
      });
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
      account: account, state: state, verifySession: verifySession, fetchPlayer: fetchPlayer, decideSync: decideSync, refresh: refresh,
      link: link, linkWithCode: linkWithCode, localPlayerChecked: localPlayerChecked, useAccountName: useAccountName,
      writeIdentity: writeIdentity, useAccountSave: useAccountSave, useDeviceSave: useDeviceSave, syncNow: syncNow,
      boardMe: boardMe, submitScore: submitScore,
      exportLocal: exportLocal, backup: backup, backups: backups, localPlayer: localPlayer, localIsEmpty: localIsEmpty
    };
  }

  /* The game's board client, made account-only: who-am-I and scores go through the Worker, and no local player can be
     created or restored by name or code from inside the game. Reading the top ten stays as it is. */
  function patchBoard(board, core) {
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
      return core.submitScore(v.score).then(function (r) { core.syncNow(); return r; });
    };
    board.__account = true;
    return board;
  }

  /* ---------- the page ---------- */
  var SITE = 'https://atherbyte.online';
  var NEXT = '/account/?next=' + encodeURIComponent('/grid-snake/');

  function runGame(win) {
    var doc = win.document, src = doc.getElementById('gs-game');
    if (!src || src.getAttribute('data-ran')) return;
    src.setAttribute('data-ran', '1');
    var s = doc.createElement('script');
    s.textContent = src.textContent;
    doc.body.appendChild(s);
  }

  /* The sign-in screen. Every step's text and buttons are set by show(). */
  function gateUi(doc) {
    var g = doc.createElement('div');
    g.id = 'acGate';
    g.setAttribute('role', 'dialog');
    g.setAttribute('aria-modal', 'true');
    g.setAttribute('aria-labelledby', 'acGateTitle');
    g.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;' +
      'background:var(--bg,#121413);color:var(--text,#eee);overflow:auto';
    g.innerHTML = '<div style="max-width:420px;width:100%">' +
      '<h2 id="acGateTitle" style="margin:0 0 8px">Grid Snake</h2><p id="acGateText" aria-live="polite"></p>' +
      '<div id="acGateForm" hidden><label for="acGateCode">Recovery code</label>' +
      '<input id="acGateCode" autocomplete="off" spellcheck="false" style="display:block;width:100%;margin:6px 0 10px;box-sizing:border-box"></div>' +
      '<div id="acGateActions" style="display:flex;flex-wrap:wrap;gap:8px"></div>' +
      '<textarea id="acGateBackup" readonly hidden aria-label="Backup code" style="width:100%;margin-top:12px;min-height:72px;box-sizing:border-box"></textarea></div>';
    doc.body.appendChild(g);
    var text = g.querySelector('#acGateText'), actions = g.querySelector('#acGateActions');
    var form = g.querySelector('#acGateForm'), code = g.querySelector('#acGateCode'), backupBox = g.querySelector('#acGateBackup');
    return {
      el: g, code: code,
      show: function (message, buttons, opts) {
        opts = opts || {};
        text.textContent = message;
        form.hidden = !opts.code;
        backupBox.hidden = !opts.backup; backupBox.value = opts.backup || '';
        actions.textContent = '';
        (buttons || []).forEach(function (b) {
          var el = doc.createElement(b.href ? 'a' : 'button');
          el.className = 'btn' + (b.primary ? ' btn-primary' : '');
          el.textContent = b.label;
          if (b.href) el.href = b.href; else { el.type = 'button'; el.addEventListener('click', function () { el.disabled = true; b.run(); }); }
          actions.appendChild(el);
        });
        var first = actions.firstChild;
        if (first && first.focus) try { first.focus({ preventScroll: true }); } catch (e) {}
      },
      close: function () { g.remove(); }
    };
  }

  /* Signed in and the player settled: write the identity, make the board account-only, and start the game. */
  function startGame(win, core, ui, name) {
    core.writeIdentity(name);
    var board;
    try {
      Object.defineProperty(win, 'SnakeLeaderboard', { configurable: true, get: function () { return board; },
        set: function (v) { board = patchBoard(v, core); } });
    } catch (e) { /* defined already: patched below */ }
    ui.close();
    runGame(win);
    // signed out (or another account) in another tab while playing: start over at the sign-in screen
    var acct = core.account, who = acct.username();
    acct.onChange(function () { if (acct.username() !== who) win.location.reload(); });
    if (win.SnakeLeaderboard) patchBoard(win.SnakeLeaderboard, core);
    mountPanel(win, core, name);
  }

  function gate(win, Account) {
    var doc = win.document;
    var ui = gateUi(doc);
    var core = create({ account: Account, storage: win.localStorage });
    var signIn = [{ label: 'Sign in', href: NEXT, primary: true }, { label: 'Create an account', href: NEXT }];
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
          startGame(win, core, ui, name);
        });
      });
    }
    function conflict(name) {
      ui.show('This device and your Atherbyte account have different Grid Snake progress. Choose which one to keep. ' +
        'The other is kept as a backup.', [
        { label: 'Use my account\'s progress', primary: true, run: function () { core.useAccountSave().then(function () { startGame(win, core, ui, name); }); } },
        { label: 'Keep this device\'s progress', run: function () { core.useDeviceSave().then(function (r) { if (r.ok) startGame(win, core, ui, name); else ui.show(r.message, retry()); }); } }
      ]);
    }
    /* No player for the account yet, and no code on this device: never guess. */
    function choose(message) {
      var hasProgress = !core.localIsEmpty();
      if (hasProgress) core.backup('before-choice');
      ui.show((message ? message + ' ' : '') + (hasProgress
        ? 'This device has Grid Snake progress that is not linked to an account yet. It is safe (backup code below). ' +
          'If you played before, enter your recovery code (Profile > Show recovery code on the device you played on). ' +
          'Or start as ' + Account.username() + ' and keep this device\'s progress.'
        : 'Welcome, ' + Account.username() + '. Played Grid Snake before? Enter your recovery code to bring back your player. ' +
          'New here? Start playing as ' + Account.username() + '.'), [
        { label: 'Link my recovery code', primary: true, run: function () {
          core.linkWithCode(ui.code.value).then(function (r) { if (r.ok) core.fetchPlayer().then(finish); else choose(r.message); });
        } },
        { label: hasProgress ? 'Start as ' + Account.username() + ' with this progress' : 'Start as ' + Account.username(), run: function () {
          core.useAccountName(true).then(function (r) {
            if (!r.ok) return choose(r.message);
            return core.fetchPlayer().then(function (ok) {
              if (!ok) return ui.show(core.state.message, retry());
              return (hasProgress ? core.useDeviceSave() : Promise.resolve()).then(finish);
            });
          });
        } }
      ], { code: true, backup: hasProgress ? lastBackup() : '' });
    }

    function step() {
      ui.show('Checking your Atherbyte account…', []);
      core.verifySession().then(function (s) {
        if (s === 'signed-out') return ui.show('Sign in to your Atherbyte account to play Grid Snake. Your player, coins, shop items ' +
          'and achievements are kept with your account.', signIn);
        if (s !== 'ok') return ui.show('Could not reach your Atherbyte account. Check your connection and try again.', retry());
        return core.fetchPlayer().then(function (ok) {
          if (!ok) return ui.show(core.state.message, retry());
          var lp = core.localPlayer();
          if (!lp || core.localPlayerChecked()) return core.state.linked ? finish() : choose('');
          // this device has an old player: its code links it (or confirms it is already this account's player)
          return core.linkWithCode(lp.secret).then(function (r) {
            if (r.ok) return core.fetchPlayer().then(finish);
            if (r.code === 'unknown_player') return core.state.linked ? finish() : choose('');
            if (r.code === 'account_has_player' || r.code === 'player_linked_elsewhere') {
              var other = lp.name || 'This device\'s player';
              return ui.show(other + (r.code === 'account_has_player'
                ? ' is not the Grid Snake player of your account.'
                : ' belongs to another Atherbyte account. Sign in with that account to play as ' + other + '.') +
                ' Its progress and recovery code stay on this device as a backup.', (r.code === 'player_linked_elsewhere' ? signIn.slice(0, 1) : []).concat(
                core.state.linked ? [{ label: 'Play as ' + core.state.name, primary: true, run: function () { core.backup('other-player'); finish(); } }]
                                  : [{ label: 'Start as ' + Account.username(), primary: true, run: function () { choose(''); } }]),
                { backup: lastBackup() });
            }
            return ui.show(r.message, retry());
          });
        });
      });
    }
    step();
  }

  /* Profile > Atherbyte account: who is signed in, and the latest backup code. */
  function mountPanel(win, core, name) {
    var doc = win.document, dlg = doc.getElementById('profileDlg');
    if (!dlg) return;
    var box = doc.createElement('details');
    box.className = 'pf-backup';
    box.open = true;
    box.innerHTML = '<summary>Atherbyte account</summary><p class="pf-status" id="acStatus"></p><div class="pf-row" id="acActions"></div>' +
      '<textarea class="pf-code" id="acBackup" readonly hidden aria-label="Backup code"></textarea>';
    var anchor = doc.getElementById('pfBackupSummary');
    (anchor && anchor.parentNode ? anchor.parentNode.parentNode : dlg).insertBefore(box, anchor && anchor.parentNode ? anchor.parentNode : null);
    box.querySelector('#acStatus').textContent = 'Signed in as ' + name + '. Your progress is kept with your Atherbyte account.';
    var b = doc.createElement('button');
    b.className = 'btn'; b.type = 'button'; b.textContent = 'Show my last backup code';
    b.addEventListener('click', function () { var l = core.backups()[0], t = box.querySelector('#acBackup'); t.hidden = !l; t.value = l ? l.code : ''; });
    box.querySelector('#acActions').appendChild(b);
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
      gateUi(doc).show('Could not load the Atherbyte sign-in. Check your connection and reload the page.',
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

  return { create: create, patchBoard: patchBoard, boot: boot, BACKUP_KEY: BACKUP_KEY, SYNC_KEY: SYNC_KEY, LOCAL_ONLY_KEY: LOCAL_ONLY_KEY };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeAccountLink;
else if (typeof window !== 'undefined') { try { SnakeAccountLink.boot(window); } catch (e) { /* see boot: on failure the game stays stopped on the studio site */ } }
