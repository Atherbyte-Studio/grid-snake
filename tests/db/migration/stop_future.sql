-- The version 1 table is migrated first, so the project is version 2 now. Later a NEW table called
-- time_attack_scores appears (here: a copy of the legacy table's shape, with one row). Running the migration
-- again must stop, and must not move that table.
create table public.time_attack_scores (
  id bigint generated always as identity primary key, run_id uuid not null unique,
  name text not null, score integer not null, created_at timestamptz not null default now());
insert into public.time_attack_scores (run_id, name, score) values (gen_random_uuid(), 'Ali', 10), (gen_random_uuid(), 'Sara', 20);
\i ../../supabase/leaderboard.sql
create table public.time_attack_scores (like public.time_attack_scores_legacy including all);
insert into public.time_attack_scores (run_id, name, score) values (gen_random_uuid(), 'Future', 30);
\i ../../supabase/leaderboard.sql
