-- Grid Snake: link a player to an Atherbyte account (version 2 + account link).
--
-- What it adds, and nothing else:
--   * players.account_id and players.linked_at. Every existing column, row, name, score and id stays as it is.
--   * player_saves: one copy of a linked player's device progress (coins, shop items, achievements, settings, local bests),
--     with a version number so one device can never silently overwrite another.
--   * player_save_history: the copy each save replaced (the 20 most recent per player).
--   * player_link_log: every link attempt and its outcome (no codes, no names).
--   * gs_* functions for the Atherbyte API (the Worker) ONLY. Browsers (anon, authenticated) cannot call them. The Worker
--     passes the account id it read from a verified Atherbyte session; a browser never chooses it.
--
-- Linking needs BOTH a valid Atherbyte session (checked by the Worker) and the player's recovery code (checked here).
-- A name is never enough. Unclaimed legacy names have no recovery code, so they cannot be linked by anyone.
-- One account has at most one player, and a linked player cannot be moved to another account.
--
-- It does not change register_player, submit_best, get_me, get_top or their privileges.
-- Re-running it is safe. Undo it with rollback_account_link.sql (nothing is deleted).
begin;

do $$
begin
  if to_regclass('public.players') is null then
    raise exception 'STOP: public.players not found. Run leaderboard.sql first. Nothing was changed.';
  end if;
  if to_regclass('auth.users') is null then
    raise exception 'STOP: auth.users not found (this file is for a Supabase project). Nothing was changed.';
  end if;
end $$;

-- ---------------------------------------------------------------- the link
-- Deleting an account unlinks its player; the player, the name and the score stay.
alter table public.players add column if not exists account_id uuid references auth.users (id) on delete set null;
alter table public.players add column if not exists linked_at timestamptz;
-- one player per account
create unique index if not exists players_account on public.players (account_id) where account_id is not null;

-- ---------------------------------------------------------------- the saved progress
create table if not exists public.player_saves (
  player_id uuid primary key references public.players (id) on delete restrict,
  version   integer not null check (version >= 1),
  data      jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 16384),
  saved_at  timestamptz not null default now()
);
create table if not exists public.player_save_history (
  id          bigint generated always as identity primary key,
  player_id   uuid not null references public.players (id) on delete restrict,
  version     integer not null,
  data        jsonb not null,
  saved_at    timestamptz not null,
  replaced_at timestamptz not null default now()
);
create index if not exists player_save_history_player on public.player_save_history (player_id, id desc);
create table if not exists public.player_link_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  account_id uuid not null,
  player_id  uuid,
  outcome    text not null
);

-- no policies on purpose: only the functions below read or write these tables
alter table public.player_saves enable row level security;
alter table public.player_save_history enable row level security;
alter table public.player_link_log enable row level security;
revoke all on public.player_saves, public.player_save_history, public.player_link_log from public, anon, authenticated;

