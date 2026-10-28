-- Checks for account_link.sql and rollback_account_link.sql. Run on a scratch database (pglite-run.mjs or psql).
-- The point of every check: existing players keep their id, name, code, score and rank, whatever happens.
\set ON_ERROR_STOP on
create or replace function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAILED: %', label; end if;
  raise notice 'ok: %', label;
end $$;
create or replace function pg_temp.runs_as(r text, q text) returns boolean language plpgsql as $$
begin
  execute format('set local role %I', r);
  execute q;
  return true;
exception when insufficient_privilege then
  return false;
end $$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;

-- Supabase's auth.users, reduced to its id
create schema auth;
create table auth.users (id uuid primary key);
insert into auth.users values ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333');

-- a version 1 project with one legacy name, upgraded to version 2, then real players with codes and scores
create table public.time_attack_scores (
  id bigint generated always as identity primary key, run_id uuid not null unique,
  name text not null, score integer not null, created_at timestamptz not null default now());
insert into public.time_attack_scores (run_id, name, score, created_at) values (gen_random_uuid(), 'Legacy', 40, '2026-01-01');
\i ../../supabase/leaderboard.sql
\set BENZ 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
\set MESSI 'cccccccccccccccccccccccccccccccc'
\set NOBODY 'dddddddddddddddddddddddddddddddd'
\set RONALDO '11111111-1111-4111-8111-111111111111'
\set NEYMAR '22222222-2222-4222-8222-222222222222'
\set ZIDANE '33333333-3333-4333-8333-333333333333'
select register_player('Benzema', :'BENZ');
select register_player('Messi', :'MESSI');
select submit_best(:'BENZ', 300, true, true, 'hard');
select submit_best(:'MESSI', 500, true, true, 'hard');

create temporary table before_players as select id, name, secret_hash, best_score, best_at, created_at from public.players;
create temporary table before_top as select get_top(10) as top;
create temporary table before_privs as
  select r, f, has_function_privilege(r, f, 'execute') as can
  from unnest(array['anon', 'authenticated']) r,
       unnest(array['public.register_player(text, text)', 'public.submit_best(text, integer, boolean, boolean, text)',
                    'public.get_me(text)', 'public.get_top(integer)']) f;

-- 1. applying it changes no existing data, and running it twice is safe
\i ../../supabase/account_link.sql
\i ../../supabase/account_link.sql
select pg_temp.check('apply: same players, same ids, names, codes and scores',
  (select count(*) = (select count(*) from before_players) from public.players p join before_players b using (id)
    where p.name = b.name and p.secret_hash is not distinct from b.secret_hash and p.best_score is not distinct from b.best_score
      and p.best_at is not distinct from b.best_at and p.created_at = b.created_at)
  and (select count(*) from public.players) = (select count(*) from before_players));
select pg_temp.check('apply: nobody is linked yet', (select count(*) = 0 from public.players where account_id is not null or linked_at is not null));
select pg_temp.check('apply: the board is unchanged', (select get_top(10) = (select top from before_top)));
select pg_temp.check('apply: game function privileges unchanged',
  (select bool_and(has_function_privilege(r, f, 'execute') = can) from before_privs));

-- 2. only the Worker can use the new functions and tables
select pg_temp.check('privileges: browsers cannot call gs_ functions',
  not exists (select 1 from unnest(array['anon', 'authenticated']) r,
    unnest(array['public.gs_link_player(uuid, text)', 'public.gs_account_player(uuid)', 'public.gs_save(uuid, jsonb, integer)',
                 'public.gs_submit_best(uuid, integer, boolean, boolean, text)']) f
    where has_function_privilege(r, f, 'execute')));
select pg_temp.check('privileges: service_role can call gs_ functions',
  (select bool_and(has_function_privilege('service_role', f, 'execute')) from
    unnest(array['public.gs_link_player(uuid, text)', 'public.gs_account_player(uuid)', 'public.gs_save(uuid, jsonb, integer)',
                 'public.gs_submit_best(uuid, integer, boolean, boolean, text)']) f));
select pg_temp.check('privileges: browsers cannot read or write the new tables',
  not exists (select 1 from unnest(array['anon', 'authenticated']) r,
    unnest(array['public.player_saves', 'public.player_save_history', 'public.player_link_log']) t
    where has_table_privilege(r, t, 'SELECT, INSERT, UPDATE, DELETE')));
