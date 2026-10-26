-- Both the old table and the renamed one exist. The migration must stop and change nothing.
create table public.time_attack_scores (
  id bigint generated always as identity primary key, run_id uuid not null unique,
  name text not null, score integer not null, created_at timestamptz not null default now());
create table public.time_attack_scores_legacy (like public.time_attack_scores including all);
insert into public.time_attack_scores (run_id, name, score) values (gen_random_uuid(), 'Ali', 10);
\i ../../supabase/leaderboard.sql
