  /* ===================== Grid Snake Duel: the page side =====================
   * Included inside the page script (index.template.html), so it can reuse the page's sound, look, settings and
   * storage helpers. It owns its own view (#duel) and canvas, and does nothing unless that view is open.
   * The rules live in src/duel/*.js; this file only shows them and passes key presses to the human controller. */
  var Duel = SnakeDuel, DuelMatch = SnakeDuelMatch, DuelAI = SnakeDuelAI, DuelEvents = SnakeDuelEvents, DuelMaps = SnakeDuelMaps;
  var duelStats = SnakeDuelStats.create(storage());
  var DUEL_LEVEL_KEY = 'gridsnake-duel-level-v1';
  var DUEL_LEVELS = {
    easy:   { name: 'Easy',   desc: 'Goes for the nearest food and plays it safe. A good first rival.' },
    medium: { name: 'Medium', desc: 'Plans ahead, reads the hazards and will block your path.' },
    hard:   { name: 'Hard',   desc: 'Looks ahead at both snakes, fights for space and cuts you off.' }
  };
  var DUEL_REASON = {
    wall: 'hit a wall', tail: 'ran into its own body', body: 'ran into the other snake', headon: 'met head-on',
    void: 'fell into the void', laser: 'was caught by a laser', portal: 'took a blocked portal'
  };
  var duelLevel = (function () { try { var v = window.localStorage.getItem(DUEL_LEVEL_KEY); return DUEL_LEVELS[v] ? v : 'medium'; } catch (e) { return 'medium'; } })();
  var DD = {
    screen: 'menu', match: null, round: null, human: null, ai: null,
    prev: null, flow: null, flowT: 0, banner: null, texts: [], burst: [], paused: false,
    cores: 0, size: 0, cell: 0, rival: { snake: '#9B7BFF', head: '#CBB9FF' }
  };
  var dCanvas = $('duelBoard'), dctx = dCanvas.getContext('2d');

  function duelSaveLevel(l) { duelLevel = l; try { window.localStorage.setItem(DUEL_LEVEL_KEY, l); } catch (e) {} }

  /* The rival's colours: violet, unless the player's own snake is violet-ish, then amber. */
  function duelColours() {
    var c = hexRgb(PAL.snake), violet = c[2] > 150 && c[0] > 90 && c[1] < 140;
    DD.rival = violet ? { snake: '#E8A33D', head: '#FFD08A' } : { snake: '#9B7BFF', head: '#CBB9FF' };
    $('duel').style.setProperty('--d-you', PAL.snake);
    $('duel').style.setProperty('--d-rival', DD.rival.snake);
  }

  /* ---------- screens ---------- */
  function duelShow(screen) {
    DD.screen = screen;
    $('duelMenu').hidden = screen !== 'menu';
    $('duelPlay').hidden = screen === 'menu';
    if (screen === 'menu') renderDuelMenu();
    else duelResize();
  }
  function openDuel() {
    if (!appReady) return;
    setView('duel');
    duelColours();
    duelShow('menu');
    try { $('duelStart').focus({ preventScroll: true }); } catch (e) {}
  }
  function leaveDuel() {
    if (DD.match && DD.match.state.phase !== 'over') DD.match.abandon();
    DD.match = DD.round = null; DD.flow = null;
    setView('home');
    try { $('duelEntry').focus({ preventScroll: true }); } catch (e) {}
  }

  function renderDuelMenu() {
    document.querySelectorAll('#duelLevels button').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-level') === duelLevel ? 'true' : 'false');
    });
    setText($('duelLevelDesc'), DUEL_LEVELS[duelLevel].desc);
    var s = duelStats.get();
    var rows = [
      ['Matches', s.played], ['Won', s.won], ['Lost', s.lost], ['Drawn', s.drawn],
      ['Rounds won', s.roundsWon], ['Rounds lost', s.roundsLost], ['Best streak', s.bestStreak], ['Current streak', s.streak],
      ['Wins on Easy', s.winsBy.easy], ['Wins on Medium', s.winsBy.medium], ['Wins on Hard', s.winsBy.hard], ['Cores taken', s.cores]
    ];
    var dl = $('duelStatList');
    dl.textContent = '';
    rows.forEach(function (r) {
      var d = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = r[0]; dd.textContent = r[1];
      d.appendChild(dt); d.appendChild(dd); dl.appendChild(d);
    });
    $('duelStatEmpty').hidden = s.played > 0;
  }

  /* ---------- a match ---------- */
  function startMatch() {
    duelColours();
    DD.match = DuelMatch.create({ difficulty: duelLevel });
    DD.cores = 0;
    duelShow('play');
    beginRound();
  }
  function beginRound() {
    var M = DD.match, up = M.upcoming();
    DD.human = Duel.humanController();
    DD.ai = DuelAI.create(duelLevel, (M.state.seed ^ (up.number * 2654435761)) >>> 0, { budgetMs: 8 });
    DD.round = M.nextRound([DD.human, DD.ai]);
    DD.round.on(onDuelEvent);
    DD.prev = null; DD.texts = []; DD.burst = []; DD.banner = null; DD.paused = false;
    var map = DuelMaps.build(up.map);
    duelOverlay('countdown', { title: 'Round ' + up.number, text: map.name + ' · ' + map.desc, count: 3 });
    DD.flow = 'countdown'; DD.flowT = 3000;
    syncDuelHud();
    sfx.play('level');
  }
  function onDuelEvent(e) {
    var S = DD.round.state;
    if (e.type === 'food') {
      duelFloat(e.x, e.y, '+' + e.points, e.who === 0 ? PAL.snake : DD.rival.snake);
      if (e.who === 0) { sfx.play('food'); buzz(8); }
    } else if (e.type === 'core') {
      duelFloat(e.x, e.y, '+' + e.points, '#FFD76E', true);
      if (e.who === 0) DD.cores++;
      sfx.play('gold'); buzz(20);
    } else if (e.type === 'coreSpawn') {
      sfx.play('goldSpawn');
    } else if (e.type === 'announce') {
      DD.banner = { name: e.name, tag: e.tag, t: 0 };
      setText($('duelEventName'), e.name);
      announceDuel(e.name + '. ' + e.tag);
      sfx.play('achievement');
    } else if (e.type === 'portal') {
      if (e.who === 0) sfx.play('shield');
    } else if (e.type === 'overtime') {
      DD.banner = { name: 'Overtime', tag: 'Sudden death: the first point wins the round.', t: 0 };
      announceDuel('Overtime. The first point wins the round.');
      sfx.play('timeUp');
    } else if (e.type === 'crash') {
      DD.burst.push({ x: e.x, y: e.y, t: 0, c: e.who === 0 ? PAL.snake : DD.rival.snake });
      if (e.who === 0) buzz(60);
      sfx.play('crunch');
    } else if (e.type === 'over') {
      roundOver(e);
    }
    if (S) syncDuelHud();
  }
  function roundOver(res) {
    var M = DD.match, phase = M.record(res);
    var title, text, crashes = res.crashes || [];
    if (res.draw) { title = 'Draw'; text = 'Nobody takes the round. ' + (phase === 'over' ? '' : 'A fresh round decides it.'); }
    else if (res.winner === 0) { title = 'Round to you'; }
    else { title = 'Round to the rival'; }
    if (!text) {
      if (res.reason === 'time') text = 'Time: ' + res.scores[0] + ' to ' + res.scores[1] + '.';
      else if (res.reason === 'overtime') text = 'First point in overtime.';
      else if (res.reason === 'headon') text = 'Head-on crash: the higher score takes it, ' + res.scores[0] + ' to ' + res.scores[1] + '.';
      else if (res.reason === 'double') text = 'Both crashed: the higher score takes it, ' + res.scores[0] + ' to ' + res.scores[1] + '.';
      else text = (crashes[0] ? 'Your snake ' + (DUEL_REASON[crashes[0]] || 'crashed') : 'The rival ' + (DUEL_REASON[crashes[1]] || 'crashed')) + '.';
    }
    sfx.play(res.draw ? 'timeUp' : res.winner === 0 ? 'level' : 'over');
    duelOverlay('round', { title: title, text: text, tone: res.draw ? 'draw' : res.winner === 0 ? 'win' : 'loss' });
    DD.flow = phase === 'over' ? 'toResults' : 'toNext';
    DD.flowT = 2600;
  }
  function showResults() {
    var R = DD.match.results();
    duelStats.recordMatch(R, { cores: DD.cores });
    var won = R.winner === 0, drawn = R.winner === -1;
    var title = won ? 'Victory' : drawn ? 'Match drawn' : 'Defeat';
    var by = R.settledBy === 'points' ? ' (decided on total points)' : '';
    var list = R.rounds.map(function (r) {
      var who = r.draw ? 'Draw' : r.winner === 0 ? 'You' : 'Rival';
      return { n: r.number, who: who, score: r.scores[0] + ' – ' + r.scores[1], ev: DuelEvents.INFO[r.event].name, map: DuelMaps.build(r.map).name, tone: r.draw ? 'draw' : r.winner === 0 ? 'win' : 'loss' };
    });
    duelOverlay('results', { title: title, text: 'Rounds ' + R.wins[0] + ' – ' + R.wins[1] + by + ' · Points ' + R.totals[0] + ' – ' + R.totals[1] + ' · ' + DUEL_LEVELS[R.difficulty].name + ' rival', rounds: list, tone: won ? 'win' : drawn ? 'draw' : 'loss' });
    DD.flow = 'results';
    sfx.play(won ? 'achievement' : 'over');
    if (won) setTimeout(function () { if (DD.flow === 'results') sfx.play('gold'); }, 380);
  }

  function duelPause() {
    if (!DD.round || DD.flow) return;
    if (DD.round.state.phase !== 'running') return;
    DD.round.pause(); DD.paused = true;
    duelOverlay('paused', { title: 'Paused', text: 'The round waits for you. Leaving ends the match without counting it.' });
  }
  function duelResume() {
    if (!DD.round || !DD.paused) return;
    DD.paused = false;
    duelOverlay(null);
    DD.round.resume();
  }
  function duelBack() {                                       // Esc and the Android Back button
    if (DD.screen === 'menu') { leaveDuel(); return true; }
    if (DD.flow === 'results') { duelShow('menu'); duelOverlay(null); return true; }
    if (DD.paused) { duelResume(); return true; }
    if (DD.round && DD.round.state.phase === 'running' && !DD.flow) { duelPause(); return true; }
    return true;
  }
  function duelSteer(dx, dy) {
    if (!DD.human || !DD.round || DD.flow === 'results') return;
    if (DD.paused) { duelResume(); }
    DD.human.turn(dx, dy);
  }
  function duelTurnSide(side) {
    if (!DD.human || !DD.round) return;
    var h = DD.human.heading();
    if (side < 0) duelSteer(h.y, 0 - h.x); else duelSteer(0 - h.y, h.x);
  }

  /* ---------- overlay, banner and HUD ---------- */
  function duelOverlay(kind, o) {
    var ov = $('duelOv');
    ov.hidden = !kind;
    ov.className = 'duel-ov' + (kind ? ' duel-ov--' + kind : '') + (o && o.tone ? ' tone-' + o.tone : '');
    if (!kind) return;
    setText($('duelOvTitle'), o.title || '');
    setText($('duelOvText'), o.text || '');
    $('duelOvCount').hidden = kind !== 'countdown';
    if (kind === 'countdown') setText($('duelOvCount'), o.count);
    var ul = $('duelOvRounds');
    ul.hidden = kind !== 'results';
    ul.textContent = '';
    (o.rounds || []).forEach(function (r) {
      var li = document.createElement('li');
      li.className = 'tone-' + r.tone;
      var a = document.createElement('b'); a.textContent = 'Round ' + r.n;
      var b = document.createElement('span'); b.textContent = r.who + ' · ' + r.score;
      var c = document.createElement('small'); c.textContent = r.ev + ' · ' + r.map;
      li.appendChild(a); li.appendChild(b); li.appendChild(c); ul.appendChild(li);
    });
    $('duelOvActions').hidden = kind !== 'results' && kind !== 'paused';
    setText($('duelOvMain'), kind === 'results' ? 'Rematch' : 'Resume');
    setText($('duelOvSec'), kind === 'results' ? 'Duel menu' : 'Leave match');
    $('duelOvRestart').hidden = kind !== 'paused';
    if (kind === 'results' || kind === 'paused') { try { $('duelOvMain').focus({ preventScroll: true }); } catch (e) {} }
  }
  function announceDuel(t) { var n = $('duelLive'); n.textContent = ''; setTimeout(function () { n.textContent = t; }, 30); }

  function syncDuelHud() {
    var M = DD.match, R = DD.round;
    if (!M || !R) return;
    var S = R.state, num = M.state.rounds.length + (M.state.phase === 'round' ? 1 : 0);
    setText($('duelScoreYou'), S.snakes[0].score);
    setText($('duelScoreRival'), S.snakes[1].score);
    setText($('duelRound'), 'Round ' + Math.max(1, num) + (num > 3 ? ' · replay' : '') + ' · first to 2');
    ['You', 'Rival'].forEach(function (who, i) {
      var pips = $('duelPips' + who).children;
      for (var k = 0; k < pips.length; k++) pips[k].classList.toggle('on', M.state.wins[i] > k);
    });
    var ms = R.timeLeft(), secs = Math.ceil(ms / 1000);
    setText($('duelClock'), (S.overtime ? 'OT ' : '') + Math.floor(secs / 60) + ':' + ('0' + secs % 60).slice(-2));
    $('duelClock').classList.toggle('urgent', S.overtime || ms <= 10000);
    setText($('duelEventName'), S.eventId ? DuelEvents.INFO[S.eventId].name : '');
    var inS = Math.max(0, Math.ceil((R.tuning.eventMs - S.elapsed) / 1000));
    setText($('duelEventStatus'), S.eventPhase === 'live' ? R.eventStatus() : 'Begins in ' + inS + ' s');
  }

  /* ---------- the frame ---------- */
  function duelFrame(dt) {
    if (DD.screen === 'menu' || !DD.round) return;
    if (DD.flow) {
      DD.flowT -= dt;
      if (DD.flow === 'countdown') {
        setText($('duelOvCount'), Math.max(1, Math.ceil(DD.flowT / 1000)));
        if (DD.flowT <= 0) { DD.flow = null; duelOverlay(null); DD.round.start(); sfx.play('start'); }
      } else if (DD.flowT <= 0 && DD.flow === 'toNext') { DD.flow = null; beginRound(); }
      else if (DD.flowT <= 0 && DD.flow === 'toResults') { showResults(); }
    }
    var S = DD.round.state, before = S.tick, pre = null;
    if (S.phase === 'running') {
      pre = S.snakes.map(function (s) { return s.body.map(function (c) { return { x: c.x, y: c.y }; }); });
      DD.round.update(dt);
      if (S.tick !== before) DD.prev = pre;
      syncDuelHud();
    }
    if (DD.banner) { DD.banner.t += dt; if (DD.banner.t > 2600) DD.banner = null; }
    DD.texts = DD.texts.filter(function (t) { t.t += dt; return t.t < 1100; });
    DD.burst = DD.burst.filter(function (b) { b.t += dt; return b.t < 700; });
    drawDuel();
  }

  function duelFloat(x, y, text, color, big) { DD.texts.push({ x: x, y: y, text: text, color: color, big: !!big, t: 0 }); }

  function duelResize() {
    var wrapEl = $('duelBoardWrap');
    if (!wrapEl || !wrapEl.offsetParent) return;
    var w = wrapEl.clientWidth;
    var top = wrapEl.getBoundingClientRect().top + (window.scrollY || 0);
    var below = isTouch() ? (controlsKind() === 'swipe' ? 24 : 132) : 24;
    var h = window.innerHeight - Math.max(0, top - (window.scrollY || 0)) - below;
    var side = Math.max(240, Math.min(w, h > 240 ? h : w, 760));
    var N = DuelMaps.SIZE, c = Math.floor(side / N);
    side = c * N;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    dCanvas.style.width = side + 'px'; dCanvas.style.height = side + 'px';
    dCanvas.width = side * dpr; dCanvas.height = side * dpr;
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    DD.size = side; DD.cell = c;
  }

  function duelRoundRect(x, y, w, h, r) {
    dctx.beginPath();
    dctx.moveTo(x + r, y); dctx.arcTo(x + w, y, x + w, y + h, r); dctx.arcTo(x + w, y + h, x, y + h, r);
    dctx.arcTo(x, y + h, x, y, r); dctx.arcTo(x, y, x + w, y, r); dctx.closePath();
  }
  function duelAlpha(hex, a) { var c = hexRgb(hex); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }

  function drawDuel() {
    var R = DD.round;
    if (!R || !DD.cell) return;
    var S = R.state, N = S.size, c = DD.cell, W = DD.size, now = performance.now(), moving = motionOk();
    var pulse = moving ? 0.5 + 0.5 * Math.sin(now / 160) : 0.75;
    // ground
    dctx.fillStyle = '#101017'; dctx.fillRect(0, 0, W, W);
    dctx.fillStyle = 'rgba(255,255,255,0.028)';
    for (var gy = 0; gy < N; gy++) for (var gx = (gy % 2); gx < N; gx += 2) dctx.fillRect(gx * c, gy * c, c, c);
    var view = R.eventView();
    // vanishing cells under everything else
    if (view && view.kind === 'vanish') {
      Object.keys(view.gone).forEach(function (k) { var p = k.split(','); dctx.fillStyle = '#050507'; dctx.fillRect(+p[0] * c, +p[1] * c, c, c); });
      Object.keys(view.warned).forEach(function (k) {
        var p = k.split(','), x = +p[0], y = +p[1], w = R.warn(x, y), k2 = Math.min(1, w / 34);
        dctx.fillStyle = 'rgba(255,92,122,' + (0.10 + (1 - k2) * 0.25 * (0.6 + 0.4 * pulse)) + ')';
        dctx.fillRect(x * c + 1, y * c + 1, c - 2, c - 2);
      });
    }
    if (view && view.kind === 'laser') {
      view.cells.forEach(function (p) {
        if (p.fire) {
          dctx.fillStyle = 'rgba(255,70,120,0.85)'; dctx.fillRect(p.x * c, p.y * c, c, c);
          dctx.fillStyle = 'rgba(255,220,235,0.55)'; dctx.fillRect(p.x * c, p.y * c + c * 0.4, c, c * 0.2);
        } else {
          var k3 = 1 - Math.min(1, p.warn / 17);
          dctx.fillStyle = 'rgba(255,70,120,' + (0.08 + 0.28 * k3 * (0.5 + 0.5 * pulse)) + ')';
          dctx.fillRect(p.x * c, p.y * c, c, c);
        }
      });
    }
    // arena walls
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      if (!S.map.walls[y * N + x]) continue;
      dctx.fillStyle = '#2B2740'; dctx.fillRect(x * c, y * c, c, c);
      dctx.fillStyle = 'rgba(183,156,255,0.10)'; dctx.fillRect(x * c, y * c, c, Math.max(1, c * 0.18));
    }
    dctx.strokeStyle = 'rgba(136,92,255,0.35)'; dctx.lineWidth = 1; dctx.strokeRect(0.5, 0.5, W - 1, W - 1);
    if (view && view.kind === 'walls') drawDuelBars(view, c, pulse);
    if (view && view.kind === 'portal') drawDuelPortals(view, c, now, moving);
    if (view && view.kind === 'core') drawDuelCore(view, c, now, pulse);
    // food
    S.foods.forEach(function (f) {
      var cx = (f.x + 0.5) * c, cy = (f.y + 0.5) * c;
      dctx.fillStyle = duelAlpha(PAL.food, 0.18); dctx.beginPath(); dctx.arc(cx, cy, c * 0.48, 0, Math.PI * 2); dctx.fill();
      dctx.fillStyle = PAL.food; dctx.beginPath(); dctx.arc(cx, cy, c * 0.3, 0, Math.PI * 2); dctx.fill();
    });
    // snakes
    var a = S.phase === 'running' ? Math.min(1, S.acc / R.tuning.stepMs) : 1;
    if (!moving) a = 1;
    drawDuelSnake(S.snakes[0], DD.prev && DD.prev[0], a, c, PAL.snake, PAL.head);
    drawDuelSnake(S.snakes[1], DD.prev && DD.prev[1], a, c, DD.rival.snake, DD.rival.head);
    // effects
    DD.burst.forEach(function (b) {
      var k = b.t / 700;
      dctx.strokeStyle = duelAlpha(b.c, 1 - k); dctx.lineWidth = 2;
      dctx.beginPath(); dctx.arc((b.x + 0.5) * c, (b.y + 0.5) * c, c * (0.6 + k * (moving ? 2.4 : 0.6)), 0, Math.PI * 2); dctx.stroke();
    });
    DD.texts.forEach(function (t) {
      var k = t.t / 1100;
      dctx.globalAlpha = 1 - k * k;
      dctx.fillStyle = t.color;
      dctx.font = '700 ' + Math.round(c * (t.big ? 1.5 : 1.05)) + 'px Sora, sans-serif';
      dctx.textAlign = 'center'; dctx.textBaseline = 'middle';
      dctx.fillText(t.text, (t.x + 0.5) * c, (t.y + 0.5) * c - (moving ? k * c * 1.6 : 0));
      dctx.globalAlpha = 1;
    });
    if (DD.banner) drawDuelBanner(DD.banner, W, moving);
  }

  function drawDuelBanner(b, W, moving) {
    var t = b.t, inA = Math.min(1, t / 260), outA = t > 2100 ? Math.max(0, 1 - (t - 2100) / 500) : 1, al = inA * outA;
    var h = Math.max(50, W * 0.13), y = W * 0.03 + (moving ? (1 - inA) * -10 : 0);
    dctx.globalAlpha = al;
    var g = dctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, 'rgba(11,11,15,0)'); g.addColorStop(0.18, 'rgba(11,11,15,0.88)'); g.addColorStop(0.82, 'rgba(11,11,15,0.88)'); g.addColorStop(1, 'rgba(11,11,15,0)');
    dctx.fillStyle = g; dctx.fillRect(0, y, W, h);
    dctx.fillStyle = 'rgba(136,92,255,0.8)'; dctx.fillRect(W * 0.3, y, W * 0.4, 2);
    dctx.textAlign = 'center'; dctx.textBaseline = 'middle';
    dctx.fillStyle = '#F5F5F7'; dctx.font = '700 ' + Math.round(Math.min(26, W / 17)) + 'px Sora, sans-serif';
    dctx.fillText(b.name.toUpperCase(), W / 2, y + h * 0.4);
    dctx.fillStyle = '#B79CFF'; dctx.font = '500 ' + Math.round(Math.min(14, W / 32)) + 'px "Instrument Sans", sans-serif';
    dctx.fillText(b.tag, W / 2, y + h * 0.74);
    dctx.globalAlpha = 1;
  }

  function drawDuelBars(v, c, pulse) {
    v.bars.forEach(function (b) {
      var tr = b.track;
      dctx.strokeStyle = 'rgba(255,181,71,0.16)'; dctx.setLineDash([3, 4]); dctx.lineWidth = 1;
      if (tr.axis === 'x') dctx.strokeRect(tr.min * c + 0.5, tr.fixed * c + 0.5, (tr.max - tr.min + 1) * c - 1, tr.len * c - 1);
      else dctx.strokeRect(tr.fixed * c + 0.5, tr.min * c + 0.5, tr.len * c - 1, (tr.max - tr.min + 1) * c - 1);
      dctx.setLineDash([]);
      if (!v.live) {
        b.cells.forEach(function (p) { dctx.strokeStyle = 'rgba(255,181,71,' + (0.35 + 0.4 * pulse) + ')'; dctx.strokeRect(p.x * c + 1.5, p.y * c + 1.5, c - 3, c - 3); });
        return;
      }
      b.next.forEach(function (p) { dctx.fillStyle = 'rgba(255,181,71,0.16)'; dctx.fillRect(p.x * c, p.y * c, c, c); });
      b.cells.forEach(function (p) {
        dctx.fillStyle = '#C98A2E'; duelRoundRect(p.x * c + 1, p.y * c + 1, c - 2, c - 2, Math.max(2, c * 0.2)); dctx.fill();
        dctx.fillStyle = 'rgba(255,233,190,0.35)'; dctx.fillRect(p.x * c + 2, p.y * c + 2, c - 4, Math.max(1, c * 0.16));
      });
    });
  }
  function drawDuelPortals(v, c, now, moving) {
    var cols = ['#7C5CFF', '#36C9E0'];
    function ring(p, col, dashed, ang) {
      var cx = (p.x + 0.5) * c, cy = (p.y + 0.5) * c;
      dctx.strokeStyle = col; dctx.lineWidth = Math.max(2, c * 0.16);
      if (dashed) dctx.setLineDash([3, 3]);
      dctx.beginPath(); dctx.arc(cx, cy, c * 0.42, ang, ang + Math.PI * 1.6); dctx.stroke();
      dctx.setLineDash([]);
    }
    var ang = moving ? now / 300 : 0;
    if (v.cur) v.cur.forEach(function (p, i) {
      var cx = (p.x + 0.5) * c, cy = (p.y + 0.5) * c;
      dctx.fillStyle = duelAlpha(cols[i], 0.22); dctx.beginPath(); dctx.arc(cx, cy, c * 0.5, 0, Math.PI * 2); dctx.fill();
      ring(p, cols[i], false, ang * (i ? -1 : 1));
      if (v.open && !v.open[i]) {                              // its exit is blocked: entering it is a crash
        dctx.strokeStyle = '#FF5C7A'; dctx.lineWidth = 2;
        dctx.beginPath(); dctx.moveTo(cx - c * 0.25, cy - c * 0.25); dctx.lineTo(cx + c * 0.25, cy + c * 0.25);
        dctx.moveTo(cx + c * 0.25, cy - c * 0.25); dctx.lineTo(cx - c * 0.25, cy + c * 0.25); dctx.stroke();
      }
    });
    if (v.next) v.next.forEach(function (p, i) { ring(p, duelAlpha(cols[i], 0.7), true, 0); });
  }
  function drawDuelCore(v, c, now, pulse) {
    if (!v.spot) return;
    var cx = (v.spot.x + 0.5) * c, cy = (v.spot.y + 0.5) * c;
    if (!v.live) {
      dctx.strokeStyle = 'rgba(255,215,110,' + (0.3 + 0.5 * pulse) + ')'; dctx.lineWidth = 1.5; dctx.setLineDash([2, 3]);
      dctx.beginPath(); dctx.arc(cx, cy, c * (0.5 + 0.9 * Math.min(1, v.warn / 25)), 0, Math.PI * 2); dctx.stroke(); dctx.setLineDash([]);
      return;
    }
    var g = dctx.createRadialGradient(cx, cy, 0, cx, cy, c * 1.4);
    g.addColorStop(0, 'rgba(255,215,110,0.55)'); g.addColorStop(1, 'rgba(136,92,255,0)');
    dctx.fillStyle = g; dctx.beginPath(); dctx.arc(cx, cy, c * 1.4, 0, Math.PI * 2); dctx.fill();
    var r = c * (0.42 + 0.06 * pulse);
    dctx.fillStyle = '#FFD76E';
    dctx.beginPath(); dctx.moveTo(cx, cy - r); dctx.lineTo(cx + r, cy); dctx.lineTo(cx, cy + r); dctx.lineTo(cx - r, cy); dctx.closePath(); dctx.fill();
    dctx.fillStyle = '#885CFF';
    dctx.beginPath(); dctx.moveTo(cx, cy - r * 0.45); dctx.lineTo(cx + r * 0.45, cy); dctx.lineTo(cx, cy + r * 0.45); dctx.lineTo(cx - r * 0.45, cy); dctx.closePath(); dctx.fill();
  }

  /* A snake: segments slide from their last cell to the new one; a portal jump is drawn as a break, not a line. */
  function drawDuelSnake(s, prev, a, c, col, headCol) {
    var pts = s.body.map(function (p, i) {
      var q = prev && prev[i] ? prev[i] : (prev && prev.length ? prev[prev.length - 1] : p);
      if (Math.abs(q.x - p.x) + Math.abs(q.y - p.y) !== 1) q = p;
      return { x: q.x + (p.x - q.x) * a, y: q.y + (p.y - q.y) * a };
    });
    if (!s.alive) { col = mix(col, '#55556A', 0.55); headCol = mix(headCol, '#55556A', 0.55); }
    dctx.lineCap = 'round'; dctx.lineJoin = 'round';
    var w = c * 0.72;
    for (var pass = 0; pass < 2; pass++) {
      dctx.strokeStyle = pass ? col : shade(col, 0.55);
      dctx.lineWidth = pass ? w : w + 3;
      dctx.beginPath();
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i], X = (p.x + 0.5) * c, Y = (p.y + 0.5) * c;
        if (i === 0 || Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y) > 1.01) dctx.moveTo(X, Y); else dctx.lineTo(X, Y);
      }
      if (pts.length === 1) dctx.lineTo((pts[0].x + 0.5) * c + 0.01, (pts[0].y + 0.5) * c);
      dctx.stroke();
    }
    var h = pts[0], hx = (h.x + 0.5) * c, hy = (h.y + 0.5) * c, d = s.dir;
    dctx.fillStyle = headCol;
    dctx.beginPath(); dctx.arc(hx, hy, c * 0.46, 0, Math.PI * 2); dctx.fill();
    var ex = -d.y, ey = d.x;
    [-1, 1].forEach(function (k) {
      var x = hx + d.x * c * 0.14 + ex * k * c * 0.2, y = hy + d.y * c * 0.14 + ey * k * c * 0.2;
      dctx.fillStyle = '#0B0B0F'; dctx.beginPath(); dctx.arc(x, y, Math.max(1.4, c * 0.1), 0, Math.PI * 2); dctx.fill();
    });
  }

  /* ---------- wiring ---------- */
  $('duelEntry').addEventListener('click', openDuel);
  $('duelBack').addEventListener('click', leaveDuel);
  $('duelStart').addEventListener('click', startMatch);
  document.querySelectorAll('#duelLevels button').forEach(function (b) {
    b.addEventListener('click', function () { duelSaveLevel(b.getAttribute('data-level')); renderDuelMenu(); });
  });
  $('duelPauseBtn').addEventListener('click', function () { if (DD.paused) duelResume(); else duelPause(); });
  $('duelLeaveBtn').addEventListener('click', function () { if (DD.match && DD.match.state.phase !== 'over') DD.match.abandon(); DD.round = null; DD.flow = null; duelOverlay(null); duelShow('menu'); });
  $('duelMuteBtn').addEventListener('click', function () { setSound(!soundOn); syncDuelMute(); });
  function syncDuelMute() { setText($('duelMuteBtn'), soundOn ? 'Sound on' : 'Sound off'); $('duelMuteBtn').setAttribute('aria-pressed', soundOn ? 'false' : 'true'); }
  syncDuelMute();
  $('duelOvMain').addEventListener('click', function () { if (DD.flow === 'results') startMatch(); else duelResume(); });
  $('duelOvSec').addEventListener('click', function () {
    if (DD.flow !== 'results' && DD.match && DD.match.state.phase !== 'over') DD.match.abandon();
    DD.round = null; DD.flow = null; duelOverlay(null); duelShow('menu');
  });
  $('duelOvRestart').addEventListener('click', function () { if (DD.match) DD.match.abandon(); duelOverlay(null); startMatch(); });
  document.querySelectorAll('#duelPad button').forEach(function (b) {
    b.addEventListener('pointerdown', function (e) { e.preventDefault(); duelSteer(parseInt(b.getAttribute('data-dx'), 10), parseInt(b.getAttribute('data-dy'), 10)); });
  });
  [['duelTurnLeft', -1], ['duelTurnRight', 1]].forEach(function (p) {
    $(p[0]).addEventListener('pointerdown', function (e) { e.preventDefault(); duelTurnSide(p[1]); });
  });
  function duelKey(e) {
    if (DD.screen === 'menu') { if (e.key === 'Escape') { e.preventDefault(); leaveDuel(); } return; }
    if (KEYS[e.key]) { e.preventDefault(); duelSteer(KEYS[e.key][0], KEYS[e.key][1]); }
    else if (e.key === ' ' || e.code === 'Space' || e.key === 'p' || e.key === 'P') { e.preventDefault(); if (DD.paused) duelResume(); else duelPause(); }
    else if (e.key === 'Escape') { e.preventDefault(); duelBack(); }
  }
  (function () {
    var area = $('duel'), sx = 0, sy = 0, on = false;
    area.addEventListener('touchstart', function (e) {
      if (e.target.closest && e.target.closest('button')) return;
      var t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; on = true;
    }, { passive: true });
    area.addEventListener('touchmove', function (e) {
      if (!on || DD.screen === 'menu') return;
      var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 12) return;
      if (Math.abs(dx) > Math.abs(dy)) duelSteer(dx > 0 ? 1 : -1, 0); else duelSteer(0, dy > 0 ? 1 : -1);
      sx = t.clientX; sy = t.clientY;
    }, { passive: true });
    area.addEventListener('touchend', function () { on = false; }, { passive: true });
  })();
  window.addEventListener('resize', function () { if (view === 'duel' && DD.screen !== 'menu') duelResize(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden && view === 'duel') duelPause(); });