-- ---------------------------------------------------------------- functions for the Worker
-- Link the player that owns p_secret to the account p_account.
create or replace function public.gs_link_player(p_account uuid, p_secret text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.players;
begin
  if p_account is null or p_secret is null or p_secret !~ '^[0-9a-f]{32}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  -- the row is locked until the end, so two links of the same player cannot both pass the checks
  select * into v_row from public.players where secret_hash = public.secret_hash_of(p_secret) for update;
  if not found then
    insert into public.player_link_log (account_id, player_id, outcome) values (p_account, null, 'unknown-player');
    return jsonb_build_object('status', 'unknown-player');
  end if;
  if v_row.account_id = p_account then
    return jsonb_build_object('status', 'already-linked', 'name', v_row.name);
  end if;
  if v_row.account_id is not null then
    insert into public.player_link_log (account_id, player_id, outcome) values (p_account, v_row.id, 'player-linked-elsewhere');
    return jsonb_build_object('status', 'player-linked-elsewhere');
  end if;
  if exists (select 1 from public.players where account_id = p_account) then
    insert into public.player_link_log (account_id, player_id, outcome) values (p_account, v_row.id, 'account-has-player');
    return jsonb_build_object('status', 'account-has-player');
  end if;
  begin
    update public.players set account_id = p_account, linked_at = now() where id = v_row.id;
  exception
    when unique_violation then        -- the same account linked another player at the same moment
      insert into public.player_link_log (account_id, player_id, outcome) values (p_account, v_row.id, 'account-has-player');
      return jsonb_build_object('status', 'account-has-player');
    when foreign_key_violation then
      return jsonb_build_object('status', 'unknown-account');
  end;
  insert into public.player_link_log (account_id, player_id, outcome) values (p_account, v_row.id, 'linked');
  return jsonb_build_object('status', 'linked', 'name', v_row.name, 'best', v_row.best_score,
                            'rank', case when v_row.best_score is null then null else public.player_rank(v_row.id) end);
end $$;

-- The account's player and its saved progress. Never returns the id, the code or its hash.
create or replace function public.gs_account_player(p_account uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_row  public.players;
  v_save public.player_saves;
begin
  if p_account is null then return jsonb_build_object('status', 'invalid'); end if;
  select * into v_row from public.players where account_id = p_account;
  if not found then return jsonb_build_object('status', 'no-player'); end if;
  select * into v_save from public.player_saves where player_id = v_row.id;
  return jsonb_build_object('status', 'ok', 'name', v_row.name, 'best', v_row.best_score, 'linked_at', v_row.linked_at,
    'rank', case when v_row.best_score is null then null else public.player_rank(v_row.id) end,
    'save', case when v_save.player_id is null then null
                 else jsonb_build_object('version', v_save.version, 'data', v_save.data, 'saved_at', v_save.saved_at) end);
end $$;

-- Save the device's progress. p_base_version is the version this device last read (null: it has never read one).
-- If another device saved in between, nothing is written and the answer is 'conflict' with the current version.
create or replace function public.gs_save(p_account uuid, p_data jsonb, p_base_version integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pid  uuid;
  v_save public.player_saves;
begin
  if p_account is null or p_data is null or jsonb_typeof(p_data) <> 'object' or octet_length(p_data::text) > 16384 then
    return jsonb_build_object('status', 'invalid');
  end if;
  select id into v_pid from public.players where account_id = p_account;
  if not found then return jsonb_build_object('status', 'no-player'); end if;

  select * into v_save from public.player_saves where player_id = v_pid for update;
  if not found then
    if p_base_version is not null then return jsonb_build_object('status', 'conflict', 'version', null); end if;
    insert into public.player_saves (player_id, version, data) values (v_pid, 1, p_data) on conflict (player_id) do nothing;
    if not found then   -- another device made the first save at the same moment
      return jsonb_build_object('status', 'conflict', 'version', (select version from public.player_saves where player_id = v_pid));
    end if;
    return jsonb_build_object('status', 'saved', 'version', 1);
  end if;

  if p_base_version is distinct from v_save.version then
    return jsonb_build_object('status', 'conflict', 'version', v_save.version);
  end if;
  insert into public.player_save_history (player_id, version, data, saved_at) values (v_pid, v_save.version, v_save.data, v_save.saved_at);
  -- keep the 20 most recent replaced copies per player
  delete from public.player_save_history
   where player_id = v_pid and id not in (select id from public.player_save_history where player_id = v_pid order by id desc limit 20);
  update public.player_saves set version = v_save.version + 1, data = p_data, saved_at = now() where player_id = v_pid;
  return jsonb_build_object('status', 'saved', 'version', v_save.version + 1);
end $$;

-- A finished ranked Time Attack round from a signed-in, linked player. Same rules as submit_best.
create or replace function public.gs_submit_best(p_account uuid, p_score integer, p_walls boolean, p_golden boolean, p_difficulty text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.players;
begin
  if p_walls is distinct from true or p_golden is distinct from true or p_difficulty is distinct from 'hard' then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_account is null or p_score is null or p_score < 0 or p_score > 1000 then
    return jsonb_build_object('status', 'invalid');
  end if;
  update public.players
     set best_score = p_score, best_at = now()
   where account_id = p_account and (best_score is null or p_score > best_score)
   returning * into v_row;
  if found then
    return jsonb_build_object('status', 'improved', 'best', v_row.best_score, 'rank', public.player_rank(v_row.id));
  end if;
  select * into v_row from public.players where account_id = p_account;
  if not found then return jsonb_build_object('status', 'no-player'); end if;
  return jsonb_build_object('status', 'kept', 'best', v_row.best_score,
                            'rank', case when v_row.best_score is null then null else public.player_rank(v_row.id) end);
end $$;

-- Only the Worker (service_role) may call these.
revoke all on function public.gs_link_player(uuid, text), public.gs_account_player(uuid),
  public.gs_save(uuid, jsonb, integer), public.gs_submit_best(uuid, integer, boolean, boolean, text)
  from public, anon, authenticated;
grant execute on function public.gs_link_player(uuid, text), public.gs_account_player(uuid),
  public.gs_save(uuid, jsonb, integer), public.gs_submit_best(uuid, integer, boolean, boolean, text)
  to service_role;

commit;
