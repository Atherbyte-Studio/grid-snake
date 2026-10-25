'use strict';
/* Global leaderboard client: validation, mode rule, the REST calls, and every failure path. No network: fetch is faked. */
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/leaderboard.js');

const LIVE = Object.assign({}, L.CONFIG, { url: 'https://example.supabase.co', anonKey: 'anon-test-key', timeoutMs: 200 });
const ONLINE = { onLine: true };
const OFFLINE = { onLine: false };

function resp(status, body) {
  return { status: status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

test('names: a short, clean name passes; markup, blanks, long names and odd characters do not', () => {
  assert.equal(L.validateName('Waseem').ok, true);
  assert.equal(L.validateName('  Two   Words ').name, 'Two Words');
  assert.equal(L.validateName('واسيم').ok, true, 'Arabic letters are allowed');
  for (const bad of ['', '   ', '<b>x</b>', 'a&b', 'say "hi"', "it's", 'a\\b', 'x'.repeat(17), '\u0007bell', 'ok\tname', '!!!', 42, null]) {
    assert.equal(L.validateName(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('scores: whole numbers from 0 to the cap only', () => {
  assert.equal(L.validateScore(0).ok, true);
  assert.equal(L.validateScore(L.CONFIG.maxScore).ok, true);
  for (const bad of [-1, 1.5, L.CONFIG.maxScore + 1, NaN, Infinity, '12', null]) {
    assert.equal(L.validateScore(bad).ok, false, `should reject ${String(bad)}`);
  }
});

test('only Time Attack runs are sent: other modes never reach the network', async () => {
  let calls = 0;
  const f = () => { calls++; return Promise.resolve(resp(201, {})); };
  for (const mode of ['classic', 'survival', 'chase', 'golden', undefined]) {
    const r = await L.submitRun({ config: LIVE, fetch: f, nav: ONLINE, mode, name: 'A', score: 10 });
    assert.equal(r.reason, L.REASON.wrongMode, `${mode} was not refused`);
  }
  assert.equal(calls, 0);
});

test('with no project set up, nothing is sent and the reason says so', async () => {
  let calls = 0;
  const f = () => { calls++; return Promise.resolve(resp(201, {})); };
  const r = await L.submitRun({ config: L.CONFIG, fetch: f, nav: ONLINE, mode: 'timeattack', name: 'A', score: 10 });
  assert.equal(r.reason, L.REASON.notConfigured);
  const t = await L.fetchTop({ config: L.CONFIG, fetch: f, nav: ONLINE });
  assert.equal(t.reason, L.REASON.notConfigured);
  assert.equal(calls, 0);
  assert.equal(L.configured(L.CONFIG), false, 'the shipped config is not configured');
});

test('a good run posts once, with the public key only and the right body', async () => {
  const seen = [];
  const f = (url, init) => { seen.push({ url, init }); return Promise.resolve(resp(201, {})); };
  const r = await L.submitRun({ config: LIVE, fetch: f, nav: ONLINE, mode: 'timeattack', name: 'Waseem', score: 42, runId: '11111111-1111-4111-8111-111111111111' });
  assert.deepEqual(r, { ok: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://example.supabase.co/rest/v1/time_attack_scores');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers.apikey, 'anon-test-key');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer anon-test-key');
  assert.deepEqual(JSON.parse(seen[0].init.body), { run_id: '11111111-1111-4111-8111-111111111111', name: 'Waseem', score: 42 });
  assert.ok(!/service/i.test(JSON.stringify(seen[0].init.headers)), 'never a service-role key');
});

test('a bad name or score is refused before any request', async () => {
  let calls = 0;
  const f = () => { calls++; return Promise.resolve(resp(201, {})); };
  assert.equal((await L.submitRun({ config: LIVE, fetch: f, nav: ONLINE, mode: 'timeattack', name: '<x>', score: 5 })).reason, L.REASON.invalid);
  assert.equal((await L.submitRun({ config: LIVE, fetch: f, nav: ONLINE, mode: 'timeattack', name: 'OK', score: 99999 })).reason, L.REASON.invalid);
  assert.equal(calls, 0);
});

test('offline: no request, and the game is told why', async () => {
  let calls = 0;
  const f = () => { calls++; return Promise.resolve(resp(201, {})); };
  const r = await L.submitRun({ config: LIVE, fetch: f, nav: OFFLINE, mode: 'timeattack', name: 'A', score: 5 });
  assert.equal(r.reason, L.REASON.offline);
  assert.equal(calls, 0);
});

test('every failure comes back as a result, never a throw', async () => {
  const cases = [
    [() => Promise.reject(new TypeError('Failed to fetch')), L.REASON.network],
    [() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), L.REASON.timeout],
    [() => Promise.resolve(resp(500, { message: 'db down' })), L.REASON.server],
    [() => Promise.resolve(resp(400, { message: 'check violated' })), L.REASON.rejected],
    [() => Promise.resolve(resp(401, {})), L.REASON.rejected],
  ];
  for (const [f, reason] of cases) {
    const r = await L.submitRun({ config: LIVE, fetch: f, nav: ONLINE, mode: 'timeattack', name: 'A', score: 5 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason);
  }
});

test('posting the same run twice is reported as already posted, not as a failure', async () => {
  const r = await L.submitRun({ config: LIVE, fetch: () => Promise.resolve(resp(409, {})), nav: ONLINE, mode: 'timeattack', name: 'A', score: 5 });
  assert.deepEqual(r, { ok: true, duplicate: true });
});

test('the board: ordered best score first, earlier run first on a tie, with page and rank', async () => {
  const seen = [];
  const rows = [{ name: 'Ann', score: 90, created_at: '2026-10-01T10:00:00Z' }, { name: 'Bo', score: 90, created_at: '2026-10-02T10:00:00Z' }];
  const f = url => { seen.push(url); return Promise.resolve(resp(200, rows)); };
  const r = await L.fetchTop({ config: LIVE, fetch: f, nav: ONLINE, page: 2, pageSize: 2 });
  assert.equal(r.ok, true);
  assert.match(seen[0], /order=score\.desc,created_at\.asc/);
  assert.match(seen[0], /limit=2&offset=4/);
  assert.deepEqual(r.rows.map(x => x.rank), [5, 6]);
  assert.equal(r.hasMore, true, 'a full page means there may be more');
});

test('the board: an empty table is an empty list, not an error', async () => {
  const r = await L.fetchTop({ config: LIVE, fetch: () => Promise.resolve(resp(200, [])), nav: ONLINE });
  assert.deepEqual(r, { ok: true, rows: [], page: 0, hasMore: false });
});

test('the board: a non-list reply or broken JSON is a bad response, not a crash', async () => {
  const notList = await L.fetchTop({ config: LIVE, fetch: () => Promise.resolve(resp(200, { oops: 1 })), nav: ONLINE });
  assert.equal(notList.reason, L.REASON.badResponse);
  const broken = await L.fetchTop({ config: LIVE, fetch: () => Promise.resolve({ status: 200, json: () => Promise.reject(new SyntaxError('x')) }), nav: ONLINE });
  assert.equal(broken.reason, L.REASON.badResponse);
});

test('the board: a failed read is reported, and offline is reported without a request', async () => {
  const down = await L.fetchTop({ config: LIVE, fetch: () => Promise.reject(new TypeError('x')), nav: ONLINE });
  assert.equal(down.reason, L.REASON.network);
  let calls = 0;
  const off = await L.fetchTop({ config: LIVE, fetch: () => { calls++; return Promise.resolve(resp(200, [])); }, nav: OFFLINE });
  assert.equal(off.reason, L.REASON.offline);
  assert.equal(calls, 0);
});

test('run ids are well-formed version 4 UUIDs', () => {
  const id = L.makeRunId(() => 0.37);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(L.makeRunId(() => 0.1), L.makeRunId(() => 0.9));
});
