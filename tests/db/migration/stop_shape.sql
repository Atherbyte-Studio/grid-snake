-- time_attack_scores exists but is NOT the version 1 table (an extra column). The migration must stop.
create table public.time_attack_scores (
  id bigint generated always as identity primary key, run_id uuid not null unique,
  name text not null, score integer not null, created_at timestamptz not null default now(), note text);
insert into public.time_attack_scores (run_id, name, score) values (gen_random_uuid(), 'Ali', 10);
\i ../../supabase/leaderboard.sql
