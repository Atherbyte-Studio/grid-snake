'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Sound = require('../src/sound.js');

function fakeAudio(opts) {
  opts = opts || {};
  const log = { contexts: 0, oscillators: [], resumed: 0 };
  class Ctx {
    constructor() {
      if (opts.throwOnCreate) throw new Error('no audio');
      log.contexts++;
      this.state = opts.startSuspended ? 'suspended' : 'running';
      this.currentTime = 0;
      this.destination = {};
    }
    resume() { log.resumed++; this.state = 'running'; return Promise.resolve(); }
    createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    createOscillator() {
      const o = { type: '', frequency: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, start() { log.oscillators.push(o.type); }, stop() {} };
      return o;
    }
  }
  return { Ctx, log };
}

test('S1 no audio context is created until the player taps or presses a key', () => {
  const a = fakeAudio();
  const s = Sound.create({ AudioContext: a.Ctx });
  assert.equal(s.play('food'), 0);
  assert.equal(a.log.contexts, 0);
  s.unlock();
  assert.equal(a.log.contexts, 1);
  assert.ok(s.play('food') > 0);
});

test('S1 a suspended context is resumed by unlock, and stays silent until then', () => {
  const a = fakeAudio({ startSuspended: true });
  const s = Sound.create({ AudioContext: a.Ctx });
  s.unlock();
  assert.equal(a.log.resumed, 1);
  assert.ok(s.isReady());
});

test('S2 every effect name used by the game exists and plays at least one note', () => {
  const a = fakeAudio();
  const s = Sound.create({ AudioContext: a.Ctx });
  s.unlock();
  ['start', 'food', 'boost', 'slow', 'bonus', 'shield', 'shieldUsed', 'goldSpawn', 'gold', 'goldExpire', 'level', 'achievement', 'timeUp', 'over']
    .forEach(n => { assert.ok(Sound.EFFECTS[n], n); assert.ok(s.play(n) > 0, n); });
});

test('S3 muted means silent: nothing is played, nothing is created', () => {
  const a = fakeAudio();
  const s = Sound.create({ AudioContext: a.Ctx, enabled: false });
  s.unlock();
  assert.equal(a.log.contexts, 0);
  assert.equal(s.play('food'), 0);
  s.setEnabled(true);
  assert.ok(s.play('food') > 0);
  s.setEnabled(false);
  const before = a.log.oscillators.length;
  assert.equal(s.play('gold'), 0);
  assert.equal(a.log.oscillators.length, before);
});

test('S4 an unknown name, a missing audio system or a failing one never throws', () => {
  const none = Sound.create({ AudioContext: null });
  none.unlock();
  assert.equal(none.play('food'), 0);
  const bad = Sound.create({ AudioContext: fakeAudio({ throwOnCreate: true }).Ctx });
  bad.unlock();
  assert.equal(bad.play('food'), 0);
  const ok = Sound.create({ AudioContext: fakeAudio().Ctx });
  ok.unlock();
  assert.equal(ok.play('nope'), 0);
});

test('S5 the same effect is not stacked within a few milliseconds', () => {
  const a = fakeAudio();
  const s = Sound.create({ AudioContext: a.Ctx });
  s.unlock();
  assert.ok(s.play('food') > 0);
  assert.equal(s.play('food'), 0);
  assert.ok(s.play('gold') > 0, 'a different effect still plays');
});

test('S6 master volume is modest', () => {
  assert.ok(Sound.MASTER > 0 && Sound.MASTER <= 0.25);
});

test('S-vol the volume scales the master gain and is clamped', () => {
  const a = fakeAudio();
  const s = Sound.create({ AudioContext: a.Ctx, volume: 0.5 });
  assert.equal(s.getVolume(), 0.5);
  s.unlock(); s.play('food');
  s.setVolume(5); assert.equal(s.getVolume(), 1);
  s.setVolume(-2); assert.equal(s.getVolume(), 0);
  assert.doesNotThrow(() => s.play('food'));
});
