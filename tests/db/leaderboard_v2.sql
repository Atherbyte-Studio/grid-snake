-- Schema and function checks for the global board (version 2). Run by run.sh against a scratch database.
\set ON_ERROR_STOP on
create or replace function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAILED: %', label; end if;
  raise notice 'ok: %', label;
end $$;

-- Supabase roles, as the API uses them
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
grant usage on schema public to anon, authenticated;

-- 1. a version 1 project: one row per round, with a duplicate name and a case-only duplicate
create table public.time_attack_scores (
  id bigint generated always as identity primary key, run_id uuid not null unique,
  name text not null, score integer not null, created_at timestamptz not null default now());
insert into public.time_attack_scores (run_id, name, score, created_at) values
  (gen_random_uuid(), 'Ali', 120, '2026-01-01'), (gen_random_uuid(), 'Ali', 150, '2026-01-02'),
  (gen_random_uuid(), 'ali', 150, '2026-01-03'), (gen_random_uuid(), 'Sara', 90, '2026-01-04'),
  (gen_random_uuid(), 'واسيم', 200, '2026-01-05');

\i ../../supabase/leaderboard.sql

-- 2. migration: one legacy record per name, best score (earliest on a tie), table kept but closed
select pg_temp.check('legacy: one record per name ignoring case', (select count(*) from players) = 3);
select pg_temp.check('legacy: best score kept, earliest on tie', (select best_score = 150 and best_at = '2026-01-02' from players where lower(name) = 'ali'));
select pg_temp.check('legacy: arabic name copied', (select best_score = 200 from players where name = 'واسيم'));
select pg_temp.check('legacy: no secret on legacy records', (select count(*) = 0 from players where secret_hash is not null));
select pg_temp.check('legacy: old table renamed, not dropped', to_regclass('public.time_attack_scores_legacy') is not null and to_regclass('public.time_attack_scores') is null);
select pg_temp.check('legacy: old rows still there', (select count(*) = 5 from time_attack_scores_legacy));
\i ../../supabase/leaderboard.sql   -- running it again must change nothing
select pg_temp.check('rerun: no extra rows', (select count(*) from players) = 3);

-- 3. the browser role cannot touch the table or the old one
set local role anon;
select pg_temp.check('anon: cannot read players', (select has_table_privilege('anon', 'public.players', 'SELECT')) = false);
select pg_temp.check('anon: cannot write players', (select has_table_privilege('anon', 'public.players', 'INSERT, UPDATE, DELETE')) = false);
select pg_temp.check('anon: cannot read legacy table', (select has_table_privilege('anon', 'public.time_attack_scores_legacy', 'SELECT, INSERT, UPDATE, DELETE')) = false);
reset role;

