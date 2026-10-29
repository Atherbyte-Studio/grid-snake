-- Checks for score_rounds.sql (part A), score_rounds_finalize.sql (part B) and rollback_score_rounds.sql.
-- A score counts only for the player's own open round, once, in time, and if possible in the time that passed.
-- Run on a scratch database (pglite-run.mjs or psql). Concurrency is checked by run.sh on a real PostgreSQL only.
\set ON_ERROR_STOP on
create or replace function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAILED: %', label; end if;
  raise notice 'ok: %', label;
end $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
create schema auth;
create table auth.users (id uuid primary key);
insert into auth.users values ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222'), ('33333333-3333-4333-8333-333333333333');
create table public.time_attack_scores (
  id bigint generated always as identity primary key, run_id uuid not null unique,
  name text not null, score integer not null, created_at timestamptz not null default now());
\i ../../supabase/leaderboard.sql
\i ../../supabase/account_link.sql
\set A '11111111-1111-4111-8111-111111111111'
\set B '22222222-2222-4222-8222-222222222222'
\set NOBODY '33333333-3333-4333-8333-333333333333'
select register_player('PlayerA', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), register_player('PlayerB', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
select gs_link_player(:'A', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), gs_link_player(:'B', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
select submit_best('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 30, true, true, 'hard');
create temporary table before_all as select id, name, secret_hash, best_score, best_at, account_id, linked_at from public.players;

-- ---------- part A is additive: nothing the old Worker uses changes ----------
\i ../../supabase/score_rounds.sql
\i ../../supabase/score_rounds.sql
select pg_temp.check('part A: players, scores and links unchanged', (select count(*) = (select count(*) from before_all) from public.players p join before_all b using (id)
  where p.name = b.name and p.secret_hash is not distinct from b.secret_hash and p.best_score is not distinct from b.best_score
    and p.best_at is not distinct from b.best_at and p.account_id is not distinct from b.account_id));
select pg_temp.check('part A: the old Worker path still works (gs_submit_best stays callable by service_role)',
  has_function_privilege('service_role', 'public.gs_submit_best(uuid, integer, boolean, boolean, text)', 'execute'));
select pg_temp.check('privileges: only the Worker opens and closes rounds',
  not has_function_privilege('anon', 'public.gs_start_round(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.gs_start_round(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.gs_submit_round(uuid, uuid, integer, boolean, boolean, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.gs_submit_round(uuid, uuid, integer, boolean, boolean, text)', 'execute')
  and has_function_privilege('service_role', 'public.gs_submit_round(uuid, uuid, integer, boolean, boolean, text)', 'execute')
  and not has_table_privilege('anon', 'public.player_rounds', 'SELECT, INSERT, UPDATE, DELETE')
  and not has_table_privilege('authenticated', 'public.player_rounds', 'SELECT, INSERT, UPDATE, DELETE'));
select pg_temp.check('privileges: both functions are SECURITY DEFINER with a fixed search_path',
  (select bool_and(prosecdef and proconfig is not null) from pg_proc where proname in ('gs_start_round', 'gs_submit_round')));

create temporary table a_before as select * from public.players where account_id = :'A'::uuid;
-- a round "started N seconds ago" is made by moving its start back: the same as waiting, without waiting
create function pg_temp.age(r uuid, secs numeric) returns void language sql as $$ update public.player_rounds set started_at = now() - make_interval(secs => secs) where id = r $$;
create function pg_temp.unchanged() returns boolean language sql as $$
  select p.best_score is not distinct from b.best_score and p.best_at is not distinct from b.best_at and p.name = b.name
  from public.players p join a_before b using (id) $$;
create function pg_temp.round(acct uuid, secs numeric) returns uuid language plpgsql as $$
declare r uuid; begin r := (gs_start_round(acct)->>'round')::uuid; perform pg_temp.age(r, secs); return r; end $$;
create function pg_temp.submit(acct uuid, r uuid, score int) returns text language sql as $$ select gs_submit_round(acct, r, score, true, true, 'hard')->>'status' $$;

select pg_temp.check('start: an account without a player gets no round', (select gs_start_round(:'NOBODY')->>'status' = 'no-player'));

-- ---------- rounds that are not this player's own open round ----------
select pg_temp.check('submit: a round id that does not exist', pg_temp.submit(:'A', gen_random_uuid(), 10) = 'no-round' and pg_temp.unchanged());
create temporary table rb as select pg_temp.round(:'B', 59) as id;
select pg_temp.check('submit: another player''s round is refused like an unknown one', pg_temp.submit(:'A', (select id from rb), 999) = 'no-round' and pg_temp.unchanged());
select pg_temp.check('submit: and stays open for its own player', (select status = 'open' from public.player_rounds where id = (select id from rb)));

-- ---------- the time limit, at its proven boundaries: allowed(E) = 5 * floor(min(60000, (E + 2) * 1000 + 100) / 60) ----------
create temporary table r0 as select pg_temp.round(:'A', 0) as id;
select pg_temp.check('bound: at the start, 175 is possible (5 * floor(2100 / 60))', pg_temp.submit(:'A', (select id from r0), 175) = 'improved');
create temporary table r0b as select pg_temp.round(:'A', 0) as id;
select pg_temp.check('bound: at the start, 180 is not', pg_temp.submit(:'A', (select id from r0b), 180) = 'implausible');
select pg_temp.check('bound: a refused round is closed: no second try with a smaller number', pg_temp.submit(:'A', (select id from r0b), 1) = 'round-closed');
create temporary table r8 as select pg_temp.round(:'A', 8) as id;
select pg_temp.check('bound: 999 after 8 s is not possible (at most 840)', pg_temp.submit(:'A', (select id from r8), 999) = 'implausible');
create temporary table r8b as select pg_temp.round(:'A', 8) as id;
select pg_temp.check('bound: 840 after 8 s is', pg_temp.submit(:'A', (select id from r8b), 840) = 'improved');
create temporary table r10 as select pg_temp.round(:'A', 10) as id;
select pg_temp.check('bound, KNOWN LIMIT: 999 after 10 s passes the filter (it cannot prove play)', pg_temp.submit(:'A', (select id from r10), 999) = 'improved');
create temporary table r60 as select pg_temp.round(:'A', 600) as id;
select pg_temp.check('bound: a long round (paused) still only allows 1000 at most', pg_temp.submit(:'A', (select id from r60), 1001) is null
  or (select gs_submit_round(:'A', (select id from r60), 1001, true, true, 'hard')->>'status' = 'invalid'));

-- ---------- one use per round ----------
create temporary table r45 as select pg_temp.round(:'A', 45) as id;
select pg_temp.check('submit: a real round is counted (kept: lower than the best)', pg_temp.submit(:'A', (select id from r45), 95) = 'kept');
select pg_temp.check('submit: the same round again is refused (replay)', pg_temp.submit(:'A', (select id from r45), 96) = 'round-closed');
select pg_temp.check('submit: the used round keeps the score it was counted with', (select status = 'used' and score = 95 from public.player_rounds where id = (select id from r45)));

-- ---------- settings and range do not close a round (a mistake, not an attempt) ----------
create temporary table r5 as select pg_temp.round(:'A', 50) as id;
select pg_temp.check('submit: not ranked, or out of range, is invalid and leaves the round open',
  (select gs_submit_round(:'A', (select id from r5), 10, false, true, 'hard')->>'status' = 'invalid')
  and (select gs_submit_round(:'A', (select id from r5), 1001, true, true, 'hard')->>'status' = 'invalid'));
select pg_temp.check('submit: the round is still open after those', (select status = 'open' from public.player_rounds where id = (select id from r5)));

-- ---------- up to 3 open rounds per player; a 4th closes the oldest ----------
update public.player_rounds set status = 'abandoned' where status = 'open' and player_id = (select id from public.players where account_id = :'A'::uuid);
create temporary table o1 as select pg_temp.round(:'A', 30) as id;
create temporary table o2 as select pg_temp.round(:'A', 20) as id;
create temporary table o3 as select pg_temp.round(:'A', 10) as id;
select pg_temp.check('open rounds: three stay open together', (select count(*) = 3 from public.player_rounds where status = 'open'
  and player_id = (select id from public.players where account_id = :'A'::uuid)));
create temporary table o4 as select pg_temp.round(:'A', 0) as id;
select pg_temp.check('open rounds: a fourth closes the oldest only', (select status = 'abandoned' from public.player_rounds where id = (select id from o1))
  and (select bool_and(status = 'open') from public.player_rounds where id in ((select id from o2), (select id from o3), (select id from o4))));
select pg_temp.check('open rounds: an older run''s round still counts after newer runs started', pg_temp.submit(:'A', (select id from o2), 20) = 'kept');
select pg_temp.check('open rounds: the abandoned one does not', pg_temp.submit(:'A', (select id from o1), 20) = 'round-closed');
select pg_temp.check('open rounds: B''s start never closes A''s rounds', (select gs_start_round(:'B')->>'status' = 'ok')
  and (select status = 'open' from public.player_rounds where id = (select id from o3)));

-- ---------- expiry ----------
create temporary table r16 as select pg_temp.round(:'A', 16 * 60) as id;
select pg_temp.check('submit: a round older than 15 minutes has expired', pg_temp.submit(:'A', (select id from r16), 10) = 'round-expired');
select pg_temp.check('submit: and is closed as expired', (select status = 'expired' from public.player_rounds where id = (select id from r16)));
select pg_temp.check('B untouched by everything A did', (select best_score is null from public.players where account_id = :'B'::uuid));

-- ---------- part B closes the old path, and only that ----------
\i ../../supabase/score_rounds_finalize.sql
select pg_temp.check('part B: gs_submit_best is no longer callable by the Worker',
  not has_function_privilege('service_role', 'public.gs_submit_best(uuid, integer, boolean, boolean, text)', 'execute'));
select pg_temp.check('part B: rounds still work', pg_temp.submit(:'A', pg_temp.round(:'A', 50), 10) = 'kept');

-- ---------- rollback of the rounds only ----------
create temporary table before_rollback as select id, name, secret_hash, best_score, best_at, account_id, linked_at from public.players;
create temporary table rounds_before as select count(*) as n from public.player_rounds;
\i ../../supabase/rollback_score_rounds.sql
select pg_temp.check('rollback: players, names, scores, codes and links exactly as before', (select count(*) = (select count(*) from before_rollback)
  from public.players p join before_rollback b using (id)
  where p.name = b.name and p.secret_hash is not distinct from b.secret_hash and p.best_score is not distinct from b.best_score
    and p.best_at is not distinct from b.best_at and p.account_id is not distinct from b.account_id and p.linked_at is not distinct from b.linked_at));
select pg_temp.check('rollback: every round row is kept aside', (select count(*) from gs_rolledback.player_rounds) = (select n from rounds_before));
select pg_temp.check('rollback: the round functions are gone', to_regprocedure('public.gs_start_round(uuid)') is null
  and to_regprocedure('public.gs_submit_round(uuid, uuid, integer, boolean, boolean, text)') is null);
select pg_temp.check('rollback: the old path is callable by the Worker again',
  has_function_privilege('service_role', 'public.gs_submit_best(uuid, integer, boolean, boolean, text)', 'execute'));
select pg_temp.check('rollback: the account link is untouched', to_regprocedure('public.gs_link_player(uuid, text)') is not null
  and (select count(*) = 2 from public.players where account_id is not null));
alter table gs_rolledback.player_rounds rename to player_rounds_kept;
\i ../../supabase/score_rounds.sql
select pg_temp.check('re-apply: part A works again after a rollback', pg_temp.submit(:'A', pg_temp.round(:'A', 50), 10) = 'kept');
