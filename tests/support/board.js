'use strict';
/* A stand-in for the global board's database functions, for the browser tests. No network.
 * It follows the same rules as supabase/leaderboard.sql: unique names ignoring case, one best per player,
 * a best that only goes up, ranked settings only, and the top ten by score then earlier time. */
const KEY = 'gridsnake-player-v1';
const SECRET = '0123456789abcdef0123456789abcdef';

/* The local identity a returning player already has in this browser. */
function identityStorage(name, secret) {
  return { [KEY]: JSON.stringify({ name: name, secret: secret || SECRET }) };
}

function makeBoard(players) {
  const db = { players: [], calls: [], fail: [], seq: 0 };
  (players || []).forEach(p => db.players.push({ name: p.name, secret: p.secret || null, best: p.best, at: ++db.seq }));
  const byName = n => db.players.find(p => p.name.toLowerCase() === n.toLowerCase());
  const bySecret = s => db.players.find(p => p.secret === s);
  const rankOf = me => 1 + db.players.filter(o => o.best != null && me.best != null &&
    (o.best > me.best || (o.best === me.best && o.at < me.at))).length;
  const json = (status, body) => ({ status, body: JSON.stringify(body), contentType: 'application/json' });

  db.route = async route => {
    const req = route.request();
    const fn = new URL(req.url()).pathname.split('/rest/v1/rpc/')[1] || '';
    const b = req.postData() ? JSON.parse(req.postData()) : {};
    db.calls.push({ fn, body: b });
    if (fn === 'submit_best' && db.fail.length) return route.fulfill(json(db.fail.shift(), { message: 'simulated' }));
    if (fn === 'register_player') {
      const name = String(b.p_name || '').trim().replace(/\s+/g, ' ');
      if (!/^[0-9a-f]{32}$/.test(b.p_secret)) return route.fulfill(json(200, { status: 'invalid' }));
      if (bySecret(b.p_secret)) return route.fulfill(json(200, { status: 'already-registered', name: bySecret(b.p_secret).name }));
      if (byName(name)) return route.fulfill(json(200, { status: 'taken' }));
      if (!name || name.length > 16 || /[<>&"`\\]/.test(name)) return route.fulfill(json(200, { status: 'invalid' }));
      db.players.push({ name: name, secret: b.p_secret, best: null, at: null });
      return route.fulfill(json(200, { status: 'ok', name: name }));
    }
    if (fn === 'submit_best') {
      if (b.p_walls !== true || b.p_golden !== true || b.p_difficulty !== 'hard') return route.fulfill(json(200, { status: 'invalid' }));
      if (!(b.p_score >= 0 && b.p_score <= 1000)) return route.fulfill(json(200, { status: 'invalid' }));
      const me = bySecret(b.p_secret);
      if (!me) return route.fulfill(json(200, { status: 'unknown-player' }));
      if (me.best == null || b.p_score > me.best) { me.best = b.p_score; me.at = ++db.seq; return route.fulfill(json(200, { status: 'improved', best: me.best, rank: rankOf(me) })); }
      return route.fulfill(json(200, { status: 'kept', best: me.best, rank: rankOf(me) }));
    }
    if (fn === 'get_me') {
      const me = bySecret(b.p_secret);
      if (!me) return route.fulfill(json(200, { status: 'unknown-player' }));
      return route.fulfill(json(200, { status: 'ok', name: me.name, best: me.best, rank: me.best == null ? null : rankOf(me) }));
    }
    if (fn === 'get_top') {
      const rows = db.players.filter(p => p.best != null).sort((x, y) => y.best - x.best || x.at - y.at).slice(0, Math.min(10, b.p_limit || 10))
        .map((p, i) => ({ rank: i + 1, name: p.name, score: p.best, achieved_at: new Date(2026, 0, 1 + i).toISOString() }));
      return route.fulfill(json(200, rows));
    }
    return route.fulfill(json(404, { message: 'no such function' }));
  };
  db.submits = () => db.calls.filter(c => c.fn === 'submit_best');
  return db;
}

/* A board where the test player is registered, as after a first visit. */
function defaultBoard(extra) {
  return makeBoard([{ name: 'Waseem', secret: SECRET, best: null }].concat(extra || []));
}

module.exports = { KEY, SECRET, identityStorage, makeBoard, defaultBoard };