select pg_temp.check('privileges: anon is refused when it tries', not pg_temp.runs_as('anon', format('select gs_link_player(%L, %L)', :'RONALDO', :'BENZ')));

-- 3. linking needs the right code, and changes nothing but the link
select pg_temp.check('link: bad input is invalid', (select gs_link_player(:'RONALDO', 'BENZ')->>'status' = 'invalid')
  and (select gs_link_player(null, :'BENZ')->>'status' = 'invalid'));
select pg_temp.check('link: a code nobody has is unknown', (select gs_link_player(:'RONALDO', :'NOBODY')->>'status' = 'unknown-player'));
select pg_temp.check('link: an account that does not exist is refused',
  (select gs_link_player('44444444-4444-4444-8444-444444444444', :'BENZ')->>'status' = 'unknown-account')
  and (select account_id is null from public.players where name = 'Benzema'));
select pg_temp.check('link: Benzema to ronaldo', (select gs_link_player(:'RONALDO', :'BENZ')->>'status' = 'linked'));
select pg_temp.check('link: id, name, code, score and date kept',
  (select p.account_id = :'RONALDO'::uuid and p.linked_at is not null and p.name = b.name and p.secret_hash = b.secret_hash
          and p.best_score = b.best_score and p.best_at = b.best_at and p.created_at = b.created_at
   from public.players p join before_players b using (id) where b.name = 'Benzema'));
select pg_temp.check('link: the board is unchanged', (select get_top(10) = (select top from before_top)));
select pg_temp.check('link: the recovery code still works', (select get_me(:'BENZ')->>'name' = 'Benzema'));
select pg_temp.check('link: again with the same account is fine', (select gs_link_player(:'RONALDO', :'BENZ')->>'status' = 'already-linked'));
select pg_temp.check('link: the same player cannot move to another account',
  (select gs_link_player(:'NEYMAR', :'BENZ')->>'status' = 'player-linked-elsewhere')
  and (select account_id = :'RONALDO'::uuid from public.players where name = 'Benzema'));
select pg_temp.check('link: an account cannot take a second player',
  (select gs_link_player(:'RONALDO', :'MESSI')->>'status' = 'account-has-player')
  and (select account_id is null from public.players where name = 'Messi'));
select pg_temp.check('link: an unclaimed legacy name has no code, so no code reaches it',
  (select secret_hash is null and account_id is null from public.players where name = 'Legacy')
  and not exists (select 1 from public.players where secret_hash is null and account_id is not null));
select pg_temp.check('link: every attempt is logged without codes',
  (select count(*) >= 4 from public.player_link_log)
  and not exists (select 1 from information_schema.columns where table_name = 'player_link_log' and column_name ilike '%secret%'));

-- 4. reading the account's player never exposes the id or the code
select pg_temp.check('read: name, best and rank', (select (r->>'status') = 'ok' and r->>'name' = 'Benzema' and (r->>'best')::int = 300
  and (r->>'rank')::int = 2 and r->'save' = 'null'::jsonb from gs_account_player(:'RONALDO') r));
select pg_temp.check('read: no id, code or hash in the answer',
  (select not (r ? 'id') and not (r ? 'secret_hash') and r::text not like '%' || :'BENZ' || '%' from gs_account_player(:'RONALDO') r));
select pg_temp.check('read: an account without a player', (select gs_account_player(:'ZIDANE')->>'status' = 'no-player'));

-- 5. saves: versioned, a stale device never overwrites a newer save, the replaced copy is kept
select pg_temp.check('save: first save is version 1', (select gs_save(:'RONALDO', '{"v":2,"data":{"coins":120}}', null)->>'version' = '1'));
select pg_temp.check('save: a second "first save" is a conflict', (select r->>'status' = 'conflict' and r->>'version' = '1'
  from gs_save(:'RONALDO', '{"v":2,"data":{"coins":5}}', null) r));
select pg_temp.check('save: on top of version 1 gives version 2', (select gs_save(:'RONALDO', '{"v":2,"data":{"coins":150}}', 1)->>'version' = '2'));
select pg_temp.check('save: a device still on version 1 is refused and nothing changes',
  (select gs_save(:'RONALDO', '{"v":2,"data":{"coins":0}}', 1)->>'status' = 'conflict')
  and (select data->'data'->>'coins' = '150' and version = 2 from public.player_saves));
