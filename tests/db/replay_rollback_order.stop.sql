-- Must STOP: rollback_score_rounds.sql refuses to run while replayed scores (score_replay.sql) are applied.
-- pglite-run.mjs expects a 'STOP:' error from *.stop.sql.
\set ON_ERROR_STOP on
grant usage on schema public to anon, authenticated, service_role;
create schema auth;
create table auth.users (id uuid primary key);
create table public.time_attack_scores (
  id bigint generated always as identity primary key, run_id uuid not null unique,
  name text not null, score integer not null, created_at timestamptz not null default now());
\i ../../supabase/leaderboard.sql
\i ../../supabase/account_link.sql
\i ../../supabase/score_rounds.sql
\i ../../supabase/score_replay.sql
\i ../../supabase/rollback_score_rounds.sql