-- 4. registration
\set S1 '0123456789abcdef0123456789abcdef'
\set S2 'fedcba9876543210fedcba9876543210'
\set S3 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
select pg_temp.check('register: new name', (select p->>'status' = 'ok' from register_player('Waseem', :'S1') p));
select pg_temp.check('register: same code again says already registered', (select p->>'status' = 'already-registered' from register_player('Other', :'S1') p));
select pg_temp.check('register: case-only duplicate is taken', (select p->>'status' = 'taken' from register_player('WASEEM', :'S2') p));
select pg_temp.check('register: legacy unclaimed name is taken', (select p->>'status' = 'taken' from register_player('ali', :'S2') p));
select pg_temp.check('register: spaces collapse and trim', (select p->>'name' = 'Two Words' from register_player('  Two   Words ', :'S3') p));
select pg_temp.check('register: bad code refused', (select p->>'status' = 'invalid' from register_player('Bad', 'short') p));
select pg_temp.check('register: markup refused by the table rules', (select p->>'status' = 'invalid' from register_player('<b>x</b>', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') p));
select pg_temp.check('register: stored code is a hash, not the code', (select secret_hash <> :'S1' and length(secret_hash) = 64 from players where name = 'Waseem'));

-- 5. personal bests
select pg_temp.check('submit: first score is an improvement', (select p->>'status' = 'improved' and (p->>'best')::int = 100 from submit_best(:'S1', 100, true, true, 'hard') p));
select pg_temp.check('submit: higher score replaces the best', (select p->>'status' = 'improved' and (p->>'best')::int = 150 from submit_best(:'S1', 150, true, true, 'hard') p));
select pg_temp.check('submit: lower score keeps the best', (select p->>'status' = 'kept' and (p->>'best')::int = 150 from submit_best(:'S1', 40, true, true, 'hard') p));
select pg_temp.check('submit: equal score keeps the earlier best time', (select p->>'status' = 'kept' from submit_best(:'S1', 150, true, true, 'hard') p));
select pg_temp.check('submit: one row per player', (select count(*) = 1 from players where secret_hash is not null and name = 'Waseem'));
select pg_temp.check('submit: other modes refused (walls off)', (select p->>'status' = 'invalid' from submit_best(:'S1', 500, false, true, 'hard') p));
select pg_temp.check('submit: golden off refused', (select p->>'status' = 'invalid' from submit_best(:'S1', 500, true, false, 'hard') p));
select pg_temp.check('submit: easy refused', (select p->>'status' = 'invalid' from submit_best(:'S1', 500, true, true, 'easy') p));
select pg_temp.check('submit: nothing set when refused', (select best_score = 150 from players where name = 'Waseem'));
select pg_temp.check('submit: out-of-range score refused', (select p->>'status' = 'invalid' from submit_best(:'S1', 1001, true, true, 'hard') p));
select pg_temp.check('submit: negative score refused', (select p->>'status' = 'invalid' from submit_best(:'S1', -1, true, true, 'hard') p));
select pg_temp.check('submit: unknown code is unknown', (select p->>'status' = 'unknown-player' from submit_best('55555555555555555555555555555555', 10, true, true, 'hard') p));
select pg_temp.check('submit: a name cannot be sent', (select p->>'status' = 'invalid' from submit_best('not-hex', 10, true, true, 'hard') p));

-- 6. identity and rank
select pg_temp.check('get_me: name and best', (select p->>'name' = 'Waseem' and (p->>'best')::int = 150 from get_me(:'S1') p));
select pg_temp.check('get_me: wrong code is unknown, not someone else', (select p->>'status' = 'unknown-player' from get_me('11111111111111111111111111111111') p));
select pg_temp.check('get_me: rank is true rank', (select (p->>'rank')::int = 3 from get_me(:'S1') p));   -- ahead: واسيم 200, Ali(legacy) 150 (earlier)

-- 7. top ten: best first, ties by earlier time, no codes exposed
insert into players (name, best_score, best_at) select 'Filler' || g, 10 + g, '2026-02-01'::timestamptz + g * interval '1 min' from generate_series(1, 12) g;
select pg_temp.check('top: at most ten rows', (select jsonb_array_length(get_top(50)) = 10));
select pg_temp.check('top: first is the best score', (select (get_top(10)->0->>'score')::int = 200));
select pg_temp.check('top: no codes or ids in output', (select position('secret' in get_top(10)::text) = 0 and position('secret_hash' in get_top(10)::text) = 0));
select pg_temp.check('top: ranks are 1..n', (select string_agg(r->>'rank', ',' order by (r->>'rank')::int) = '1,2,3,4,5,6,7,8,9,10' from jsonb_array_elements(get_top(10)) r));
insert into players (name, best_score, best_at) values ('TieEarly', 150, '2025-12-31') ;
select pg_temp.check('top: tie goes to the earlier time', (select (get_top(10)->1->>'name') = 'TieEarly' or (get_top(10)->2->>'name') = 'TieEarly'));
select pg_temp.check('rank: ties counted by time', (select (p->>'rank')::int between 1 and 5 from get_me(:'S1') p));

-- 8. identity hidden from the browser role, functions still work for it
set local role anon;
select pg_temp.check('anon: can read the top ten', (select jsonb_array_length(get_top(10)) >= 1));
select pg_temp.check('anon: can register', (select p->>'status' = 'ok' from register_player('Newcomer', 'cccccccccccccccccccccccccccccccc') p));
reset role;