select pg_temp.check('save: the replaced copy is kept', (select count(*) = 1 and min(data->'data'->>'coins') = '120' from public.player_save_history));
select pg_temp.check('save: not an object, or too big, is refused',
  (select gs_save(:'RONALDO', '[1]', 2)->>'status' = 'invalid')
  and (select gs_save(:'RONALDO', jsonb_build_object('x', repeat('a', 17000)), 2)->>'status' = 'invalid'));
select pg_temp.check('save: an account without a player cannot save', (select gs_save(:'ZIDANE', '{}', null)->>'status' = 'no-player'));
select pg_temp.check('save: read back', (select r->'save'->>'version' = '2' and r->'save'->'data'->'data'->>'coins' = '150' from gs_account_player(:'RONALDO') r));
do $$ begin for i in 3..30 loop perform gs_save('11111111-1111-4111-8111-111111111111', jsonb_build_object('n', i), i - 1); end loop; end $$;
select pg_temp.check('save: history keeps the 20 most recent copies', (select count(*) = 20 from public.player_save_history));

-- 6. scores through the account follow the same rules as submit_best
select pg_temp.check('score: not ranked is refused', (select gs_submit_best(:'RONALDO', 400, false, true, 'hard')->>'status' = 'invalid'));
select pg_temp.check('score: out of range is refused', (select gs_submit_best(:'RONALDO', 1001, true, true, 'hard')->>'status' = 'invalid'));
select pg_temp.check('score: lower keeps the best and its date', (select r->>'status' = 'kept' and (r->>'best')::int = 300 from gs_submit_best(:'RONALDO', 200, true, true, 'hard') r)
  and (select best_at = (select best_at from before_players where name = 'Benzema') from public.players where name = 'Benzema'));
select pg_temp.check('score: higher raises the best', (select r->>'status' = 'improved' and (r->>'best')::int = 600 and (r->>'rank')::int = 1
  from gs_submit_best(:'RONALDO', 600, true, true, 'hard') r));
-- a separate statement: a query only sees what earlier statements wrote
select pg_temp.check('score: on the same player row', (select id = (select id from before_players where name = 'Benzema') and best_score = 600
  from public.players where account_id = :'RONALDO'::uuid));
select pg_temp.check('score: an account without a player', (select gs_submit_best(:'ZIDANE', 10, true, true, 'hard')->>'status' = 'no-player'));
select pg_temp.check('score: other players untouched', (select best_score = 500 from public.players where name = 'Messi'));

-- 7. deleting an account unlinks the player and keeps everything else
insert into auth.users values ('55555555-5555-4555-8555-555555555555');
select gs_link_player('55555555-5555-4555-8555-555555555555', :'MESSI');
delete from auth.users where id = '55555555-5555-4555-8555-555555555555';
select pg_temp.check('account deleted: player kept, unlinked, score kept',
  (select account_id is null and best_score = 500 from public.players where name = 'Messi'));
select gs_link_player(:'NEYMAR', :'MESSI');

-- 7b. the Atherbyte username becomes the name (account_name.sql): same row, old name kept in the history
create table public.profiles (id uuid primary key references auth.users (id) on delete cascade, username text not null unique);
insert into auth.users values ('88888888-8888-4888-8888-888888888888'), ('99999999-9999-4999-8999-999999999999');
insert into public.profiles values (:'RONALDO', 'ronaldo'), (:'NEYMAR', 'neymar'), ('88888888-8888-4888-8888-888888888888', 'newbie'),
  ('99999999-9999-4999-8999-999999999999', 'messi');
\i ../../supabase/account_name.sql
\i ../../supabase/account_name.sql
create temporary table before_rename as select id, best_score, best_at, secret_hash, account_id from public.players where account_id = :'RONALDO'::uuid;
select pg_temp.check('name: browsers cannot call it', not has_function_privilege('anon', 'public.gs_use_account_name(uuid, boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.gs_use_account_name(uuid, boolean)', 'execute')
  and has_function_privilege('service_role', 'public.gs_use_account_name(uuid, boolean)', 'execute'));
