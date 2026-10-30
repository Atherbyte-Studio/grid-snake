  /* ===================== Grid Snake Duel: the page side =====================
   * Included inside the page script (index.template.html), so it reuses the page's sound, looks, settings and storage
   * helpers. It owns its view (#duel) and canvas, and does nothing unless that view is open. Every name here starts
   * with duel/Duel/DD so it can never replace one of the page's own (tests/duel.test.js checks).
   *
   * The rules live in src/duel/*.js. Everything below only SHOWS the round: snakes slide between the cells the engine
   * already decided, effects start from the engine's events, and nothing here can change a move or a result. */
  var Duel = SnakeDuel, DuelMatch = SnakeDuelMatch, DuelAI = SnakeDuelAI, DuelEvents = SnakeDuelEvents, DuelMaps = SnakeDuelMaps;
  var duelStats = SnakeDuelStats.create(storage());
  var DUEL_LEVEL_KEY = 'gridsnake-duel-level-v1';
  var DUEL_LEVELS = { easy: { name: 'Easy' }, medium: { name: 'Medium' }, hard: { name: 'Hard' } };
  var DUEL_REASON = {
    wall: 'hit a wall', tail: 'ran into its own body', body: 'ran into the other snake', headon: 'met head-on',
    void: 'fell into the void', laser: 'was caught by a laser', portal: 'took a blocked portal'
  };
  /* Each event's look and the one-line "what to do". */
  var DUEL_EV = {
    vanish: { color: '#FF5C7A', ico: 'M4 4h6v6H4zM14 14h6v6h-6zM14 4h6v6M4 14v6h6', tip: 'The edges fall away ring by ring. Pulsing cells are next: get off them and hold the middle.' },
    portal: { color: '#4FD6E3', ico: 'M12 4a8 8 0 1 0 8 8M12 8a4 4 0 1 0 4 4M20 4l-4 4', tip: 'Enter one portal, come out of the other. A red cross means its exit is blocked: do not go in.' },
    laser:  { color: '#FF4678', ico: 'M3 12h4M17 12h4M9 12h6M12 3v4M12 17v4', tip: 'Red bands charge up, then fire. Leave them in time, or wait in a clear lane.' },
    walls:  { color: '#FFB547', ico: 'M4 6h16M4 12h10M4 18h16M17 9l3 3-3 3', tip: 'Walls slide along the dashed tracks. The glowing cells are where they go next.' },
    core:   { color: '#FFD76E', ico: 'M12 3l7 9-7 9-7-9zM12 8l3 4-3 4-3-4z', tip: 'The Core in the centre is worth 3 points. Get there first: it comes back after a while.' }
  };
  var DUEL_IDLE_TIP = 'Eat food to score. Keep clear of the walls and of both bodies.';
  var duelLevel = (function () { try { var v = window.localStorage.getItem(DUEL_LEVEL_KEY); return DUEL_LEVELS[v] ? v : 'medium'; } catch (e) { return 'medium'; } })();
  var DD = {
    screen: 'menu', match: null, round: null, human: null, ai: null, prev: null, flow: null, flowT: 0, paused: false,
    cores: 0, foods: 0, size: 0, cell: 0, t: 0, rival: { snake: '#9B7BFF', head: '#CBB9FF' },
    fx: { parts: [], rings: [], texts: [], flash: 0, flashCol: '#885CFF', shake: 0 },
    an: null, layer: null, layerKey: '', shown: [0, 0], lastCount: 0
  };
  var dCanvas = $('duelBoard'), dctx = dCanvas.getContext('2d');
  var DUEL_MAX_PARTS = 220;

  function duelSaveLevel(l) { duelLevel = l; try { window.localStorage.setItem(DUEL_LEVEL_KEY, l); } catch (e) {} }
  function duelIcon(id) { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + DUEL_EV[id].ico + '"/></svg>'; }
  function duelAlpha(hex, a) { var c = hexRgb(hex); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function duelEase(k) { return 1 - Math.pow(1 - Math.max(0, Math.min(1, k)), 3); }
  function duelBack3(k) { k = Math.max(0, Math.min(1, k)); var s = 1.7; return Math.max(0, 1 + (s + 1) * Math.pow(k - 1, 3) + s * Math.pow(k - 1, 2)); }   // never below 0 (a canvas radius)

  /* The rival's colours: violet, unless the player's own snake is violet-ish, then amber. */
  function duelColours() {
    var c = hexRgb(PAL.snake), violet = c[2] > 150 && c[0] > 90 && c[1] < 140;
    DD.rival = violet ? { snake: '#E8A33D', head: '#FFD08A' } : { snake: '#9B7BFF', head: '#CBB9FF' };
    $('duel').style.setProperty('--dz-you', PAL.snake);
    $('duel').style.setProperty('--dz-rival', DD.rival.snake);
  }

  /* ---------- screens ---------- */
  function duelShow(screen) {
    DD.screen = screen;
    $('duelMenu').hidden = screen !== 'menu';
    $('duelPlay').hidden = screen === 'menu';
    if (screen === 'menu') renderDuelMenu(); else duelResize();
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
  function duelToMenu() {
    if (DD.flow !== 'results' && DD.match && DD.match.state.phase !== 'over') DD.match.abandon();
    DD.round = null; DD.flow = null; DD.paused = false;
    duelOverlay(null);
    duelShow('menu');
  }

  function renderDuelMenu() {
    document.querySelectorAll('#duelLevels .dz-level').forEach(function (b) {
      b.setAttribute('aria-checked', b.getAttribute('data-level') === duelLevel ? 'true' : 'false');
      b.tabIndex = b.getAttribute('data-level') === duelLevel ? 0 : -1;
    });
    var s = duelStats.get(), rate = s.played ? Math.round(s.won / s.played * 100) : 0;
    setText($('duelW'), s.won); setText($('duelL'), s.lost); setText($('duelD'), s.drawn);
    setText($('duelWinRate'), s.played ? rate + '%' : '–');
    $('duelWinRing').style.setProperty('--p', rate);
    $('duelStatEmpty').hidden = s.played > 0;
    var rows = [['Matches', s.played], ['Best streak', s.bestStreak], ['Rounds won', s.roundsWon], ['Cores taken', s.cores],
      ['Wins on Easy', s.winsBy.easy], ['Wins on Medium', s.winsBy.medium], ['Wins on Hard', s.winsBy.hard], ['Current streak', s.streak]];
    var dl = $('duelStatList');
    dl.textContent = '';
    rows.forEach(function (r) {
      var d = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = r[0]; dd.textContent = r[1];
      d.appendChild(dt); d.appendChild(dd); dl.appendChild(d);
    });
  }
  function buildDuelEventList() {
    var ul = $('duelEventList');
    DuelEvents.IDS.forEach(function (id) {
      var li = document.createElement('li'), b = document.createElement('b');
      b.style.color = DUEL_EV[id].color;
      b.innerHTML = duelIcon(id);
      var n = document.createElement('span'); n.textContent = DuelEvents.INFO[id].name; n.style.color = 'var(--dz-text)';
      b.appendChild(n);
      li.appendChild(b);
      li.appendChild(document.createTextNode(DuelEvents.INFO[id].tag));
      ul.appendChild(li);
    });
  }

  /* ---------- a match ---------- */
  function startMatch() {
    duelColours();
    DD.match = DuelMatch.create({ difficulty: duelLevel });
    DD.cores = 0; DD.foods = 0;
    setText($('duelRivalName'), DUEL_LEVELS[duelLevel].name + ' AI');
    duelShow('play');
    beginRound();
  }
  function duelResetAnim() {
    DD.an = { born: {}, head: [0, 0], death: [null, null], gone: {}, falling: [], portalKey: '', portalAt: -1e9, coreAt: -1e9,
              bars: [], wallsLive: false, entry: [null, null] };
    DD.fx.parts = []; DD.fx.rings = []; DD.fx.texts = []; DD.fx.flash = 0; DD.fx.shake = 0;
    DD.shown = [0, 0]; DD.prev = null;
  }
  function beginRound() {
    var M = DD.match, up = M.upcoming();
    DD.human = Duel.humanController();
    DD.ai = DuelAI.create(duelLevel, (M.state.seed ^ (up.number * 2654435761)) >>> 0, { budgetMs: 8 });
    DD.round = M.nextRound([DD.human, DD.ai]);
    DD.round.on(onDuelEvent);
    DD.paused = false;
    duelResetAnim();
    DD.layerKey = '';
    var map = DuelMaps.build(up.map), ev = DuelEvents.INFO[up.event];
    duelOverlay('countdown', { kicker: 'Round ' + up.number + (up.number > 3 ? ' · decider' : '') + ' · ' + map.name, title: 'Get ready', text: 'This round: ' + ev.name + '. ' + map.desc, count: 3 });
    DD.flow = 'countdown'; DD.flowT = 3000; DD.lastCount = 0;
    $('duelEvent').setAttribute('data-event', up.event);
    $('duelEvent').classList.remove('live');
    $('duelEventIco').innerHTML = duelIcon(up.event);
    setText($('duelHowtoText'), DUEL_IDLE_TIP);
    syncDuelHud();
  }
  function onDuelEvent(e) {
    var you = e.who === 0, col = you ? PAL.snake : DD.rival.snake;
    if (e.type === 'food') {
      duelBurst(e.x, e.y, col, 12, 1);
      duelBurst(e.x, e.y, PAL.food, 6, 0.7);
      duelRing(e.x, e.y, PAL.food, 1.4, 380, 2);
      duelFloat(e.x, e.y, '+' + e.points, col, false);
      DD.an.head[e.who] = 1;
      if (you) { DD.foods++; sfx.play('food'); buzz(8); }
    } else if (e.type === 'core') {
      duelRing(e.x, e.y, '#B79CFF', 5, 700, 4);
      duelRing(e.x, e.y, '#FFD76E', 3, 520, 3);
      duelBurst(e.x, e.y, '#9B7BFF', 22, 1.6);
      duelBurst(e.x, e.y, '#FFD76E', 12, 1.2);
      duelFloat(e.x, e.y, '+' + e.points, '#FFD76E', true);
      DD.fx.flash = 1; DD.fx.flashCol = '#885CFF';
      DD.an.head[e.who] = 1.6;
      if (you) DD.cores++;
      sfx.play('gold'); buzz(24);
    } else if (e.type === 'coreSpawn') {
      DD.an.coreAt = DD.t;
      duelRing(e.x, e.y, '#FFD76E', 2.6, 500, 2);
      duelBurst(e.x, e.y, '#B79CFF', 10, 0.8);
      sfx.play('goldSpawn');
    } else if (e.type === 'announce') {
      duelBanner(e.event);
      announceDuel(e.name + '. ' + DUEL_EV[e.event].tip);
      sfx.play('achievement');
    } else if (e.type === 'eventStart') {
      $('duelEvent').classList.add('live');
      setText($('duelHowtoText'), DUEL_EV[e.event].tip);
    } else if (e.type === 'portal') {
      var en = DD.an.entry[e.who];
      if (en) duelRing(en.x, en.y, '#4FD6E3', 1.6, 300, 3, true);
      duelRing(e.x, e.y, col, 2.2, 420, 3);
      duelBurst(e.x, e.y, '#4FD6E3', 10, 1.1);
      if (you) sfx.play('shield');
    } else if (e.type === 'portalShift') {
      sfx.play('slow');
    } else if (e.type === 'overtime') {
      duelBannerText('Overtime', 'Sudden death: the first point wins the round.', '#FFD76E', 'core');
      announceDuel('Overtime. The first point wins the round.');
      sfx.play('timeUp');
    } else if (e.type === 'crash') {
      duelRing(e.x, e.y, '#FFFFFF', 2.2, 360, 3);
      duelBurst(e.x, e.y, col, 26, 1.8);
      DD.an.death[e.who] = DD.t;
      DD.fx.shake = motionOk() ? 1 : 0;
      if (you) { DD.fx.flash = 0.8; DD.fx.flashCol = '#FF5C7A'; buzz(60); }
      sfx.play('crunch');
    } else if (e.type === 'over') {
      roundOver(e);
    }
    syncDuelHud();
  }
  function roundOver(res) {
    var M = DD.match, phase = M.record(res), crashes = res.crashes || [];
    var title, text, tone = res.draw ? 'draw' : res.winner === 0 ? 'win' : 'loss';
    title = res.draw ? 'Draw' : res.winner === 0 ? 'Round won' : 'Round lost';
    if (res.draw) text = 'Nobody takes the round' + (phase === 'over' ? '.' : '. A fresh round decides it.');
    else if (res.reason === 'time') text = 'On points at the bell, ' + res.scores[0] + ' to ' + res.scores[1] + '.';
    else if (res.reason === 'overtime') text = 'First point in sudden death.';
    else if (res.reason === 'headon') text = 'Head-on! The higher score takes it, ' + res.scores[0] + ' to ' + res.scores[1] + '.';
    else if (res.reason === 'double') text = 'Both crashed. The higher score takes it, ' + res.scores[0] + ' to ' + res.scores[1] + '.';
    else text = crashes[0] ? 'Your snake ' + (DUEL_REASON[crashes[0]] || 'crashed') + '.' : 'The rival ' + (DUEL_REASON[crashes[1]] || 'crashed') + '.';
    sfx.play(res.draw ? 'timeUp' : res.winner === 0 ? 'level' : 'over');
    $('duelEvent').classList.remove('live');
    DD.flow = phase === 'over' ? 'toResults' : 'toNext';
    DD.flowT = 2700;
    var wins = M.state.wins.slice(), n = M.state.rounds.length;
    setTimeout(function () {                                     // let the crash play out first
      if (DD.flow === 'toResults' || DD.flow === 'toNext') duelOverlay('round', { kicker: 'Round ' + n + ' · rounds ' + wins[0] + ' – ' + wins[1], title: title, text: text, tone: tone });
    }, motionOk() ? 650 : 0);
  }
  function showResults() {
    var R = DD.match.results();
    duelStats.recordMatch(R, { cores: DD.cores });
    var won = R.winner === 0, drawn = R.winner === -1;
    var by = R.settledBy === 'points' ? 'Settled on total points · ' : '';
    duelOverlay('results', {
      kicker: by + DUEL_LEVELS[R.difficulty].name + ' rival', title: won ? 'Victory' : drawn ? 'Match drawn' : 'Defeat',
      text: won ? 'You outplayed your rival.' : drawn ? 'Nothing between you this time.' : 'Your rival had the better plan. Try again?',
      tone: won ? 'win' : drawn ? 'draw' : 'loss', final: R.wins,
      rounds: R.rounds.map(function (r) {
        return { n: r.number, tone: r.draw ? 'draw' : r.winner === 0 ? 'win' : 'loss', mark: r.draw ? '=' : r.winner === 0 ? 'W' : 'L',
                 score: r.scores[0] + ' – ' + r.scores[1], sub: DuelEvents.INFO[r.event].name + ' · ' + DuelMaps.build(r.map).name };
      }),
      stats: [['Points', R.totals[0] + ' – ' + R.totals[1]], ['Food eaten', DD.foods], ['Cores', DD.cores]]
    });
    DD.flow = 'results';
    if (won && motionOk()) duelConfetti();
    sfx.play(won ? 'achievement' : 'over');
    if (won) setTimeout(function () { if (DD.flow === 'results') sfx.play('gold'); }, 380);
  }

  function duelPause() {
    if (!DD.round || DD.flow || DD.round.state.phase !== 'running') return;
    DD.round.pause(); DD.paused = true;
    duelOverlay('paused', { kicker: 'Paused', title: 'Take a breath', text: 'The round waits for you. Leaving ends the match without counting it.' });
  }
  function duelResume() {
    if (!DD.round || !DD.paused) return;
    DD.paused = false;
    duelOverlay(null);
    DD.round.resume();
  }
  function duelBack() {                                       // Esc and the Android Back button
    if (DD.screen === 'menu') { leaveDuel(); return true; }
    if (DD.flow === 'results') { duelToMenu(); return true; }
    if (DD.paused) { duelResume(); return true; }
    if (DD.round && DD.round.state.phase === 'running' && !DD.flow) { duelPause(); return true; }
    return true;
  }
  function duelSteer(dx, dy) {
    if (!DD.human || !DD.round || DD.flow === 'results') return;
    if (DD.paused) duelResume();
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
    if (!kind) return;
    ov.className = 'dz-ov dz-ov--' + kind + (o.tone ? ' tone-' + o.tone : '');
    setText($('duelOvKicker'), o.kicker || '');
    setText($('duelOvTitle'), o.title || '');
    setText($('duelOvText'), o.text || '');
    $('duelOvCount').hidden = kind !== 'countdown';
    if (kind === 'countdown') setText($('duelOvCount'), o.count);
    $('duelOvFinal').hidden = !o.final;
    if (o.final) { setText($('duelOvYou'), o.final[0]); setText($('duelOvRival'), o.final[1]); }
    var ol = $('duelOvRounds');
    ol.hidden = !o.rounds; ol.textContent = '';
    (o.rounds || []).forEach(function (r, i) {
      var li = document.createElement('li'); li.className = 'tone-' + r.tone; li.style.setProperty('--i', i);
      var m = document.createElement('i'); m.textContent = r.mark;
      var tx = document.createElement('span'); tx.textContent = 'Round ' + r.n;
      var s = document.createElement('small'); s.textContent = r.sub; tx.appendChild(s);
      var b = document.createElement('b'); b.textContent = r.score;
      li.appendChild(m); li.appendChild(tx); li.appendChild(b); ol.appendChild(li);
    });
    var dl = $('duelOvStats');
    dl.hidden = !o.stats; dl.textContent = '';
    (o.stats || []).forEach(function (s) {
      var d = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = s[0]; dd.textContent = s[1]; d.appendChild(dt); d.appendChild(dd); dl.appendChild(d);
    });
    var actions = kind === 'results' || kind === 'paused';
    $('duelOvActions').hidden = !actions;
    setText($('duelOvMain'), kind === 'results' ? 'Rematch' : 'Resume');
    setText($('duelOvSec'), kind === 'results' ? 'Duel menu' : 'Leave match');
    $('duelOvRestart').hidden = kind !== 'paused';
    if (actions) { try { $('duelOvMain').focus({ preventScroll: true }); } catch (e) {} }
  }
  function duelBannerText(name, tip, color, icoId) {
    var b = $('duelBanner');
    b.style.setProperty('--ev', color);
    $('duelBannerIco').innerHTML = duelIcon(icoId);
    setText($('duelBannerName'), name); setText($('duelBannerTip'), tip);
    b.hidden = false;
    b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
    clearTimeout(DD.bannerTimer);
    DD.bannerTimer = setTimeout(function () { b.hidden = true; b.classList.remove('show'); }, 2700);
  }
  function duelBanner(id) { duelBannerText(DuelEvents.INFO[id].name, DUEL_EV[id].tip, DUEL_EV[id].color, id); }
  function announceDuel(t) { var n = $('duelLive'); n.textContent = ''; setTimeout(function () { n.textContent = t; }, 30); }

  function duelEventCharge(R) {                               // 0..1: how close the nearest danger is (the strip's bar)
    var v = R.eventView(), S = R.state, T = DuelEvents.TUNING;
    if (!v) return S.eventPhase === 'none' ? 0 : Math.min(1, S.elapsed / R.tuning.eventMs);
    var best = 0;
    if (v.kind === 'vanish') Object.keys(v.warned).forEach(function (k) { var p = k.split(','), w = R.warn(+p[0], +p[1]); if (w) best = Math.max(best, 1 - w / T.vanish.warn); });
    else if (v.kind === 'laser') v.cells.forEach(function (c) { best = Math.max(best, c.fire ? 1 : 1 - c.warn / T.laser.warn); });
    else if (v.kind === 'core') best = v.live ? 1 : v.spot ? 1 - v.warn / T.core.warn : 0;
    else if (v.kind === 'walls') best = v.live ? 1 : 0.5;
    else if (v.kind === 'portal') best = v.cur ? 1 : 0.3;
    return best;
  }
  function syncDuelHud() {
    var M = DD.match, R = DD.round;
    if (!M || !R) return;
    var S = R.state, num = M.state.rounds.length + (M.state.phase === 'round' ? 1 : 0);
    [['duelScoreYou', 0], ['duelScoreRival', 1]].forEach(function (p) {
      var v = S.snakes[p[1]].score, el2 = $(p[0]);
      if (v !== DD.shown[p[1]]) {
        if (v > DD.shown[p[1]]) { el2.classList.remove('bump'); void el2.offsetWidth; el2.classList.add('bump'); }
        DD.shown[p[1]] = v;
      }
      setText(el2, v);
    });
    setText($('duelRound'), 'Round ' + Math.max(1, num) + (num > 3 ? ' · decider' : ' of 3'));
    ['You', 'Rival'].forEach(function (who, i) {
      var pips = $('duelPips' + who).children;
      for (var k = 0; k < pips.length; k++) pips[k].classList.toggle('on', M.state.wins[i] > k);
    });
    var ms = R.timeLeft(), secs = Math.ceil(ms / 1000), clock = $('duelClock');
    setText(clock, (S.overtime ? 'OT ' : '') + Math.floor(secs / 60) + ':' + ('0' + secs % 60).slice(-2));
    clock.classList.toggle('urgent', !S.overtime && ms <= 10000);
    clock.classList.toggle('ot', S.overtime);
    var full = S.overtime ? R.tuning.overtimeMs : R.tuning.roundMs;
    $('duelTimeBar').style.transform = 'scaleX(' + Math.max(0, ms / full).toFixed(3) + ')';
    if (S.eventId) {
      setText($('duelEventName'), DuelEvents.INFO[S.eventId].name);
      var inS = Math.max(0, Math.ceil((R.tuning.eventMs - S.elapsed) / 1000));
      setText($('duelEventStatus'), S.eventPhase === 'live' ? R.eventStatus() : S.eventPhase === 'announce' ? 'Get ready…' : 'Arrives in ' + inS + ' s');
      $('duelEventBar').style.transform = 'scaleX(' + duelEventCharge(R).toFixed(3) + ')';
    }
  }

  /* ---------- effects (drawing only) ---------- */
  function duelBurst(x, y, color, n, speed) {
    if (!motionOk()) return;
    var P = DD.fx.parts;
    for (var i = 0; i < n && P.length < DUEL_MAX_PARTS; i++) {
      var a = Math.random() * Math.PI * 2, v = (0.6 + Math.random()) * speed * 0.006;
      P.push({ x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 420 + Math.random() * 380, t: 0, r: 0.07 + Math.random() * 0.09, c: color });
    }
  }
  function duelRing(x, y, color, maxR, life, w, implode) {
    DD.fx.rings.push({ x: x + 0.5, y: y + 0.5, c: color, r: maxR, life: motionOk() ? life : 1, t: 0, w: w || 2, implode: !!implode });
  }
  function duelFloat(x, y, text, color, big) { DD.fx.texts.push({ x: x, y: y, text: text, color: color, big: !!big, t: 0 }); }
  function duelConfetti() {
    var P = DD.fx.parts, cols = ['#885CFF', '#B79CFF', '#FFD76E', '#D66BFF', '#FFFFFF'], N = DuelMaps.SIZE;
    for (var i = 0; i < 70 && P.length < DUEL_MAX_PARTS; i++) {
      P.push({ x: Math.random() * N, y: -1 - Math.random() * 6, vx: (Math.random() - 0.5) * 0.004, vy: 0.006 + Math.random() * 0.006, life: 2600 + Math.random() * 1400, t: 0, r: 0.12 + Math.random() * 0.1, c: cols[i % cols.length], confetti: true, spin: Math.random() * 6 });
    }
  }
  function duelFxStep(dt) {
    var F = DD.fx;
    F.parts = F.parts.filter(function (p) {
      p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (!p.confetti) { p.vx *= 0.94; p.vy *= 0.94; } else p.spin += dt * 0.006;
      return p.t < p.life;
    });
    F.rings = F.rings.filter(function (r) { r.t += dt; return r.t < r.life; });
    F.texts = F.texts.filter(function (t) { t.t += dt; return t.t < 1100; });
    F.flash = Math.max(0, F.flash - dt / 380);
    F.shake = Math.max(0, F.shake - dt / 260);
    DD.an.head[0] = Math.max(0, DD.an.head[0] - dt / 260);
    DD.an.head[1] = Math.max(0, DD.an.head[1] - dt / 260);
  }

  /* ---------- the frame ---------- */
  function duelFrame(dt) {
    if (DD.screen === 'menu' || !DD.round) return;
    DD.t += dt;
    if (DD.flow) {
      DD.flowT -= dt;
      if (DD.flow === 'countdown') {
        var n = Math.max(1, Math.ceil(DD.flowT / 1000)), cnt = $('duelOvCount');
        if (n !== DD.lastCount) { DD.lastCount = n; setText(cnt, n); cnt.classList.remove('tick'); void cnt.offsetWidth; cnt.classList.add('tick'); sfx.play(n === 1 ? 'goldSpawn' : 'food'); }
        if (DD.flowT <= 0) { DD.flow = null; duelOverlay(null); DD.round.start(); sfx.play('start'); }
      } else if (DD.flowT <= 0 && DD.flow === 'toNext') { DD.flow = null; beginRound(); }
      else if (DD.flowT <= 0 && DD.flow === 'toResults') { showResults(); }
    }
    if (!DD.round) return;
    var R = DD.round, S = R.state, before = S.tick;
    if (S.phase === 'running') {
      var pre = S.snakes.map(function (s) { return s.body.map(function (c) { return { x: c.x, y: c.y }; }); });
      DD.an.entry = S.snakes.map(function (s) { return { x: s.body[0].x + s.dir.x, y: s.body[0].y + s.dir.y }; });
      R.update(dt);
      if (S.tick !== before) DD.prev = pre;
      syncDuelHud();
    }
    duelFxStep(dt);
    drawDuel();
  }

  function duelResize() {
    var wrapEl = $('duelBoardWrap');
    if (!wrapEl || !wrapEl.offsetParent) return;
    var w = wrapEl.clientWidth, top = wrapEl.getBoundingClientRect().top;
    var below = isTouch() ? (controlsKind() === 'swipe' ? 20 : 128) : 20;
    var h = window.innerHeight - Math.max(0, top) - below;
    var side = Math.max(240, Math.min(w, h > 240 ? h : w, 780));
    var N = DuelMaps.SIZE, c = Math.floor(side / N);
    side = c * N;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    dCanvas.style.width = side + 'px'; dCanvas.style.height = side + 'px';
    dCanvas.width = side * dpr; dCanvas.height = side * dpr;
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    DD.size = side; DD.cell = c; DD.dpr = dpr; DD.layerKey = '';
  }

  /* The floor and the arena walls never change during a round: drawn once into a layer, then copied each frame. */
  function duelLayer(S) {
    var key = S.map.id + ':' + DD.size + ':' + DD.dpr;
    if (DD.layerKey === key && DD.layer) return DD.layer;
    var cv = DD.layer || document.createElement('canvas'), N = S.size, c = DD.cell, W = DD.size;
    cv.width = W * DD.dpr; cv.height = W * DD.dpr;
    var g = cv.getContext('2d');
    g.setTransform(DD.dpr, 0, 0, DD.dpr, 0, 0);
    var bg = g.createRadialGradient(W / 2, W / 2, W * 0.1, W / 2, W / 2, W * 0.75);
    bg.addColorStop(0, '#15141F'); bg.addColorStop(1, '#0C0C12');
    g.fillStyle = bg; g.fillRect(0, 0, W, W);
    g.fillStyle = 'rgba(255,255,255,0.022)';
    for (var gy = 0; gy < N; gy++) for (var gx = (gy % 2); gx < N; gx += 2) g.fillRect(gx * c, gy * c, c, c);
    g.fillStyle = 'rgba(183,156,255,0.05)';
    for (var dy = 1; dy < N; dy++) for (var dx = 1; dx < N; dx++) g.fillRect(dx * c - 0.5, dy * c - 0.5, 1, 1);
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      if (!S.map.walls[y * N + x]) continue;
      var up = y > 0 && S.map.walls[(y - 1) * N + x], dn = y < N - 1 && S.map.walls[(y + 1) * N + x];
      var lf = x > 0 && S.map.walls[y * N + x - 1], rt = x < N - 1 && S.map.walls[y * N + x + 1];
      var grd = g.createLinearGradient(0, y * c, 0, (y + 1) * c);
      grd.addColorStop(0, '#2E2947'); grd.addColorStop(1, '#221F35');
      g.fillStyle = grd; g.fillRect(x * c, y * c, c, c);
      g.fillStyle = 'rgba(183,156,255,0.22)';
      if (!up) g.fillRect(x * c, y * c, c, Math.max(1, c * 0.12));
      g.fillStyle = 'rgba(0,0,0,0.35)';
      if (!dn) g.fillRect(x * c, (y + 1) * c - Math.max(1, c * 0.1), c, Math.max(1, c * 0.1));
      g.fillStyle = 'rgba(183,156,255,0.08)';
      if (!lf) g.fillRect(x * c, y * c, 1, c);
      if (!rt) g.fillRect((x + 1) * c - 1, y * c, 1, c);
    }
    g.strokeStyle = 'rgba(136,92,255,0.35)'; g.lineWidth = 1; g.strokeRect(0.5, 0.5, W - 1, W - 1);
    DD.layer = cv; DD.layerKey = key;
    return cv;
  }

  function duelRoundRect(x, y, w, h, r) {
    dctx.beginPath();
    dctx.moveTo(x + r, y); dctx.arcTo(x + w, y, x + w, y + h, r); dctx.arcTo(x + w, y + h, x, y + h, r);
    dctx.arcTo(x, y + h, x, y, r); dctx.arcTo(x, y, x + w, y, r); dctx.closePath();
  }

  function drawDuel() {
    var R = DD.round;
    if (!R || !DD.cell) return;
    var S = R.state, c = DD.cell, W = DD.size, t = DD.t, moving = motionOk();
    dctx.save();
    if (DD.fx.shake > 0) dctx.translate((Math.random() - 0.5) * 4 * DD.fx.shake, (Math.random() - 0.5) * 4 * DD.fx.shake);
    dctx.drawImage(duelLayer(S), 0, 0, W, W);
    var ev = R.eventView();
    if (ev && ev.kind === 'vanish') drawDuelVanish(ev, R, c, t, moving);
    if (ev && ev.kind === 'laser') drawDuelLaser(ev, R, c, t, moving);
    if (ev && ev.kind === 'walls') drawDuelWalls(ev, c, t, moving);
    if (ev && ev.kind === 'portal') drawDuelPortals(ev, c, t, moving);
    if (ev && ev.kind === 'core') drawDuelCore(ev, c, t, moving);
    drawDuelFood(S, c, t, moving);
    var a = S.phase === 'running' && moving ? Math.min(1, S.acc / R.tuning.stepMs) : 1;
    drawDuelSnake(S.snakes[1], DD.prev && DD.prev[1], a, c, DD.rival.snake, DD.rival.head, 1, t);
    drawDuelSnake(S.snakes[0], DD.prev && DD.prev[0], a, c, PAL.snake, PAL.head, 0, t);
    drawDuelFx(c, moving);
    dctx.restore();
    if (DD.fx.flash > 0) {
      var g = dctx.createRadialGradient(W / 2, W / 2, W * 0.25, W / 2, W / 2, W * 0.75);
      g.addColorStop(0, duelAlpha(DD.fx.flashCol, 0)); g.addColorStop(1, duelAlpha(DD.fx.flashCol, 0.35 * DD.fx.flash));
      dctx.fillStyle = g; dctx.fillRect(0, 0, W, W);
    }
  }

  /* Vanishing Grid: warned cells pulse faster as their time runs out and crack near the end; a cell that drops
     shrinks into the dark; dropped cells are holes. */
  function drawDuelVanish(v, R, c, t, moving) {
    var T = DuelEvents.TUNING.vanish, an = DD.an;
    Object.keys(v.gone).forEach(function (k) {
      var q = k.split(','), x = +q[0] * c, y = +q[1] * c;
      if (!an.gone[k]) { an.gone[k] = 1; an.falling.push({ x: +q[0], y: +q[1], t: t }); }
      dctx.fillStyle = '#040406'; dctx.fillRect(x, y, c, c);
      dctx.fillStyle = 'rgba(255,92,122,0.10)'; dctx.fillRect(x, y, c, 1);
    });
    an.falling = an.falling.filter(function (f) {
      var k = (t - f.t) / 520;
      if (k >= 1 || !moving) return false;
      var s = (1 - duelEase(k)) * c;
      dctx.save(); dctx.translate((f.x + 0.5) * c, (f.y + 0.5) * c); dctx.rotate(k * 0.9);
      dctx.fillStyle = 'rgba(64,58,90,' + (1 - k) + ')'; dctx.fillRect(-s / 2, -s / 2, s, s);
      dctx.restore();
      return true;
    });
    Object.keys(v.warned).forEach(function (k) {
      var p = k.split(','), x = +p[0], y = +p[1], w = R.warn(x, y), prog = 1 - Math.min(1, w / T.warn);
      var pulse = moving ? 0.5 + 0.5 * Math.sin(t * (0.004 + prog * 0.012)) : 0.7;
      dctx.fillStyle = 'rgba(255,92,122,' + (0.08 + prog * 0.22 + pulse * 0.08 * prog) + ')';
      dctx.fillRect(x * c + 1, y * c + 1, c - 2, c - 2);
      dctx.strokeStyle = 'rgba(255,92,122,' + (0.25 + 0.5 * pulse * prog) + ')'; dctx.lineWidth = 1;
      dctx.strokeRect(x * c + 1.5, y * c + 1.5, c - 3, c - 3);
      if (prog > 0.65) {
        dctx.strokeStyle = 'rgba(255,200,210,' + (prog - 0.6) + ')';
        dctx.beginPath(); dctx.moveTo(x * c + c * 0.2, y * c + c * 0.3); dctx.lineTo(x * c + c * 0.55, y * c + c * 0.5); dctx.lineTo(x * c + c * 0.8, y * c + c * 0.75); dctx.stroke();
      }
    });
  }

  /* Laser Sweep: emitters glow on the edge for every charging band, stripes fill as the charge builds, a fired band
     is a hot beam; the safe lanes are framed. */
  function drawDuelLaser(v, R, c, t, moving) {
    var N = R.size, T = DuelEvents.TUNING.laser, rows = {};
    if (v.active) {
      dctx.save(); dctx.setLineDash([3, 5]); dctx.strokeStyle = 'rgba(255,255,255,0.2)'; dctx.lineWidth = 1;
      v.lanes.forEach(function (L) {
        var a = L[0] * c, b = (L[1] + 1) * c;
        if (v.axis === 'row') dctx.strokeRect(a + 0.5, 0.5, b - a - 1, N * c - 1); else dctx.strokeRect(0.5, a + 0.5, N * c - 1, b - a - 1);
      });
      dctx.restore();
    }
    v.cells.forEach(function (p) {
      var x = p.x * c, y = p.y * c;
      if (p.fire) {
        var flick = moving ? 0.85 + 0.15 * Math.sin(t * 0.06 + p.x + p.y) : 1;
        dctx.fillStyle = 'rgba(255,40,100,' + (0.55 * flick) + ')'; dctx.fillRect(x, y, c, c);
        dctx.fillStyle = 'rgba(255,190,215,' + (0.85 * flick) + ')';
        if (v.axis === 'row') dctx.fillRect(x, y + c * 0.38, c, c * 0.24); else dctx.fillRect(x + c * 0.38, y, c * 0.24, c);
      } else {
        var prog = 1 - Math.min(1, p.warn / T.warn), shimmer = moving ? 0.5 + 0.5 * Math.sin(t * (0.006 + prog * 0.02)) : 0.6;
        dctx.fillStyle = 'rgba(255,70,120,' + (0.05 + prog * 0.2) + ')'; dctx.fillRect(x, y, c, c);
        dctx.strokeStyle = 'rgba(255,70,120,' + (0.12 + prog * 0.35 * shimmer) + ')'; dctx.lineWidth = 1;
        dctx.beginPath();
        var o = moving ? (t * 0.02) % (c * 0.6) : 0;
        for (var s = -c + o; s < c; s += c * 0.6) { dctx.moveTo(x + s, y + c); dctx.lineTo(x + s + c, y); }
        dctx.stroke();
      }
      var key = v.axis === 'row' ? p.y : p.x;
      if (!rows[key] || p.fire) rows[key] = p;
    });
    Object.keys(rows).forEach(function (k) {
      var p = rows[k], i = +k, glow = p.fire ? 1 : 0.3 + 0.5 * (1 - Math.min(1, p.warn / T.warn));
      dctx.fillStyle = 'rgba(255,90,140,' + glow + ')';
      if (v.axis === 'row') { dctx.fillRect(0, i * c + c * 0.25, 3, c * 0.5); dctx.fillRect(N * c - 3, i * c + c * 0.25, 3, c * 0.5); }
      else { dctx.fillRect(i * c + c * 0.25, 0, c * 0.5, 3); dctx.fillRect(i * c + c * 0.25, N * c - 3, c * 0.5, 3); }
    });
  }

  /* Moving Walls: dashed tracks, the next cells glow amber, bars slide smoothly and point the way they move. */
  function drawDuelWalls(v, c, t, moving) {
    var an = DD.an;
    if (v.live && !an.wallsLive) { an.wallsLive = true; v.bars.forEach(function (b) { b.cells.forEach(function (q) { duelBurst(q.x, q.y, '#FFB547', 2, 0.6); }); }); }
    v.bars.forEach(function (b, i) {
      var tr = b.track;
      dctx.save(); dctx.setLineDash([2, 4]); dctx.strokeStyle = 'rgba(255,181,71,0.22)'; dctx.lineWidth = 1;
      if (tr.axis === 'x') dctx.strokeRect(tr.min * c + 0.5, tr.fixed * c + 0.5, (tr.max - tr.min + 1) * c - 1, tr.len * c - 1);
      else dctx.strokeRect(tr.fixed * c + 0.5, tr.min * c + 0.5, tr.len * c - 1, (tr.max - tr.min + 1) * c - 1);
      dctx.restore();
      var head = b.cells[0], st = an.bars[i];
      if (!st || st.x !== head.x || st.y !== head.y) an.bars[i] = st = { x: head.x, y: head.y, fx: st ? st.x : head.x, fy: st ? st.y : head.y, at: t };
      if (!v.live) {
        var k = moving ? 0.5 + 0.5 * Math.sin(t * 0.012) : 0.7;
        b.cells.forEach(function (q) { dctx.strokeStyle = 'rgba(255,181,71,' + (0.3 + 0.5 * k) + ')'; dctx.lineWidth = 1.5; dctx.strokeRect(q.x * c + 2, q.y * c + 2, c - 4, c - 4); });
        return;
      }
      b.next.forEach(function (q) {
        if (!b.cells.some(function (z) { return z.x === q.x && z.y === q.y; })) { dctx.fillStyle = 'rgba(255,181,71,0.18)'; dctx.fillRect(q.x * c, q.y * c, c, c); }
      });
      var e = moving ? duelEase((t - st.at) / 170) : 1, ox = (st.x - st.fx) * (1 - e) * c, oy = (st.y - st.fy) * (1 - e) * c;
      var dirX = b.next[0].x - head.x, dirY = b.next[0].y - head.y;
      b.cells.forEach(function (q) {
        var x = q.x * c - ox, y = q.y * c - oy;
        var g = dctx.createLinearGradient(x, y, x, y + c);
        g.addColorStop(0, '#E1A043'); g.addColorStop(1, '#A86A1E');
        dctx.fillStyle = g; duelRoundRect(x + 1, y + 1, c - 2, c - 2, Math.max(2, c * 0.22)); dctx.fill();
        dctx.fillStyle = 'rgba(255,240,210,0.35)'; dctx.fillRect(x + 2, y + 2, c - 4, Math.max(1, c * 0.14));
        if (dirX || dirY) {                                         // a chevron pointing the way it moves
          var cx = x + c / 2, cy = y + c / 2, s = c * 0.18;
          dctx.strokeStyle = 'rgba(40,24,6,0.7)'; dctx.lineWidth = Math.max(1.2, c * 0.08);
          dctx.beginPath();
          dctx.moveTo(cx - dirX * s - dirY * s, cy - dirY * s - dirX * s); dctx.lineTo(cx + dirX * s, cy + dirY * s); dctx.lineTo(cx - dirX * s + dirY * s, cy - dirY * s + dirX * s);
          dctx.stroke();
        }
      });
    });
  }

  /* Portal Shift: portals open with a flash, swirl while open; the next pair is shown as dashed rings; a blocked
     exit turns its entry red with a cross. */
  function drawDuelPortals(v, c, t, moving) {
    var an = DD.an, cols = ['#7C5CFF', '#36C9E0'];
    var key = v.cur ? v.cur.map(function (p) { return p.x + ',' + p.y; }).join('|') : '';
    if (key && key !== an.portalKey) {
      an.portalKey = key; an.portalAt = t;
      v.cur.forEach(function (p, i) { duelRing(p.x, p.y, cols[i], 2.4, 520, 3); duelBurst(p.x, p.y, cols[i], 8, 0.9); });
    }
    if (v.next) v.next.forEach(function (p, i) {
      dctx.save(); dctx.setLineDash([3, 3]); dctx.strokeStyle = duelAlpha(cols[i], 0.75); dctx.lineWidth = 1.5;
      dctx.beginPath(); dctx.arc((p.x + 0.5) * c, (p.y + 0.5) * c, c * 0.42, 0, Math.PI * 2); dctx.stroke(); dctx.restore();
    });
    if (!v.cur) return;
    var sc = moving ? duelBack3((t - an.portalAt) / 450) : 1;
    v.cur.forEach(function (p, i) {
      var cx = (p.x + 0.5) * c, cy = (p.y + 0.5) * c, blocked = v.open && !v.open[i], col = blocked ? '#FF5C7A' : cols[i];
      var g = dctx.createRadialGradient(cx, cy, 0, cx, cy, c * 0.95 * sc);
      g.addColorStop(0, duelAlpha(col, 0.55)); g.addColorStop(0.5, duelAlpha(col, 0.18)); g.addColorStop(1, duelAlpha(col, 0));
      dctx.fillStyle = g; dctx.beginPath(); dctx.arc(cx, cy, Math.max(0.5, c * 0.95 * sc), 0, Math.PI * 2); dctx.fill();
      var ang = moving ? t / 260 * (i ? -1 : 1) : 0;
      dctx.strokeStyle = col; dctx.lineWidth = Math.max(1.6, c * 0.12);
      for (var k = 0; k < 2; k++) { dctx.beginPath(); dctx.arc(cx, cy, Math.max(0.5, c * (0.42 - k * 0.16) * sc), ang + k * 2, ang + k * 2 + Math.PI * 1.25); dctx.stroke(); }
      if (moving) for (var d = 0; d < 3; d++) {
        var aa = ang * 1.6 + d * 2.094;
        dctx.fillStyle = 'rgba(255,255,255,0.7)'; dctx.beginPath(); dctx.arc(cx + Math.cos(aa) * c * 0.5, cy + Math.sin(aa) * c * 0.5, Math.max(1, c * 0.05), 0, Math.PI * 2); dctx.fill();
      }
      if (blocked) {
        dctx.strokeStyle = '#FF5C7A'; dctx.lineWidth = 2.2;
        dctx.beginPath(); dctx.moveTo(cx - c * 0.24, cy - c * 0.24); dctx.lineTo(cx + c * 0.24, cy + c * 0.24);
        dctx.moveTo(cx + c * 0.24, cy - c * 0.24); dctx.lineTo(cx - c * 0.24, cy + c * 0.24); dctx.stroke();
      }
    });
  }

  /* The Core: a closing reticle counts down to it; it pops in, then spins and pulses with orbiting sparks. */
  function drawDuelCore(v, c, t, moving) {
    if (!v.spot) return;
    var cx = (v.spot.x + 0.5) * c, cy = (v.spot.y + 0.5) * c, T = DuelEvents.TUNING.core;
    if (!v.live) {
      var k = 1 - Math.min(1, v.warn / T.warn), r = c * (2.2 - 1.6 * k);
      dctx.strokeStyle = 'rgba(255,215,110,' + (0.3 + 0.5 * k) + ')'; dctx.lineWidth = 1.5;
      dctx.beginPath(); dctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k); dctx.stroke();
      for (var q = 0; q < 4; q++) {
        var a = q * Math.PI / 2 + (moving ? t / 900 : 0);
        dctx.beginPath(); dctx.moveTo(cx + Math.cos(a) * r * 0.75, cy + Math.sin(a) * r * 0.75); dctx.lineTo(cx + Math.cos(a) * r * 1.1, cy + Math.sin(a) * r * 1.1); dctx.stroke();
      }
      if (moving && k > 0.7 && Math.random() < 0.3) duelBurst(v.spot.x + (Math.random() - 0.5) * 3, v.spot.y + (Math.random() - 0.5) * 3, '#B79CFF', 1, 0.3);
      return;
    }
    var born = moving ? duelBack3((t - DD.an.coreAt) / 420) : 1, pulse = moving ? 0.5 + 0.5 * Math.sin(t / 220) : 0.6;
    var g = dctx.createRadialGradient(cx, cy, 0, cx, cy, c * 1.8);
    g.addColorStop(0, 'rgba(183,156,255,' + (0.4 + 0.2 * pulse) + ')'); g.addColorStop(0.5, 'rgba(136,92,255,0.15)'); g.addColorStop(1, 'rgba(136,92,255,0)');
    dctx.fillStyle = g; dctx.beginPath(); dctx.arc(cx, cy, c * 1.8, 0, Math.PI * 2); dctx.fill();
    dctx.save(); dctx.translate(cx, cy); dctx.rotate(moving ? t / 1400 : 0); dctx.scale(Math.max(0.01, born), Math.max(0.01, born));
    var s = c * (0.46 + 0.05 * pulse);
    dctx.fillStyle = '#FFD76E'; dctx.beginPath(); dctx.moveTo(0, -s); dctx.lineTo(s, 0); dctx.lineTo(0, s); dctx.lineTo(-s, 0); dctx.closePath(); dctx.fill();
    dctx.fillStyle = '#885CFF'; dctx.beginPath(); dctx.moveTo(0, -s * 0.5); dctx.lineTo(s * 0.5, 0); dctx.lineTo(0, s * 0.5); dctx.lineTo(-s * 0.5, 0); dctx.closePath(); dctx.fill();
    dctx.restore();
    if (moving) for (var d = 0; d < 4; d++) {
      var aa = t / 500 + d * Math.PI / 2;
      dctx.fillStyle = 'rgba(214,107,255,0.8)'; dctx.beginPath(); dctx.arc(cx + Math.cos(aa) * c * 0.9, cy + Math.sin(aa) * c * 0.55, Math.max(1, c * 0.06), 0, Math.PI * 2); dctx.fill();
    }
  }

  /* Food pops in, then breathes gently. */
  function drawDuelFood(S, c, t, moving) {
    var born = DD.an.born, keep = {};
    S.foods.forEach(function (f, i) {
      var k = f.x + ',' + f.y;
      keep[k] = 1;
      if (born[k] === undefined) born[k] = t;
      var s = moving ? duelBack3((t - born[k]) / 340) : 1, bob = moving ? 1 + 0.06 * Math.sin(t / 260 + i * 2) : 1;
      var cx = (f.x + 0.5) * c, cy = (f.y + 0.5) * c, r = Math.max(0.5, c * 0.3 * s * bob), gr = Math.max(0.5, c * 0.75 * s);
      var g = dctx.createRadialGradient(cx, cy, 0, cx, cy, gr);
      g.addColorStop(0, duelAlpha(PAL.food, 0.35)); g.addColorStop(1, duelAlpha(PAL.food, 0));
      dctx.fillStyle = g; dctx.beginPath(); dctx.arc(cx, cy, gr, 0, Math.PI * 2); dctx.fill();
      dctx.fillStyle = PAL.food; dctx.beginPath(); dctx.arc(cx, cy, r, 0, Math.PI * 2); dctx.fill();
      dctx.fillStyle = 'rgba(255,255,255,0.55)'; dctx.beginPath(); dctx.arc(cx - r * 0.3, cy - r * 0.35, r * 0.28, 0, Math.PI * 2); dctx.fill();
    });
    Object.keys(born).forEach(function (k) { if (!keep[k]) delete born[k]; });
  }

  /* A snake: each segment slides from its last cell to the new one, so turns round off; the body tapers to the tail
     with an outline and a soft highlight; the head swells when it eats; a portal jump is drawn as a break.
     When it crashes it flashes, then greys out from the head down. */
  function drawDuelSnake(s, prev, a, c, col, headCol, who, t) {
    var pts = s.body.map(function (p, i) {
      var q = prev && prev[i] ? prev[i] : (prev && prev.length ? prev[prev.length - 1] : p);
      if (Math.abs(q.x - p.x) + Math.abs(q.y - p.y) !== 1) q = p;
      return { x: (q.x + (p.x - q.x) * a + 0.5) * c, y: (q.y + (p.y - q.y) * a + 0.5) * c };
    });
    var died = DD.an.death[who], dk = died !== null ? Math.min(1, (t - died) / 700) : 0, n = pts.length;
    function tint(base, i) {
      if (died === null) return base;
      if (dk < 0.25 && Math.floor(dk * 16) % 2 === 0) return mix(base, '#FFFFFF', 0.6);
      var front = dk * (n + 4) - i;
      return front > 0 ? mix(base, '#4A4A5C', Math.min(0.75, front / 3)) : base;
    }
    dctx.lineCap = 'round';
    for (var pass = 0; pass < 3; pass++) {
      for (var i = n - 1; i > 0; i--) {
        var p = pts[i], q = pts[i - 1];
        if (Math.abs(p.x - q.x) + Math.abs(p.y - q.y) > c * 1.05) continue;   // a portal jump
        var w = c * (0.5 + 0.3 * (1 - i / Math.max(1, n - 1)));
        if (pass === 0) { dctx.strokeStyle = 'rgba(0,0,0,0.45)'; dctx.lineWidth = w + 3; }
        else if (pass === 1) { dctx.strokeStyle = tint(col, i); dctx.lineWidth = w; }
        else { dctx.strokeStyle = 'rgba(255,255,255,0.13)'; dctx.lineWidth = w * 0.32; }
        dctx.beginPath(); dctx.moveTo(p.x, p.y); dctx.lineTo(q.x, q.y); dctx.stroke();
      }
    }
    var h = pts[0], d = s.dir, R = c * 0.46 * (1 + 0.2 * DD.an.head[who]);
    if (s.alive) {
      var g = dctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, c * 1.3);
      g.addColorStop(0, duelAlpha(col, 0.28)); g.addColorStop(1, duelAlpha(col, 0));
      dctx.fillStyle = g; dctx.beginPath(); dctx.arc(h.x, h.y, c * 1.3, 0, Math.PI * 2); dctx.fill();
    }
    dctx.fillStyle = tint(headCol, 0);
    dctx.beginPath(); dctx.arc(h.x, h.y, R, 0, Math.PI * 2); dctx.fill();
    var ex = -d.y, ey = d.x;
    [-1, 1].forEach(function (k) {
      var x = h.x + d.x * c * 0.13 + ex * k * c * 0.2, y = h.y + d.y * c * 0.13 + ey * k * c * 0.2;
      dctx.fillStyle = '#FFFFFF'; dctx.beginPath(); dctx.arc(x, y, Math.max(1.6, c * 0.12), 0, Math.PI * 2); dctx.fill();
      dctx.fillStyle = '#0B0B0F';
      if (s.alive) { dctx.beginPath(); dctx.arc(x + d.x * c * 0.04, y + d.y * c * 0.04, Math.max(1, c * 0.07), 0, Math.PI * 2); dctx.fill(); }
      else { dctx.lineWidth = 1.2; dctx.strokeStyle = '#0B0B0F'; var z = c * 0.06; dctx.beginPath(); dctx.moveTo(x - z, y - z); dctx.lineTo(x + z, y + z); dctx.moveTo(x + z, y - z); dctx.lineTo(x - z, y + z); dctx.stroke(); }
    });
  }

  function drawDuelFx(c, moving) {
    var F = DD.fx;
    F.rings.forEach(function (r) {
      var k = r.t / r.life, e = duelEase(k), rad = (r.implode ? (1 - e) * r.r : 0.4 + e * r.r) * c;
      dctx.strokeStyle = duelAlpha(r.c, (1 - k) * 0.9); dctx.lineWidth = r.w * (1 - k * 0.6);
      dctx.beginPath(); dctx.arc(r.x * c, r.y * c, Math.max(0.5, rad), 0, Math.PI * 2); dctx.stroke();
    });
    F.parts.forEach(function (p) {
      var k = p.t / p.life;
      dctx.globalAlpha = p.confetti ? Math.min(1, (1 - k) * 2) : 1 - k;
      dctx.fillStyle = p.c;
      if (p.confetti) { dctx.save(); dctx.translate(p.x * c, p.y * c); dctx.rotate(p.spin); dctx.fillRect(-p.r * c, -p.r * c * 0.4, p.r * c * 2, p.r * c * 0.8); dctx.restore(); }
      else { dctx.beginPath(); dctx.arc(p.x * c, p.y * c, Math.max(0.6, p.r * c * (1 - k * 0.5)), 0, Math.PI * 2); dctx.fill(); }
    });
    dctx.globalAlpha = 1;
    F.texts.forEach(function (tx) {
      var k = tx.t / 1100, pop = moving ? duelBack3(Math.min(1, tx.t / 220)) : 1;
      dctx.globalAlpha = 1 - k * k;
      dctx.font = '700 ' + Math.max(8, Math.round(c * (tx.big ? 1.6 : 1.05) * pop)) + 'px Sora, sans-serif';
      dctx.textAlign = 'center'; dctx.textBaseline = 'middle';
      var x = (tx.x + 0.5) * c, y = (tx.y + 0.5) * c - (moving ? duelEase(k) * c * 1.8 : c * 0.6);
      dctx.lineWidth = 3; dctx.strokeStyle = 'rgba(10,10,14,0.85)'; dctx.strokeText(tx.text, x, y);
      dctx.fillStyle = tx.color; dctx.fillText(tx.text, x, y);
      dctx.globalAlpha = 1;
    });
  }

  /* ---------- wiring ---------- */
  buildDuelEventList();
  $('duelEntry').addEventListener('click', openDuel);
  $('duelBack').addEventListener('click', leaveDuel);
  $('duelStart').addEventListener('click', startMatch);
  document.querySelectorAll('#duelLevels .dz-level').forEach(function (b) {
    b.addEventListener('click', function () { duelSaveLevel(b.getAttribute('data-level')); renderDuelMenu(); sfx.play('food'); });
    b.addEventListener('keydown', function (e) {                // a radio group: the arrows move the choice
      var order = ['easy', 'medium', 'hard'], i = order.indexOf(duelLevel);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') i = Math.min(2, i + 1); else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') i = Math.max(0, i - 1); else return;
      e.preventDefault(); duelSaveLevel(order[i]); renderDuelMenu();
      document.querySelector('#duelLevels [data-level="' + order[i] + '"]').focus();
    });
  });
  $('duelPauseBtn').addEventListener('click', function () { if (DD.paused) duelResume(); else duelPause(); });
  $('duelLeaveBtn').addEventListener('click', duelToMenu);
  $('duelMuteBtn').addEventListener('click', function () { setSound(!soundOn); syncDuelMute(); });
  function syncDuelMute() { setText($('duelMuteBtn'), soundOn ? 'Sound on' : 'Sound off'); $('duelMuteBtn').setAttribute('aria-pressed', soundOn ? 'false' : 'true'); }
  syncDuelMute();
  $('duelOvMain').addEventListener('click', function () { if (DD.flow === 'results') startMatch(); else duelResume(); });
  $('duelOvSec').addEventListener('click', duelToMenu);
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
