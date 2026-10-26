-- Who may call what. Every check runs as the browser role (anon, or a signed-in authenticated user).
-- The game only needs four functions. Everything else must be refused for both roles.
create table public.time_attack_scores (
  id bigint generated always as identity primary key, run_id uuid not null unique,
  name text not null, score integer not null, created_at timestamptz not null default now());
insert into public.time_attack_scores (run_id, name, score) values (gen_random_uuid(), 'Legacy', 40);
\i ../../supabase/leaderboard.sql
insert into players (name, secret_hash, best_score, best_at) values ('Seed', null, 50, now());

-- Run a query as a role. Returns false when the role is refused, true when it runs.
create function pg_temp.runs_as(r text, q text) returns boolean language plpgsql as $$
begin
  execute format('set local role %I', r);
  execute q;
  return true;
exception when insufficient_privilege then
  return false;
end $$;

do $$
declare
  r text;
  calls_ok text[] := array[
    'select register_player(''Probe'', ''aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'')',
    'select submit_best(''aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'', 5, true, true, ''hard'')',
    'select get_me(''aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'')',
    'select get_top(10)'];
  q text;
  i int;
begin
  foreach r in array array['anon', 'authenticated'] loop
    -- the four game functions run
    foreach q in array calls_ok loop
      assert pg_temp.runs_as(r, q), format('%s cannot run %s', r, q);
    end loop;
    -- the internal ones are refused, by direct call
    assert not pg_temp.runs_as(r, 'select secret_hash_of(''aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'')'), format('%s can call secret_hash_of', r);
    assert not pg_temp.runs_as(r, 'select player_rank((select id from players limit 1))'), format('%s can call player_rank', r);
    assert not pg_temp.runs_as(r, 'select normalize_player_name(''  a  '')'), format('%s can call normalize_player_name', r);
    assert not pg_temp.runs_as(r, 'select player_name_ok(''Ali'')'), format('%s can call player_name_ok', r);
    -- the table is closed to both roles
    assert not pg_temp.runs_as(r, 'select count(*) from players'), format('%s can read players', r);
    assert not pg_temp.runs_as(r, 'update players set best_score = 999'), format('%s can update players', r);
    assert not pg_temp.runs_as(r, 'delete from players'), format('%s can delete players', r);
    assert not pg_temp.runs_as(r, 'select count(*) from time_attack_scores_legacy'), format('%s can read the legacy table', r);
    reset role;
  end loop;

  -- catalogue view of the same rules, so a later change to grants is noticed
  for i in 1..2 loop
    r := case i when 1 then 'anon' else 'authenticated' end;
    assert has_function_privilege(r, 'public.register_player(text, text)', 'EXECUTE'), r || ' lacks register_player';
    assert has_function_privilege(r, 'public.submit_best(text, integer, boolean, boolean, text)', 'EXECUTE'), r || ' lacks submit_best';
    assert has_function_privilege(r, 'public.get_me(text)', 'EXECUTE'), r || ' lacks get_me';
    assert has_function_privilege(r, 'public.get_top(integer)', 'EXECUTE'), r || ' lacks get_top';
    assert not has_function_privilege(r, 'public.secret_hash_of(text)', 'EXECUTE'), r || ' has secret_hash_of';
    assert not has_function_privilege(r, 'public.player_rank(uuid)', 'EXECUTE'), r || ' has player_rank';
    assert not has_function_privilege(r, 'public.normalize_player_name(text)', 'EXECUTE'), r || ' has normalize_player_name';
    assert not has_function_privilege(r, 'public.player_name_ok(text)', 'EXECUTE'), r || ' has player_name_ok';
  end loop;
  assert not has_function_privilege('public', 'public.secret_hash_of(text)', 'EXECUTE'), 'PUBLIC has secret_hash_of';
  assert not has_table_privilege('public', 'public.players', 'SELECT'), 'PUBLIC can read players';

  -- the four game functions run as the owner, with a fixed search path (no search_path tricks)
  assert (select bool_and(prosecdef) from pg_proc where proname in ('register_player', 'submit_best', 'get_me', 'get_top')
          and pronamespace = 'public'::regnamespace), 'a game function is not SECURITY DEFINER';
  assert (select bool_and(proconfig is not null) from pg_proc where proname in ('register_player', 'submit_best', 'get_me', 'get_top', 'player_rank')
          and pronamespace = 'public'::regnamespace), 'a definer function has no fixed search_path';
  raise notice 'ok: privileges as designed (anon and authenticated, direct calls, catalogue)';
end $$;