select pg_temp.check('name: Benzema becomes ronaldo', (select r->>'status' = 'ok' and r->>'name' = 'ronaldo' and (r->>'renamed')::boolean from gs_use_account_name(:'RONALDO', false) r));
select pg_temp.check('name: same id, score, date, code and link', (select p.id = b.id and p.best_score = b.best_score and p.best_at = b.best_at
  and p.secret_hash = b.secret_hash and p.account_id = b.account_id and p.name = 'ronaldo' from public.players p join before_rename b using (id)));
select pg_temp.check('name: the old name is kept in the history', (select old_name = 'Benzema' and new_name = 'ronaldo' from public.player_name_history));
select pg_temp.check('name: the recovery code still finds the player', (select get_me(:'BENZ')->>'name' = 'ronaldo'));
select pg_temp.check('name: again changes nothing', (select (r->>'renamed')::boolean = false from gs_use_account_name(:'RONALDO', false) r)
  and (select count(*) = 1 from public.player_name_history));
select pg_temp.check('name: no player and no create', (select gs_use_account_name('88888888-8888-4888-8888-888888888888', false)->>'status' = 'no-player')
  and not exists (select 1 from public.players where account_id = '88888888-8888-4888-8888-888888888888'));
select pg_temp.check('name: create makes a linked player named after the account, without a code',
  (select gs_use_account_name('88888888-8888-4888-8888-888888888888', true)->>'status' = 'created'));
select pg_temp.check('name: the new player', (select name = 'newbie' and secret_hash is null and best_score is null and linked_at is not null
  from public.players where account_id = '88888888-8888-4888-8888-888888888888'));
select pg_temp.check('name: create again does not make a second player', (select gs_use_account_name('88888888-8888-4888-8888-888888888888', true)->>'status' = 'ok')
  and (select count(*) = 1 from public.players where account_id = '88888888-8888-4888-8888-888888888888'));
select pg_temp.check('name: a name used by another player is refused for a new player', (select gs_use_account_name('99999999-9999-4999-8999-999999999999', true)->>'status' = 'name-taken')
  and (select best_score = 500 from public.players where name = 'Messi')
  and not exists (select 1 from public.players where account_id = '99999999-9999-4999-8999-999999999999'));
select pg_temp.check('name: no profile, no name', (select gs_use_account_name(:'ZIDANE', true)->>'status' = 'no-profile'));

-- 8. rollback: every player stays, links are copied out, tables move aside, and the file can be applied again
create temporary table before_rollback as select id, name, secret_hash, best_score, best_at, created_at from public.players;
\i ../../supabase/rollback_account_link.sql
select pg_temp.check('rollback: players columns are back to version 2',
  (select array_agg(column_name::text order by column_name::text) from information_schema.columns where table_schema = 'public' and table_name = 'players')
  = array['best_at', 'best_score', 'created_at', 'id', 'name', 'secret_hash']);
select pg_temp.check('rollback: every player, id, code and score kept',
  (select count(*) = (select count(*) from before_rollback) from public.players p join before_rollback b using (id)
    where p.name = b.name and p.secret_hash is not distinct from b.secret_hash and p.best_score is not distinct from b.best_score
      and p.best_at is not distinct from b.best_at));
select pg_temp.check('rollback: links copied out', (select count(*) = 3 from gs_rolledback.players_account_link where account_id is not null));
select pg_temp.check('rollback: the name history is kept aside', (select count(*) = 1 from gs_rolledback.player_name_history));
select pg_temp.check('rollback: saves kept aside', (select count(*) = 1 from gs_rolledback.player_saves) and (select count(*) = 20 from gs_rolledback.player_save_history));
select pg_temp.check('rollback: functions gone', to_regprocedure('public.gs_link_player(uuid, text)') is null);
select pg_temp.check('rollback: the recovery code still works', (select get_me(:'BENZ')->>'name' = 'ronaldo'));
\i ../../supabase/account_link.sql
select pg_temp.check('reapply: works after a rollback, starting unlinked',
  (select count(*) = 0 from public.players where account_id is not null) and (select count(*) = 0 from public.player_saves));
select pg_temp.check('reapply: linking works again', (select gs_link_player(:'RONALDO', :'BENZ')->>'status' = 'linked'));
