-- version 1 -> version 2 -> rollback (nothing deleted) -> version 1 writes -> version 2 again.
create table public.time_attack_scores (
  id bigint generated always as identity primary key, run_id uuid not null unique,
  name text not null, score integer not null, created_at timestamptz not null default now());
insert into public.time_attack_scores (run_id, name, score, created_at) values
  (gen_random_uuid(), 'Ali', 120, '2026-01-01'), (gen_random_uuid(), 'Sara', 90, '2026-01-02');
\i ../../supabase/leaderboard.sql
select register_player('Waseem', '0123456789abcdef0123456789abcdef');
\i ../../supabase/rollback_v2.sql

do $$
begin
  assert to_regclass('public.time_attack_scores') is not null, 'rollback: the v1 table is back';
  assert to_regclass('public.players_v2_saved') is not null, 'rollback: the v2 players are kept, not dropped';
  assert (select count(*) from players_v2_saved) = 3, 'rollback: all 3 players kept (Ali, Sara, Waseem)';
  assert to_regclass('public.players') is null, 'rollback: players is gone from the live name';
  assert to_regproc('public.register_player') is null, 'rollback: v2 functions removed';
  raise notice 'ok: rollback renames, deletes nothing';
end $$;

-- version 1 keeps playing: a new round goes into the restored table
insert into public.time_attack_scores (run_id, name, score, created_at) values (gen_random_uuid(), 'Nour', 60, '2026-02-01');

\i ../../supabase/leaderboard.sql

do $$
begin
  assert (select count(*) from players) = 3, 'second upgrade: Ali, Sara and Nour';
  assert (select count(*) from players_v2_saved) = 3, 'second upgrade: the saved copy is untouched';
  assert (select count(*) from players where name = 'Nour' and best_score = 60), 'the round played on v1 is migrated';
  -- the unique name index belongs to the NEW players table, not to the saved copy
  assert (select indrelid = 'public.players'::regclass from pg_index where indexrelid = 'public.players_name_ci'::regclass),
    'players_name_ci is on the new players table';
  begin
    insert into players (name) values ('ali');   -- the same name, ignoring case, as Ali
    raise exception 'the new players table accepted a duplicate name';
  exception when unique_violation then null;
  end;
  raise notice 'ok: rollback then upgrade again keeps both copies and the indexes';
end $$;
