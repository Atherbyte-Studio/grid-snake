-- Checks for score_replay.sql (part A2), score_replay_finalize.sql (part B2) and rollback_score_replay.sql.
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
insert into auth.users values ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
create table public.time_attack_scores (
  id bigint generated always as identity primary key, run_id uuid not null unique,
  name text not null, score integer not null, created_at timestamptz not null default now());
\i ../../supabase/leaderboard.sql
\i ../../supabase/account_link.sql
\set A '11111111-1111-4111-8111-111111111111'
\set B '22222222-2222-4222-8222-222222222222'
select register_player('PlayerA', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), register_player('PlayerB', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
select gs_link_player(:'A', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), gs_link_player(:'B', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
\i ../../supabase/score_rounds.sql
\i ../../supabase/score_rounds_finalize.sql
create temporary table v1_round as select (gs_start_round(:'A')->>'round')::uuid as id;     -- a round opened before A2
create temporary table before_all as select id, name, secret_hash, best_score, best_at, account_id, linked_at from public.players;

-- ---------- part A2 is additive ----------
\i ../../supabase/score_replay.sql
\i ../../supabase/score_replay.sql
select pg_temp.check('A2: players untouched', (select count(*) = (select count(*) from before_all) from public.players p join before_all b using (id)
  where p.name = b.name and p.secret_hash is not distinct from b.secret_hash and p.best_score is not distinct from b.best_score
    and p.account_id is not distinct from b.account_id));
select pg_temp.check('A2: a round opened before it got a seed too', (select seed is not null and seed between 0 and 4294967295 from public.player_rounds where id = (select id from v1_round)));
select pg_temp.check('A2: the live Worker path still works (gs_submit_round callable)',
  has_function_privilege('service_role', 'public.gs_submit_round(uuid, uuid, integer, boolean, boolean, text)', 'execute'));
select pg_temp.check('A2: only the Worker can use the replay functions',
  not has_function_privilege('anon', 'public.gs_submit_replay(uuid, uuid, integer, integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.gs_submit_replay(uuid, uuid, integer, integer)', 'execute')
  and not has_function_privilege('anon', 'public.gs_round_seed(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.gs_reject_round(uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.gs_submit_replay(uuid, uuid, integer, integer)', 'execute')
  and has_function_privilege('service_role', 'public.gs_round_seed(uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.gs_reject_round(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.gs_start_round(uuid)', 'execute'));

create function pg_temp.age(r uuid, secs numeric) returns void language sql as $$ update public.player_rounds set started_at = now() - make_interval(secs => secs) where id = r $$;
create function pg_temp.open(acct uuid, secs numeric) returns uuid language plpgsql as $$
declare r uuid; begin r := (gs_start_round(acct)->>'round')::uuid; perform pg_temp.age(r, secs); return r; end $$;

update public.player_rounds set status = 'abandoned' where status = 'open';
select gs_start_round(:'B') from generate_series(1, 5);
select pg_temp.check('start: five open rounds per player (a round fetched ahead per tab or device)',
  (select count(*) = 5 from public.player_rounds r join public.players p on p.id = r.player_id where p.account_id = :'B'::uuid and r.status = 'open'));
select gs_start_round(:'B');
select pg_temp.check('start: a sixth closes the oldest only',
  (select count(*) = 5 from public.player_rounds r join public.players p on p.id = r.player_id where p.account_id = :'B'::uuid and r.status = 'open'));
select pg_temp.check('start: the answer carries the round''s seed', (select (x->>'seed')::bigint = (select seed from public.player_rounds where id = (x->>'round')::uuid) from gs_start_round(:'A') x));
create temporary table r1 as select pg_temp.open(:'A', 61) as id;
select pg_temp.check('seed: the owner reads the seed of an open round', (select gs_round_seed(:'A', (select id from r1))->>'status' = 'ok'
  and (gs_round_seed(:'A', (select id from r1))->>'seed')::bigint = (select seed from public.player_rounds where id = (select id from r1))));
select pg_temp.check('seed: another account cannot read it', (select gs_round_seed(:'B', (select id from r1))->>'status' = 'no-round'));

-- ---------- a replayed score ----------
select pg_temp.check('replay: a 60 s round counts', (select r->>'status' = 'improved' and (r->>'best')::int = 50 from gs_submit_replay(:'A', (select id from r1), 50, 60000) r));
select pg_temp.check('replay: it keeps its score and game time', (select status = 'used' and score = 50 and game_ms = 60000 from public.player_rounds where id = (select id from r1)));
select pg_temp.check('replay: the same round again is refused', (select gs_submit_replay(:'A', (select id from r1), 60, 60000)->>'status' = 'round-closed'));
select pg_temp.check('seed: a used round gives no seed', (select gs_round_seed(:'A', (select id from r1))->>'status' = 'round-closed'));
create temporary table r2 as select pg_temp.open(:'A', 10) as id;
select pg_temp.check('replay: more game time than real time is refused (fast-forward)', (select gs_submit_replay(:'A', (select id from r2), 10, 30000)->>'status' = 'implausible'));
select pg_temp.check('replay: and the round is closed', (select status = 'rejected' from public.player_rounds where id = (select id from r2)));
create temporary table r3 as select pg_temp.open(:'A', 30) as id;
select pg_temp.check('replay: bad values are invalid and leave the round open',
  (select gs_submit_replay(:'A', (select id from r3), 10, 60001)->>'status' = 'invalid') and (select gs_submit_replay(:'A', (select id from r3), 1001, 1000)->>'status' = 'invalid')
  and (select status = 'open' from public.player_rounds where id = (select id from r3)));
select pg_temp.check('replay: another account cannot use the round', (select gs_submit_replay(:'B', (select id from r3), 10, 1000)->>'status' = 'no-round'));
select pg_temp.check('reject: another account cannot close it', (select gs_reject_round(:'B', (select id from r3))->>'status' = 'no-round')
  and (select status = 'open' from public.player_rounds where id = (select id from r3)));
select pg_temp.check('reject: the owner''s Worker closes a round whose record does not replay', (select gs_reject_round(:'A', (select id from r3))->>'status' = 'closed'));
select pg_temp.check('reject: and it can no longer count', (select gs_submit_replay(:'A', (select id from r3), 10, 1000)->>'status' = 'round-closed'));
create temporary table r4 as select pg_temp.open(:'A', 16 * 60) as id;
select pg_temp.check('replay: an expired round is refused', (select gs_submit_replay(:'A', (select id from r4), 10, 1000)->>'status' = 'round-expired'));
select pg_temp.check('B untouched by everything A did', (select best_score is null from public.players where account_id = :'B'::uuid));

-- (the order of the rollbacks is checked by tests/db/replay_rollback_order.stop.sql)

-- ---------- part B2, then the rollback of A2/B2 only ----------
\i ../../supabase/score_replay_finalize.sql
select pg_temp.check('B2: the Worker can no longer count a score without a replay',
  not has_function_privilege('service_role', 'public.gs_submit_round(uuid, uuid, integer, boolean, boolean, text)', 'execute'));
select pg_temp.check('B2: replayed scores still count', (select gs_submit_replay(:'A', pg_temp.open(:'A', 61), 10, 60000)->>'status' = 'kept'));
create temporary table before_rollback as select id, name, secret_hash, best_score, best_at, account_id, linked_at from public.players;
create temporary table rounds_before as select count(*) n from public.player_rounds;
\i ../../supabase/rollback_score_replay.sql
select pg_temp.check('rollback A2: players exactly as before', (select count(*) = (select count(*) from before_rollback) from public.players p join before_rollback b using (id)
  where p.name = b.name and p.secret_hash is not distinct from b.secret_hash and p.best_score is not distinct from b.best_score
    and p.best_at is not distinct from b.best_at and p.account_id is not distinct from b.account_id));
select pg_temp.check('rollback A2: every round and its seed kept', (select count(*) from public.player_rounds) = (select n from rounds_before)
  and not exists (select 1 from public.player_rounds where seed is null));
select pg_temp.check('rollback A2: rounds without replay work again for the Worker',
  has_function_privilege('service_role', 'public.gs_submit_round(uuid, uuid, integer, boolean, boolean, text)', 'execute')
  and (select gs_submit_round(:'A', pg_temp.open(:'A', 50), 10, true, true, 'hard')->>'status' = 'kept'));
select pg_temp.check('rollback A2: the replay functions are gone', to_regprocedure('public.gs_submit_replay(uuid, uuid, integer, integer)') is null
  and to_regprocedure('public.gs_round_seed(uuid, uuid)') is null and to_regprocedure('public.gs_reject_round(uuid, uuid)') is null);
\i ../../supabase/score_replay.sql
select pg_temp.check('re-apply A2 after its rollback', (select gs_submit_replay(:'A', pg_temp.open(:'A', 61), 10, 60000)->>'status' = 'kept'));
