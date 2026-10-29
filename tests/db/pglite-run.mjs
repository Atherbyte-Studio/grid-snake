// Runs the SQL check files on PGlite (PostgreSQL compiled to WebAssembly), for machines without a Postgres server.
// Usage: npm install --no-save @electric-sql/pglite@0.2.17   then   node tests/db/pglite-run.mjs [file.sql ...]
// Each file gets a fresh, empty in-memory database. psql's "\i path" is inlined and "\set" lines are skipped.
// No concurrency here (PGlite has one connection); run.sh on a real Postgres covers the parallel cases.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = process.env.PGLITE_PATH ? pathToFileURL(path.join(process.env.PGLITE_PATH, 'dist/index.js')).href : '@electric-sql/pglite';
const { PGlite } = await import(lib);

// The Supabase roles, as a Supabase project has them before any of our files run.
const PREAMBLE = `do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;\n`;

// "\i path" is inlined, "\set NAME 'value'" defines a variable and ":'NAME'" uses it, as in psql.
function inline(file, vars, seen = new Set()) {
  if (seen.has(file)) throw new Error('include loop: ' + file);
  seen.add(file);
  return fs.readFileSync(file, 'utf8').split('\n').map((line) => {
    const t = line.trim();
    const inc = /^\\i\s+(\S+)/.exec(t);
    if (inc) return inline(path.resolve(here, inc[1]), vars, new Set(seen));   // psql resolves from the cwd, which run.sh sets to here
    const set = /^\\set\s+(\w+)\s+'([^']*)'/.exec(t);
    if (set) { vars[set[1]] = set[2]; return ''; }
    if (/^\\/.test(t)) return '';
    return line.replace(/:'(\w+)'/g, (m, k) => (k in vars ? `'${vars[k]}'` : m));
  }).join('\n');
}

const files = process.argv.slice(2).length ? process.argv.slice(2)
  : ['leaderboard_v2.sql', 'account_link.sql', 'score_rounds.sql', 'rollback_order.stop.sql', 'score_replay.sql', 'replay_rollback_order.stop.sql'];
let failed = 0;
for (const f of files) {
  const file = path.resolve(here, f);
  const mustStop = f.endsWith('.stop.sql');     // these must end with a 'STOP:' error and nothing else
  const db = new PGlite();
  const notices = [];
  try {
    await db.exec(PREAMBLE + inline(file, {}), { onNotice: (n) => notices.push(n.message) });
    const ok = notices.filter((m) => m.startsWith('ok:')).length;
    if (mustStop) { failed++; console.log(`${f}: FAILED: it did not stop`); }
    else console.log(`${f}: ${ok} checks passed`);
  } catch (e) {
    if (mustStop && /STOP:/.test(e.message)) { console.log(`${f}: stopped as expected (${e.message.slice(0, 70)}…)`); continue; }
    failed++;
    console.log(`${f}: FAILED after ${notices.filter((m) => m.startsWith('ok:')).length} checks: ${e.message}`);
  } finally {
    await db.close();
  }
}
process.exit(failed ? 1 : 0);
