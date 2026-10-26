-- Grid Snake global board, version 2: permanent players and one personal best each.
-- Run once in Supabase: Dashboard > SQL Editor > New query > paste > Run.
-- Safe to re-run. It creates what is missing and never deletes data.
--
-- What it changes on an existing project (version 1 had one row per round in time_attack_scores):
--   1. Creates public.players (one row per player, unique name ignoring case, a hash of the recovery code).
--   2. Copies each name's best legacy score into players, as an UNCLAIMED record (no recovery code).
--      Unclaimed names are reserved: nobody can register them until the owner releases one (see README).
--   3. Renames time_attack_scores to time_attack_scores_legacy and removes all access to it. Nothing is
--      deleted, so old rows stay available for review. Drop the table yourself when you are sure.
--   4. Adds the functions the game calls. Browsers can no longer insert, update or delete rows directly.

begin;

-- ---------------------------------------------------------------- players
create table if not exists public.players (
  id          uuid primary key default gen_random_uuid(),
  name        text not null
              check (char_length(name) between 1 and 16)
              check (name !~ '[<>&"`\\\\[:cntrl:]]')
              check (name = btrim(name) and name !~ '  '),
  -- sha256 of the recovery code (lower-case hex). Null = unclaimed legacy name. The code itself is never stored.
  secret_hash text unique check (secret_hash is null or secret_hash ~ '^[0-9a-f]{64}$'),
  best_score  integer check (best_score is null or best_score between 0 and 1000),
  -- when the best was reached: the earlier one ranks first on a tie
  best_at     timestamptz,
  created_at  timestamptz not null default now(),
  constraint best_pair check ((best_score is null) = (best_at is null))
);

-- one name per player, ignoring letter case
create unique index if not exists players_name_ci on public.players (lower(name));

-- the board and the rank query both read this order
create index if not exists players_rank on public.players (best_score desc, best_at asc, id asc)
  where best_score is not null;

alter table public.players enable row level security;
-- no policies on purpose: nobody reads or writes the table directly; only the functions below do
revoke all on public.players from public, anon, authenticated;

-- ---------------------------------------------------------------- legacy migration (runs only once)
do $$
begin
  if to_regclass('public.time_attack_scores') is not null then
    insert into public.players (name, best_score, best_at)
    select distinct on (lower(t.name)) t.name, t.score, t.created_at
    from public.time_attack_scores t
    where not exists (select 1 from public.players p where lower(p.name) = lower(t.name))
    order by lower(t.name), t.score desc, t.created_at asc;

    alter table public.time_attack_scores rename to time_attack_scores_legacy;
    revoke all on public.time_attack_scores_legacy from public, anon, authenticated;
  end if;
end $$;

-- ---------------------------------------------------------------- helpers
create or replace function public.secret_hash_of(p_secret text)
returns text language sql immutable set search_path = pg_catalog, public as $$
  select encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
$$;

-- how many players rank above this one (1 = first). An index range scan, not a full download.
create or replace function public.player_rank(p_id uuid)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select 1 + count(*)::int
  from public.players o, public.players me
  where me.id = p_id and me.best_score is not null
    and o.best_score is not null
    and (o.best_score > me.best_score
         or (o.best_score = me.best_score
             and (o.best_at < me.best_at or (o.best_at = me.best_at and o.id < me.id))))
$$;

-- ---------------------------------------------------------------- functions the game calls
-- Register a name. The code is 32 hex characters; the server keeps only its hash.
create or replace function public.register_player(p_name text, p_secret text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_hash text;
  v_row  public.players;
  v_c    text;
begin
  if p_secret is null or p_secret !~ '^[0-9a-f]{32}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  v_hash := public.secret_hash_of(p_secret);

  select * into v_row from public.players where secret_hash = v_hash;
  if found then
    return jsonb_build_object('status', 'already-registered', 'name', v_row.name);
  end if;

  begin
    insert into public.players (name, secret_hash) values (v_name, v_hash) returning * into v_row;
  exception
    when unique_violation then
      get stacked diagnostics v_c = constraint_name;
      if v_c = 'players_name_ci' then return jsonb_build_object('status', 'taken'); end if;
      return jsonb_build_object('status', 'invalid');
    when check_violation then
      return jsonb_build_object('status', 'invalid');
  end;
  return jsonb_build_object('status', 'ok', 'name', v_row.name);
end $$;

-- Submit a finished ranked Time Attack round. The best only ever goes up, in one atomic UPDATE.
create or replace function public.submit_best(p_secret text, p_score integer, p_walls boolean, p_golden boolean, p_difficulty text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_hash text;
  v_row  public.players;
begin
  -- ranked rules: walls on, golden apple on, hard. Anything else is not a ranked round.
  if p_walls is distinct from true or p_golden is distinct from true or p_difficulty is distinct from 'hard' then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_score is null or p_score < 0 or p_score > 1000 then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_secret is null or p_secret !~ '^[0-9a-f]{32}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  v_hash := public.secret_hash_of(p_secret);

  -- the WHERE is re-checked after a concurrent update, so two submissions cannot lower the best
  update public.players
     set best_score = p_score, best_at = now()
   where secret_hash = v_hash and (best_score is null or p_score > best_score)
   returning * into v_row;

  if found then
    return jsonb_build_object('status', 'improved', 'best', v_row.best_score, 'rank', public.player_rank(v_row.id));
  end if;

  select * into v_row from public.players where secret_hash = v_hash;
  if not found then
    return jsonb_build_object('status', 'unknown-player');
  end if;
  return jsonb_build_object('status', 'kept', 'best', v_row.best_score, 'rank', public.player_rank(v_row.id));
end $$;

-- A player's own record: name, best and true rank. This is also how a recovery code is checked.
create or replace function public.get_me(p_secret text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.players;
begin
  if p_secret is null or p_secret !~ '^[0-9a-f]{32}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into v_row from public.players where secret_hash = public.secret_hash_of(p_secret);
  if not found then
    return jsonb_build_object('status', 'unknown-player');
  end if;
  return jsonb_build_object('status', 'ok', 'name', v_row.name, 'best', v_row.best_score,
                            'rank', case when v_row.best_score is null then null else public.player_rank(v_row.id) end);
end $$;

-- The top ten, best first, earlier achievement first on a tie. Names and scores only: no codes, no ids.
create or replace function public.get_top(p_limit integer default 10)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(to_jsonb(s) order by s.rank), '[]'::jsonb)
  from (
    select row_number() over (order by best_score desc, best_at asc, id asc) as rank,
           name, best_score as score, best_at as achieved_at
    from public.players
    where best_score is not null
    order by best_score desc, best_at asc, id asc
    limit least(greatest(coalesce(p_limit, 10), 1), 10)
  ) s
$$;

-- Only these functions are callable from the browser. Their own rules decide what they return.
revoke all on function public.secret_hash_of(text), public.player_rank(uuid) from public, anon, authenticated;
revoke all on function public.register_player(text, text), public.submit_best(text, integer, boolean, boolean, text),
  public.get_me(text), public.get_top(integer) from public;
grant execute on function public.register_player(text, text), public.submit_best(text, integer, boolean, boolean, text),
  public.get_me(text), public.get_top(integer) to anon, authenticated;

commit;
