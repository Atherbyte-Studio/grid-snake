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

/* ----- phase 1: identity is not lost when the answer is lost ----- */
function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
}
/* A fake server that really registers: it stores the code and the name, and can drop its answer once. */
function fakeServer(opts) {
  opts = opts || {};
  const players = new Map();           // secret -> name
  const sent = [];                     // every register_player call, as the server received it
  let dropNext = !!opts.dropFirstAnswer;
  const fetch = (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    const fn = url.split('/rest/v1/rpc/')[1];
    if (fn === 'register_player') {
      sent.push(body.p_secret);
      let answer;
      if (players.has(body.p_secret)) answer = { status: 'already-registered', name: players.get(body.p_secret) };
      else if ([...players.values()].some(n => n.toLowerCase() === body.p_name.toLowerCase())) answer = { status: 'taken' };
      else { players.set(body.p_secret, body.p_name); answer = { status: 'ok', name: body.p_name }; }
      if (dropNext && answer.status === 'ok') {
        dropNext = false;          // the server has registered, but the answer never reaches the page
        return Promise.reject(new TypeError('network connection was lost'));
      }
      return Promise.resolve(resp(200, answer));
    }
    if (fn === 'get_me') {
      if (!players.has(body.p_secret)) return Promise.resolve(resp(200, { status: 'unknown-player' }));
      return Promise.resolve(resp(200, { status: 'ok', name: players.get(body.p_secret), best: null, rank: null }));
    }
    return Promise.resolve(resp(404, {}));
  };
  return { fetch, players, sent };
}

test('lost answer: the server registers, the answer is lost, and the retry with the same code restores the identity', async () => {
  const storage = memoryStorage();
  const server = fakeServer({ dropFirstAnswer: true });
  const first = await L.enrollPlayer({ config: LIVE, nav: ONLINE, storage, fetch: server.fetch, name: 'Waseem' });
  assert.equal(first.ok, false);
  assert.equal(first.reason, L.REASON.network, 'the page sees a network failure, not a success');
  assert.equal(server.players.size, 1, 'the server did register the name');
  assert.ok(storage.getItem(L.PENDING_KEY), 'the code stays on this device after the failure');

  const retry = await L.enrollPlayer({ config: LIVE, nav: ONLINE, storage, fetch: server.fetch, name: 'Waseem' });
  assert.equal(retry.ok, true, 'the retry is treated as success');
  assert.equal(retry.restored, true, 'and reported as restored, not newly created');
  assert.equal(retry.name, 'Waseem');
  assert.equal(retry.secret, first.secret, 'the same code is used on the retry');
  assert.deepEqual([...new Set(server.sent)], [first.secret], 'the server only ever saw one code');
  assert.equal(server.players.size, 1, 'no second player and no unreachable name');
  assert.equal(storage.getItem(L.PENDING_KEY), null, 'the pending code is cleared once the identity is saved');
});

test('the code is written to storage before the registration request leaves', async () => {
  const storage = memoryStorage();
  let seenAtRequest = null;
  const fetch = (url, init) => { seenAtRequest = storage.getItem(L.PENDING_KEY); return Promise.resolve(resp(200, { status: 'ok', name: 'Ali' })); };
  const r = await L.enrollPlayer({ config: LIVE, nav: ONLINE, storage, fetch, name: 'Ali' });
  assert.equal(r.ok, true);
  assert.ok(seenAtRequest, 'storage held the code when the request was sent');
  assert.equal(JSON.parse(seenAtRequest).secret, r.secret);
});

test('a name taken by someone else is refused, and the same pending code is kept for another name', async () => {
  const storage = memoryStorage();
  const server = fakeServer();
  server.players.set('f'.repeat(32), 'Ali');
  const taken = await L.enrollPlayer({ config: LIVE, nav: ONLINE, storage, fetch: server.fetch, name: 'ali' });
  assert.equal(taken.ok, false);
  assert.equal(taken.reason, L.REASON.taken);
  const other = await L.enrollPlayer({ config: LIVE, nav: ONLINE, storage, fetch: server.fetch, name: 'Maya' });
  assert.equal(other.ok, true);
  assert.equal(other.secret, taken.secret, 'the code was reused, so nothing is reserved for an unknown code');
  assert.equal(server.players.get(other.secret), 'Maya');
});

test('a new code is generated only when nothing is pending', async () => {
  const storage = memoryStorage();
  const server = fakeServer({ dropFirstAnswer: true });
  const a = await L.enrollPlayer({ config: LIVE, nav: ONLINE, storage, fetch: server.fetch, name: 'Ruba' });
  const b = await L.enrollPlayer({ config: LIVE, nav: ONLINE, storage, fetch: server.fetch, name: 'Ruba' });
  assert.equal(b.secret, a.secret);
  const c = await L.enrollPlayer({ config: LIVE, nav: ONLINE, storage: memoryStorage(), fetch: server.fetch, name: 'Omar' });
  assert.notEqual(c.secret, a.secret, 'a fresh device gets a fresh code');
});

test('no storage: nothing is sent, because a code that cannot be kept must not reserve a name', async () => {
  const server = fakeServer();
  const broken = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
  const r = await L.enrollPlayer({ config: LIVE, nav: ONLINE, storage: broken, fetch: server.fetch, name: 'Sara' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, L.REASON.storage);
  assert.equal(server.sent.length, 0);
});

test('resume on page load: a pending code the server knows is restored; an unknown one stays for the next try', async () => {
  const storage = memoryStorage();
  const server = fakeServer({ dropFirstAnswer: true });
  await L.enrollPlayer({ config: LIVE, nav: ONLINE, storage, fetch: server.fetch, name: 'Lina' });
  const back = await L.resumePending({ config: LIVE, nav: ONLINE, storage, fetch: server.fetch });
  assert.equal(back.ok, true);
  assert.equal(back.name, 'Lina');
  assert.equal(storage.getItem(L.PENDING_KEY), null);

  storage.setItem(L.PENDING_KEY, JSON.stringify({ name: 'Nour', secret: '1'.repeat(32) }));
  const none = await L.resumePending({ config: LIVE, nav: ONLINE, storage, fetch: server.fetch });
  assert.equal(none.ok, false);
  assert.equal(none.reason, L.REASON.unknownPlayer);
  assert.ok(storage.getItem(L.PENDING_KEY), 'an unknown code is kept, not thrown away');
});
