-- Checks for lock_legacy_submit.sql and its rollback: the browser keys can no longer set a score by calling submit_best.
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
create or replace function pg_temp.runs_as(r text, q text) returns boolean language plpgsql as $$
begin
  execute format('set local role %I', r);
  execute q;
  reset role;
  return true;
exception when insufficient_privilege then
  reset role;
  return false;
end $$;

-- before the lock the hole is real: a visitor sets a score of 999 with no round
select pg_temp.check('before: anon can call submit_best', pg_temp.runs_as('anon', $q$select submit_best('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 999, true, true, 'hard')$q$));

-- the lock refuses to run without the replayed path (psql carries on after the error, the file rolls back)
\set ON_ERROR_STOP off
\i ../../supabase/lock_legacy_submit.sql
\set ON_ERROR_STOP on
select pg_temp.check('before replay: the lock stopped and changed nothing', pg_temp.runs_as('anon', $q$select submit_best('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 5, true, true, 'hard')$q$));
\i ../../supabase/score_replay.sql
\i ../../supabase/lock_legacy_submit.sql
\i ../../supabase/lock_legacy_submit.sql

select pg_temp.check('after: anon cannot call submit_best', not pg_temp.runs_as('anon', $q$select submit_best('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1000, true, true, 'hard')$q$));
select pg_temp.check('after: authenticated cannot call submit_best', not pg_temp.runs_as('authenticated', $q$select submit_best('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1000, true, true, 'hard')$q$));
select pg_temp.check('after: nobody wrote a score', (select best_score from players where name = 'PlayerA') is not distinct from (select best_score from players where name = 'PlayerA' limit 1) and not exists (select 1 from players where best_score = 1000));
select pg_temp.check('after: the board and registration still work for anon', pg_temp.runs_as('anon', 'select get_top(10)') and pg_temp.runs_as('anon', $q$select register_player('Fresh', 'cccccccccccccccccccccccccccccccc')$q$) and pg_temp.runs_as('anon', $q$select get_me('cccccccccccccccccccccccccccccccc')$q$));
select pg_temp.check('after: the browser still cannot call the Worker functions', not pg_temp.runs_as('anon', $q$select gs_submit_replay('11111111-1111-4111-8111-111111111111', gen_random_uuid(), 999, 60000)$q$) and not pg_temp.runs_as('authenticated', $q$select gs_save('11111111-1111-4111-8111-111111111111', '{}'::jsonb, 0)$q$));
select pg_temp.check('after: the Worker role still scores through the replayed path', pg_temp.runs_as('service_role', $q$select gs_start_round('11111111-1111-4111-8111-111111111111')$q$));

\i ../../supabase/rollback_lock_legacy_submit.sql
select pg_temp.check('rollback: submit_best is callable again', pg_temp.runs_as('anon', $q$select submit_best('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 5, true, true, 'hard')$q$));
