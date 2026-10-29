-- Must STOP: rollback_account_link.sql refuses to run while ranked rounds are applied (rounds are undone by
-- rollback_score_rounds.sql, never by the account-link rollback). pglite-run.mjs expects a 'STOP:' error from *.stop.sql.
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
\i ../../supabase/rollback_account_link.sql
