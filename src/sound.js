/* Grid Snake sound
 * Short synthesized effects (Web Audio), no audio files. No game logic: the page calls play(name).
 * Audio can only start after a tap or key press, so the context is created lazily by unlock().
 * A missing or failing audio system never breaks the game: every call is wrapped and does nothing.
 */
var SnakeSound = (function () {
  'use strict';

  /* Each effect is a list of notes: f = Hz, to = Hz at the end (optional slide), at = start offset (s),
     d = length (s), w = wave, v = loudness 0..1. */
  var EFFECTS = {
    start:      [{ f: 440, at: 0, d: 0.09, w: 'sine', v: 0.7 }, { f: 660, at: 0.08, d: 0.12, w: 'sine', v: 0.7 }],
    food:       [{ f: 620, to: 880, at: 0, d: 0.09, w: 'sine', v: 0.8 }],
    boost:      [{ f: 300, to: 900, at: 0, d: 0.22, w: 'sawtooth', v: 0.35 }],
    slow:       [{ f: 700, to: 250, at: 0, d: 0.28, w: 'triangle', v: 0.8 }],
    bonus:      [{ f: 660, at: 0, d: 0.08, w: 'square', v: 0.3 }, { f: 880, at: 0.07, d: 0.08, w: 'square', v: 0.3 }, { f: 1320, at: 0.14, d: 0.12, w: 'square', v: 0.3 }],
    shield:     [{ f: 520, at: 0, d: 0.12, w: 'sine', v: 0.8 }, { f: 780, at: 0.1, d: 0.2, w: 'sine', v: 0.8 }],
    shieldUsed: [{ f: 260, to: 90, at: 0, d: 0.22, w: 'square', v: 0.35 }, { f: 880, to: 1320, at: 0.02, d: 0.12, w: 'sine', v: 0.5 }],
    goldSpawn:  [{ f: 1320, at: 0, d: 0.07, w: 'sine', v: 0.5 }, { f: 1760, at: 0.07, d: 0.1, w: 'sine', v: 0.5 }],
    gold:       [{ f: 784, at: 0, d: 0.08, w: 'triangle', v: 0.8 }, { f: 988, at: 0.07, d: 0.08, w: 'triangle', v: 0.8 },
                 { f: 1175, at: 0.14, d: 0.08, w: 'triangle', v: 0.8 }, { f: 1568, at: 0.21, d: 0.2, w: 'triangle', v: 0.8 }],
    goldExpire: [{ f: 660, to: 440, at: 0, d: 0.16, w: 'sine', v: 0.35 }],
    level:      [{ f: 523, at: 0, d: 0.09, w: 'triangle', v: 0.8 }, { f: 659, at: 0.09, d: 0.09, w: 'triangle', v: 0.8 }, { f: 784, at: 0.18, d: 0.16, w: 'triangle', v: 0.8 }],
    achievement:[{ f: 880, at: 0, d: 0.1, w: 'sine', v: 0.7 }, { f: 1108, at: 0.1, d: 0.1, w: 'sine', v: 0.7 }, { f: 1318, at: 0.2, d: 0.22, w: 'sine', v: 0.7 }],
    timeUp:     [{ f: 523, at: 0, d: 0.14, w: 'triangle', v: 0.8 }, { f: 392, at: 0.14, d: 0.24, w: 'triangle', v: 0.8 }],
    dash:       [{ f: 220, to: 900, at: 0, d: 0.18, w: 'sawtooth', v: 0.3 }],
    slip:       [{ f: 900, to: 200, at: 0, d: 0.35, w: 'sine', v: 0.8 }, { f: 160, at: 0.35, d: 0.1, w: 'square', v: 0.4 }],
    fooled:     [{ f: 300, at: 0, d: 0.1, w: 'square', v: 0.4 }, { f: 220, at: 0.12, d: 0.1, w: 'square', v: 0.4 }, { f: 330, to: 440, at: 0.26, d: 0.18, w: 'triangle', v: 0.6 }],
    bonk:       [{ f: 150, to: 70, at: 0, d: 0.1, w: 'square', v: 0.5 }],
    crunch:     [{ f: 500, to: 80, at: 0, d: 0.16, w: 'sawtooth', v: 0.7 }, { f: 90, at: 0.14, d: 0.2, w: 'square', v: 0.5 }, { f: 220, to: 120, at: 0.3, d: 0.25, w: 'triangle', v: 0.7 }],
    dropItem:   [{ f: 500, to: 380, at: 0, d: 0.09, w: 'triangle', v: 0.7 }],
    over:       [{ f: 330, at: 0, d: 0.16, w: 'triangle', v: 0.9 }, { f: 262, at: 0.16, d: 0.16, w: 'triangle', v: 0.9 }, { f: 196, at: 0.32, d: 0.34, w: 'triangle', v: 0.9 }]
  };

  var MASTER = 0.16;          // overall loudness: effects stay well below a normal media volume
  var MIN_GAP = 0.04;         // seconds: the same effect is not stacked faster than this

  function create(opts) {
    opts = opts || {};
    var Ctor = opts.AudioContext !== undefined ? opts.AudioContext
      : (typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null);
    var enabled = opts.enabled !== false;
    var ctx = null, master = null, lastAt = {}, failed = false, volume = typeof opts.volume === 'number' ? Math.max(0, Math.min(1, opts.volume)) : 1;

    function ensure() {
      if (ctx || failed || !Ctor) return !!ctx;
      try {
        ctx = new Ctor();
        master = ctx.createGain();
        master.gain.value = MASTER * volume;
        master.connect(ctx.destination);
      } catch (e) { ctx = null; failed = true; }
      return !!ctx;
    }

    /* Call from a tap or key press: browsers only allow audio after one. */
    function unlock() {
      if (!enabled || !ensure()) return;
      try { if (ctx.state === 'suspended' && ctx.resume) { var p = ctx.resume(); if (p && p.catch) p.catch(function () {}); } } catch (e) {}
    }

    /* Returns how many notes were scheduled (0 when muted, locked, unknown or too soon after the last one). */
    function play(name) {
      var notes = EFFECTS[name];
      if (!enabled || !notes || !ctx || ctx.state === 'suspended') return 0;
      var now = ctx.currentTime;
      if (lastAt[name] !== undefined && now - lastAt[name] < MIN_GAP) return 0;
      lastAt[name] = now;
      var n = 0;
      try {
        notes.forEach(function (note) {
          var o = ctx.createOscillator(), g = ctx.createGain(), t0 = now + note.at, t1 = t0 + note.d;
          o.type = note.w;
          o.frequency.setValueAtTime(note.f, t0);
          if (note.to) o.frequency.linearRampToValueAtTime(note.to, t1);
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.linearRampToValueAtTime(note.v, t0 + 0.01);          // short fade in and out: no clicks
          g.gain.exponentialRampToValueAtTime(0.0001, t1);
          o.connect(g); g.connect(master);
          o.start(t0); o.stop(t1 + 0.02);
          n++;
        });
      } catch (e) { return n; }
      return n;
    }

    function setVolume(v) { volume = Math.max(0, Math.min(1, +v || 0)); if (master) master.gain.value = MASTER * volume; }
    function setEnabled(on) { enabled = !!on; if (enabled) unlock(); }

    return {
      play: play, unlock: unlock, setEnabled: setEnabled, setVolume: setVolume, getVolume: function () { return volume; },
      isEnabled: function () { return enabled; },
      isReady: function () { return !!ctx && ctx.state !== 'suspended'; },
      names: function () { return Object.keys(EFFECTS); }
    };
  }

  return { create: create, EFFECTS: EFFECTS, MASTER: MASTER };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = SnakeSound;
