'use strict';
/* Global board client (version 2): names, recovery codes, the ranked rule, the database calls, and every failure path.
 * No network: fetch is faked. Run: node --test tests/leaderboard.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/leaderboard.js');

const LIVE = Object.assign({}, L.CONFIG, { url: 'https://example.supabase.co', anonKey: 'sb_publishable_test', timeoutMs: 200 });
const LEGACY = Object.assign({}, LIVE, { anonKey: 'eyJhbGciOi.test' });
const ONLINE = { onLine: true };
const OFFLINE = { onLine: false };
const RANKED = { walls: true, golden: true, difficulty: 'hard' };
const SECRET = '0123456789abcdef0123456789abcdef';

function resp(status, body) {
  return { status: status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}
function recorder(answer) {
  const calls = [];
  const f = (url, init) => { calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null }); return Promise.resolve(answer(url)); };
  f.calls = calls;
  return f;
}

test('names: a short, clean name passes; markup, blanks, long names and odd characters do not', () => {
  assert.equal(L.validateName('Waseem').ok, true);
  assert.equal(L.validateName('  Two   Words ').name, 'Two Words');
  assert.equal(L.validateName('واسيم').ok, true, 'Arabic letters are allowed');
  assert.equal(L.validateName("Ma'an").ok, true);
  assert.equal(L.validateName('a_b.c-d').ok, true);
  for (const bad of ['', '   ', '<b>x</b>', 'a&b', 'say "hi"', 'a\\b', 'x'.repeat(17), '\u0007bell', 'ok\tname', '!!!', '#tag', 42, null]) {
    assert.equal(L.validateName(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('recovery codes: 32 hex characters, typed with or without dashes and in any case', () => {
  assert.equal(L.validateSecret(SECRET).ok, true);
  assert.equal(L.validateSecret('0123-4567-89AB-CDEF-0123-4567-89ab-cdef').secret, SECRET);
  assert.equal(L.validateSecret(' 0123 4567 89ab cdef 0123 4567 89ab cdef ').ok, true);
  for (const bad of ['', 'short', SECRET + 'a', 'g'.repeat(32), null, 12]) assert.equal(L.validateSecret(bad).ok, false);
  assert.equal(L.formatSecret(SECRET), '0123-4567-89ab-cdef-0123-4567-89ab-cdef');
  const fresh = L.newSecret(() => 0.5);
  assert.match(fresh, /^[0-9a-f]{32}$/);
  assert.match(L.newSecret(), /^[0-9a-f]{32}$/, 'random codes are the right shape');
});

test('scores: whole numbers from 0 to the cap only', () => {
  assert.equal(L.validateScore(0).ok, true);
  assert.equal(L.validateScore(L.CONFIG.maxScore).ok, true);
  for (const bad of [-1, 1.5, L.CONFIG.maxScore + 1, NaN, Infinity, '12', null]) assert.equal(L.validateScore(bad).ok, false);
});

test('the ranked rule is exactly walls on, golden apple on, hard', () => {
  assert.deepEqual(L.RANKED, RANKED);
  assert.equal(L.isRanked(RANKED), true);
  assert.equal(L.isRanked({ walls: false, golden: true, difficulty: 'hard' }), false, 'wrap is not ranked');
  assert.equal(L.isRanked({ walls: true, golden: false, difficulty: 'hard' }), false, 'no golden apple is not ranked');
  assert.equal(L.isRanked({ walls: true, golden: true, difficulty: 'easy' }), false, 'easy is not ranked');
  assert.equal(L.isRanked({ walls: true, golden: true, difficulty: 'normal' }), false);
  assert.equal(L.isRanked(undefined), false);
});

test('a round that did not use the ranked rules is refused before any request', async () => {
  const f = recorder(() => resp(200, {}));
  for (const settings of [{ walls: false, golden: true, difficulty: 'hard' }, { walls: true, golden: false, difficulty: 'hard' }, { walls: true, golden: true, difficulty: 'easy' }, null]) {
    const r = await L.submitBest({ config: LIVE, fetch: f, nav: ONLINE, secret: SECRET, score: 10, settings });
    assert.equal(r.reason, L.REASON.notRanked);
  }
  assert.equal(f.calls.length, 0);
});

test('with no project set up, nothing is sent and the reason says so', async () => {
  const f = recorder(() => resp(200, []));
  const EMPTY = { url: '', anonKey: '', timeoutMs: 200, maxScore: 1000 };
  assert.equal((await L.submitBest({ config: EMPTY, fetch: f, nav: ONLINE, secret: SECRET, score: 1, settings: RANKED })).reason, L.REASON.notConfigured);
  assert.equal((await L.registerPlayer({ config: EMPTY, fetch: f, nav: ONLINE, name: 'Ali', secret: SECRET })).reason, L.REASON.notConfigured);
  assert.equal((await L.getMe({ config: EMPTY, fetch: f, nav: ONLINE, secret: SECRET })).reason, L.REASON.notConfigured);
  assert.equal((await L.fetchTop({ config: EMPTY, fetch: f, nav: ONLINE })).reason, L.REASON.notConfigured);
  assert.equal(f.calls.length, 0);
  assert.equal(L.configured(L.CONFIG), true, 'the shipped config points at the project');
  assert.equal(L.configured({ url: '', anonKey: '' }), false);
});

test('registering: the name is trimmed, the code is sent once, and the public key is the only key', async () => {
  const f = recorder(() => resp(200, { status: 'ok', name: 'Waseem' }));
  const r = await L.registerPlayer({ config: LIVE, fetch: f, nav: ONLINE, name: '  Waseem  ', secret: SECRET });
  assert.deepEqual(r, { ok: true, name: 'Waseem' });
  const c = f.calls[0];
  assert.equal(c.url, 'https://example.supabase.co/rest/v1/rpc/register_player');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.apikey, 'sb_publishable_test');
  assert.equal(c.init.headers.Authorization, undefined, 'a publishable key is not sent as a Bearer token');
  assert.deepEqual(c.body, { p_name: 'Waseem', p_secret: SECRET });
});

test('registering: taken, invalid, already-registered and the migration-missing answers', async () => {
  const answer = body => recorder(() => resp(200, body));
  assert.equal((await L.registerPlayer({ config: LIVE, fetch: answer({ status: 'taken' }), nav: ONLINE, name: 'Ali', secret: SECRET })).reason, L.REASON.taken);
  assert.equal((await L.registerPlayer({ config: LIVE, fetch: answer({ status: 'invalid' }), nav: ONLINE, name: 'Ali', secret: SECRET })).reason, L.REASON.invalid);
  const again = await L.registerPlayer({ config: LIVE, fetch: answer({ status: 'already-registered', name: 'Ali' }), nav: ONLINE, name: 'Ali', secret: SECRET });
  assert.equal(again.reason, L.REASON.alreadyRegistered);
  assert.equal((await L.registerPlayer({ config: LIVE, fetch: answer({ status: 'odd' }), nav: ONLINE, name: 'Ali', secret: SECRET })).reason, L.REASON.badResponse);
  assert.equal((await L.registerPlayer({ config: LIVE, fetch: () => Promise.resolve(resp(404, {})), nav: ONLINE, name: 'Ali', secret: SECRET })).reason, L.REASON.setup);
  assert.equal((await L.registerPlayer({ config: LIVE, fetch: () => Promise.resolve(resp(500, {})), nav: ONLINE, name: 'Ali', secret: SECRET })).reason, L.REASON.server);
  const bad = recorder(() => resp(200, {}));
  assert.equal((await L.registerPlayer({ config: LIVE, fetch: bad, nav: ONLINE, name: '<b>', secret: SECRET })).reason, L.REASON.invalid);
  assert.equal(bad.calls.length, 0, 'an invalid name never leaves the page');
});

test('a legacy JWT-style key is also sent as a Bearer token', async () => {
  const f = recorder(() => resp(200, { status: 'ok', name: 'A' }));
  await L.registerPlayer({ config: LEGACY, fetch: f, nav: ONLINE, name: 'A', secret: SECRET });
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer eyJhbGciOi.test');
});

test('submitting: the score and the ranked settings go up, never the name', async () => {
  const f = recorder(() => resp(200, { status: 'improved', best: 150, rank: 4 }));
  const r = await L.submitBest({ config: LIVE, fetch: f, nav: ONLINE, secret: SECRET, score: 150, settings: RANKED });
  assert.deepEqual(r, { ok: true, improved: true, best: 150, rank: 4 });
  const c = f.calls[0];
  assert.equal(c.url, 'https://example.supabase.co/rest/v1/rpc/submit_best');
  assert.deepEqual(c.body, { p_secret: SECRET, p_score: 150, p_walls: true, p_golden: true, p_difficulty: 'hard' });
  assert.equal('p_name' in c.body, false, 'a score cannot carry a name');
});

test('submitting: a score that does not beat the best is kept, and the answer says so', async () => {
  const f = recorder(() => resp(200, { status: 'kept', best: 150, rank: 4 }));
  assert.deepEqual(await L.submitBest({ config: LIVE, fetch: f, nav: ONLINE, secret: SECRET, score: 40, settings: RANKED }), { ok: true, improved: false, best: 150, rank: 4 });
});

test('submitting: unknown player, invalid answers and every network failure are reported, never as saved', async () => {
  const send = (fetch) => L.submitBest({ config: LIVE, fetch, nav: ONLINE, secret: SECRET, score: 10, settings: RANKED });
  assert.equal((await send(recorder(() => resp(200, { status: 'unknown-player' })))).reason, L.REASON.unknownPlayer);
  assert.equal((await send(recorder(() => resp(200, { status: 'invalid' })))).reason, L.REASON.invalid);
  assert.equal((await send(recorder(() => resp(200, { status: 'weird' })))).reason, L.REASON.badResponse);
  assert.equal((await send(recorder(() => resp(500, {})))).reason, L.REASON.server);
  assert.equal((await send(recorder(() => resp(400, {})))).reason, L.REASON.rejected);
  assert.equal((await send(() => Promise.reject(new Error('down')))).reason, L.REASON.network);
  const slow = (u, i) => new Promise((res, rej) => i.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
  assert.equal((await send(slow)).reason, L.REASON.timeout);
  assert.equal((await L.submitBest({ config: LIVE, fetch: recorder(() => resp(200, {})), nav: OFFLINE, secret: SECRET, score: 10, settings: RANKED })).reason, L.REASON.offline);
  assert.equal((await L.submitBest({ config: LIVE, fetch: recorder(() => resp(200, {})), nav: ONLINE, secret: 'bad', score: 10, settings: RANKED })).reason, L.REASON.invalid);
  assert.equal((await L.submitBest({ config: LIVE, fetch: recorder(() => resp(200, {})), nav: ONLINE, secret: SECRET, score: 1001, settings: RANKED })).reason, L.REASON.invalid);
});

test('my record: name, best and true rank; no best yet is null, not a rank', async () => {
  const f = recorder(() => resp(200, { status: 'ok', name: 'Waseem', best: 150, rank: 13 }));
  assert.deepEqual(await L.getMe({ config: LIVE, fetch: f, nav: ONLINE, secret: SECRET }), { ok: true, name: 'Waseem', best: 150, rank: 13 });
  assert.equal(f.calls[0].url, 'https://example.supabase.co/rest/v1/rpc/get_me');
  const none = await L.getMe({ config: LIVE, fetch: recorder(() => resp(200, { status: 'ok', name: 'A', best: null, rank: null })), nav: ONLINE, secret: SECRET });
  assert.deepEqual(none, { ok: true, name: 'A', best: null, rank: null });
  assert.equal((await L.getMe({ config: LIVE, fetch: recorder(() => resp(200, { status: 'unknown-player' })), nav: ONLINE, secret: SECRET })).reason, L.REASON.unknownPlayer);
  const bad = recorder(() => resp(200, {}));
  assert.equal((await L.getMe({ config: LIVE, fetch: bad, nav: ONLINE, secret: 'nope' })).reason, L.REASON.invalid);
  assert.equal(bad.calls.length, 0);
});

test('the board: asks for ten at most, maps ranks and dates, and refuses an odd answer', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ rank: i + 1, name: 'P' + i, score: 100 - i, achieved_at: '2026-01-0' + (1 + (i % 9)) + 'T10:00:00Z' }));
  const f = recorder(() => resp(200, rows));
  const t = await L.fetchTop({ config: LIVE, fetch: f, nav: ONLINE, limit: 50 });
  assert.equal(t.ok, true);
  assert.equal(t.rows.length, 10, 'never more than ten');
  assert.equal(t.rows[0].rank, 1);
  assert.equal(t.rows[0].score, 100);
  assert.equal(t.rows[0].date, '2026-01-01T10:00:00Z');
  assert.equal(f.calls[0].url, 'https://example.supabase.co/rest/v1/rpc/get_top');
  assert.deepEqual(f.calls[0].body, { p_limit: 10 });
  assert.equal((await L.fetchTop({ config: LIVE, fetch: recorder(() => resp(200, { no: 1 })), nav: ONLINE })).reason, L.REASON.badResponse);
  assert.deepEqual((await L.fetchTop({ config: LIVE, fetch: recorder(() => resp(200, [])), nav: ONLINE })).rows, []);
});
