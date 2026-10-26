-- Version 1 data with extra spaces, tabs, Arabic, collisions after normalisation, and rows that cannot be kept.
create table public.time_attack_scores (
  id bigint generated always as identity primary key, run_id uuid not null unique,
  name text not null, score integer not null, created_at timestamptz not null default now());
insert into public.time_attack_scores (run_id, name, score, created_at) values
  (gen_random_uuid(), '  Ali  ', 120, '2026-01-01'),
  (gen_random_uuid(), 'Ali', 150, '2026-01-02'),
  (gen_random_uuid(), 'ali', 150, '2026-01-03'),
  (gen_random_uuid(), E'\tSara   Khan ', 90, '2026-01-04'),
  (gen_random_uuid(), E'Tab\tName', 70, '2026-01-05'),
  (gen_random_uuid(), 'واسيم', 200, '2026-01-06'),
  (gen_random_uuid(), '  واسيم   ', 200, '2026-01-07'),
  (gen_random_uuid(), '   ', 10, '2026-01-08'),
  (gen_random_uuid(), '<b>x</b>', 10, '2026-01-09'),
  (gen_random_uuid(), 'a very long legacy name', 10, '2026-01-10'),
  (gen_random_uuid(), 'Over Cap', 1500, '2026-01-11'),
  (gen_random_uuid(), 'Ali', 151, '2026-01-12');

\i ../../supabase/leaderboard.sql

-- expected: 4 players. Ali keeps the highest score (151, the 12th row). Sara Khan and Tab Name are normalised.
-- The Arabic name keeps the earlier row on a tie (200 on 6 January, not 7 January). Rows that cannot be kept stay
-- in the legacy table.
do $$
begin
  assert (select count(*) from players) = 4, 'expected 4 players';
  assert (select best_score = 151 and to_char(best_at, 'YYYY-MM-DD') = '2026-01-12' from players where name = 'Ali'),
    'Ali keeps the highest score and its time';
  assert (select best_score = 90 from players where name = 'Sara Khan'), 'Sara Khan normalised to one space';
  assert (select best_score = 70 from players where name = 'Tab Name'), 'a tab inside a name becomes one space';
  assert (select best_score = 200 and to_char(best_at, 'YYYY-MM-DD') = '2026-01-06' from players where name = 'واسيم'),
    'Arabic: the earlier row wins a tie, and the spelling is kept';
  assert (select count(*) from players where name <> btrim(name) or name ~ '  ' or name ~ '\s\s') = 0,
    'no stored name has outer or doubled spaces';
  assert (select count(*) from time_attack_scores_legacy) = 12, 'no legacy row was deleted';
  assert to_regclass('public.time_attack_scores') is null, 'the old name is gone';
  raise notice 'ok: migration keeps the policy (names, ties, Arabic, skipped rows)';
end $$;

-- Re-running changes nothing.
\i ../../supabase/leaderboard.sql
do $$
begin
  assert (select count(*) from players) = 4, 're-run added players';
  assert (select count(*) from time_attack_scores_legacy) = 12, 're-run changed the legacy rows';
  raise notice 'ok: re-running after the migration changes nothing';
end $$;

-- Registration uses the same normalisation: a name that differs only in spaces, tabs or case is taken.
do $$
declare r jsonb;
begin
  r := register_player(E'\t  tab   NAME ', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert r->>'status' = 'taken', 'register: a name that differs only in spaces, tabs or case is taken';
  r := register_player(E'\tNew   Player\t', 'cccccccccccccccccccccccccccccccc');
  assert r->>'status' = 'ok' and r->>'name' = 'New Player', 'register: the name is stored normalised';
  r := register_player('   ', 'dddddddddddddddddddddddddddddddd');
  assert r->>'status' = 'invalid', 'register: an empty name is refused';
  raise notice 'ok: registration normalises names the same way the migration does';
end $$;
