-- Grid Snake wallet: coins and shop items are kept by the SERVER, so a browser cannot give itself either.
-- Needs account_link.sql, score_rounds.sql and score_replay.sql. Additive: no existing table, row or function changes.
-- Run this file, then wallet_catalog.sql (the shop's prices). Re-running either is safe.
--
-- What the server now owns, per player:
--   player_wallets   the coin balance and the shop items bought (nothing in a save or a request can set them)
--   wallet_ledger    every change, append only, once per (kind, ref): a repeated request can never pay twice
--
-- How coins are earned (all functions are callable only by the Worker, which has verified the signed-in account):
--   ranked    a Time Attack round the Worker REPLAYED: the coins are exactly the replayed score (gs_wallet_credit_ranked)
--   run       any other run: the player opened it with the server (gs_run_open); the claim pays at most
--             3 coins per second since it opened, never more than the score claimed, once, within 3 hours
--   achievement  a tier's reward, once per (chain, tier), from the Worker's own schedule (gs_wallet_claim_achievements)
--   Each source also has a 24 hour limit (below). What this cannot prove: that a human played, or that an achievement was
--   really earned (the game keeps those on the device). It limits how much can be taken, it does not make it zero.
-- How coins are spent: gs_wallet_buy reads the price from wallet_catalog, checks the balance and ownership and writes
--   both in one locked step. An item cannot be bought twice or without the coins.
-- Existing players: a wallet is created ONCE from the progress the server already holds for them (their saved copy; the
--   device's own copy only when none was saved yet), counted as at most import_budget coins in total (items at their
--   price plus coins). Players made after wallet_settings.launch_at start with nothing to import.
-- Undo with rollback_wallet.sql (it keeps the tables and every balance).
begin;

do $$
begin
  if to_regprocedure('public.gs_submit_replay(uuid, uuid, integer, integer)') is null
     or to_regclass('public.player_saves') is null then
    raise exception 'STOP: account_link.sql, score_rounds.sql and score_replay.sql must be applied first. Nothing was changed.';
  end if;
end $$;

create table if not exists public.wallet_settings (
  id            boolean primary key default true check (id),
  launch_at     timestamptz not null default now(),
  import_budget integer not null default 50000 check (import_budget >= 0)
);
insert into public.wallet_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.wallet_catalog (
  id    text primary key check (id ~ '^(skin|board):[a-z0-9]+$'),
  price integer not null check (price > 0)
);

create table if not exists public.player_wallets (
  player_id  uuid primary key references public.players (id) on delete restrict,
  coins      bigint not null default 0 check (coins >= 0),
  owned      jsonb not null default '{}'::jsonb check (jsonb_typeof(owned) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wallet_ledger (
  id        bigint generated always as identity primary key,
  player_id uuid not null references public.players (id) on delete restrict,
  kind      text not null check (kind in ('import', 'ranked', 'run', 'achievement', 'buy')),
  ref       text not null,
  delta     bigint not null,
  at        timestamptz not null default now(),
  unique (player_id, kind, ref)
);
create index if not exists wallet_ledger_recent on public.wallet_ledger (player_id, kind, at);

create table if not exists public.player_runs (
  id        uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players (id) on delete restrict,
  mode      text not null check (mode ~ '^[a-z]{3,12}$'),
  opened_at timestamptz not null default now(),
  status    text not null default 'open' check (status in ('open', 'used', 'abandoned', 'expired')),
  closed_at timestamptz,
  score     integer,
  coins     integer
);
create index if not exists player_runs_open on public.player_runs (player_id, opened_at) where status = 'open';

-- no policies on purpose: only the functions below read or write these tables
alter table public.wallet_settings enable row level security;
alter table public.wallet_catalog enable row level security;
alter table public.player_wallets enable row level security;
alter table public.wallet_ledger enable row level security;
alter table public.player_runs enable row level security;
revoke all on public.wallet_settings, public.wallet_catalog, public.player_wallets, public.wallet_ledger, public.player_runs
  from public, anon, authenticated;

-- ---------------------------------------------------------------- internal helpers (not callable by anyone but the owner)
create or replace function public.wallet_json(p_pid uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('coins', w.coins, 'owned', w.owned) from public.player_wallets w where w.player_id = p_pid
$$;

-- Coins already given by one source in the last 24 hours.
create or replace function public.wallet_day_total(p_pid uuid, p_kind text)
returns bigint language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(delta), 0)::bigint from public.wallet_ledger
   where player_id = p_pid and kind = p_kind and at > now() - interval '24 hours'
$$;

-- ---------------------------------------------------------------- functions for the Worker
-- The player's wallet, made the first time it is asked for. p_hint is the device's profile ({coins, owned}); it is used
-- only when this is an existing player with no saved copy on the server.
create or replace function public.gs_wallet_open(p_account uuid, p_hint jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pid     uuid;
  v_created timestamptz;
  v_set     public.wallet_settings;
  v_src     jsonb;
  v_coins   bigint := 0;
  v_spent   bigint := 0;
  v_owned   jsonb := '{}'::jsonb;
  r         record;
  a         record;
  i         integer;
begin
  if p_account is null then return jsonb_build_object('status', 'invalid'); end if;
  select id, created_at into v_pid, v_created from public.players where account_id = p_account for update;
  if not found then return jsonb_build_object('status', 'no-player'); end if;
  if exists (select 1 from public.player_wallets where player_id = v_pid) then
    return jsonb_build_object('status', 'ok') || public.wallet_json(v_pid);
  end if;
  select * into v_set from public.wallet_settings where id;
  if v_created >= v_set.launch_at then            -- a player made after the wallet existed: nothing to bring over
    insert into public.player_wallets (player_id) values (v_pid) on conflict do nothing;
    return jsonb_build_object('status', 'ok') || public.wallet_json(v_pid);
  end if;
  select s.data -> 'data' into v_src from public.player_saves s where s.player_id = v_pid;
  if v_src is null then v_src := p_hint; end if;
  if v_src is null or jsonb_typeof(v_src) <> 'object' then
    return jsonb_build_object('status', 'pending');   -- an existing player whose progress has not reached the server yet
  end if;
  if jsonb_typeof(v_src -> 'owned') = 'object' then
    for r in
      select c.id, c.price from public.wallet_catalog c
        join jsonb_each(v_src -> 'owned') o on o.key = c.id
       where o.value = 'true'::jsonb
       order by c.price, c.id
    loop
      if v_spent + r.price <= v_set.import_budget then
        v_spent := v_spent + r.price;
        v_owned := v_owned || jsonb_build_object(r.id, true);
      end if;
    end loop;
  end if;
  if jsonb_typeof(v_src -> 'coins') = 'number' and (v_src ->> 'coins')::numeric > 0 then
    v_coins := floor(least((v_src ->> 'coins')::numeric, greatest(v_set.import_budget - v_spent, 0)))::bigint;
  end if;
  insert into public.player_wallets (player_id, coins, owned) values (v_pid, v_coins, v_owned) on conflict do nothing;
  insert into public.wallet_ledger (player_id, kind, ref, delta) values (v_pid, 'import', 'coins', v_coins) on conflict do nothing;
  for r in select k as id from jsonb_object_keys(v_owned) k loop
    insert into public.wallet_ledger (player_id, kind, ref, delta) values (v_pid, 'import', 'item:' || r.id, 0) on conflict do nothing;
  end loop;
  -- The tiers already finished were paid into the coins brought over: they are marked paid (0 coins), so they never pay twice.
  if jsonb_typeof(v_src -> 'ach') = 'object' then
    for a in select key as chain, value as st from jsonb_each(v_src -> 'ach') loop
      if a.chain ~ '^[a-z]{2,16}$' and jsonb_typeof(a.st -> 'tier') = 'number' then
        for i in 1 .. least(greatest(floor((a.st ->> 'tier')::numeric), 0), 20)::int loop
          insert into public.wallet_ledger (player_id, kind, ref, delta) values (v_pid, 'achievement', a.chain || ':' || i, 0) on conflict do nothing;
        end loop;
      end if;
    end loop;
  end if;
  return jsonb_build_object('status', 'ok') || public.wallet_json(v_pid);
end $$;

-- Buy one shop item at its catalogue price.
create or replace function public.gs_wallet_buy(p_account uuid, p_item text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pid   uuid;
  v_price integer;
  v_w     public.player_wallets;
  v_open  jsonb;
begin
  if p_account is null or p_item is null then return jsonb_build_object('status', 'invalid'); end if;
  select price into v_price from public.wallet_catalog where id = p_item;
  if not found then return jsonb_build_object('status', 'unknown-item'); end if;
  v_open := public.gs_wallet_open(p_account, null);
  if v_open ->> 'status' <> 'ok' then return v_open; end if;
  select id into v_pid from public.players where account_id = p_account;
  select * into v_w from public.player_wallets where player_id = v_pid for update;
  if v_w.owned ? p_item then return jsonb_build_object('status', 'owned') || public.wallet_json(v_pid); end if;
  if v_w.coins < v_price then return jsonb_build_object('status', 'poor', 'price', v_price) || public.wallet_json(v_pid); end if;
  update public.player_wallets set coins = coins - v_price, owned = owned || jsonb_build_object(p_item, true), updated_at = now()
   where player_id = v_pid;
  insert into public.wallet_ledger (player_id, kind, ref, delta) values (v_pid, 'buy', p_item, -v_price);
  return jsonb_build_object('status', 'ok') || public.wallet_json(v_pid);
end $$;

-- Pay the replayed score of a ranked round that was counted. Once per round; at most 12000 ranked coins a day.
create or replace function public.gs_wallet_credit_ranked(p_account uuid, p_round uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c_day_cap constant bigint := 12000;
  v_pid   uuid;
  v_round public.player_rounds;
  v_open  jsonb;
  v_gain  bigint;
  v_done  integer;
begin
  if p_account is null or p_round is null then return jsonb_build_object('status', 'invalid'); end if;
  v_open := public.gs_wallet_open(p_account, null);
  if v_open ->> 'status' <> 'ok' then return v_open; end if;
  select id into v_pid from public.players where account_id = p_account;
  select * into v_round from public.player_rounds where id = p_round and player_id = v_pid;
  if not found then return jsonb_build_object('status', 'no-round'); end if;
  if v_round.status <> 'used' or v_round.score is null then return jsonb_build_object('status', 'not-counted'); end if;
  perform 1 from public.player_wallets where player_id = v_pid for update;
  v_gain := greatest(least(v_round.score, c_day_cap - public.wallet_day_total(v_pid, 'ranked')), 0);
  insert into public.wallet_ledger (player_id, kind, ref, delta) values (v_pid, 'ranked', p_round::text, v_gain)
    on conflict do nothing;
  get diagnostics v_done = row_count;
  if v_done = 0 then return jsonb_build_object('status', 'already', 'gained', 0) || public.wallet_json(v_pid); end if;
  update public.player_wallets set coins = coins + v_gain, updated_at = now() where player_id = v_pid;
  return jsonb_build_object('status', 'ok', 'gained', v_gain) || public.wallet_json(v_pid);
end $$;

-- A run that is not a ranked Time Attack round: the player opens it with the server when it starts...
create or replace function public.gs_run_open(p_account uuid, p_mode text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c_open_max constant int := 5;
  v_pid uuid;
  v_run public.player_runs;
begin
  if p_account is null or p_mode is null or p_mode !~ '^[a-z]{3,12}$' then return jsonb_build_object('status', 'invalid'); end if;
  select id into v_pid from public.players where account_id = p_account for update;
  if not found then return jsonb_build_object('status', 'no-player'); end if;
  update public.player_runs set status = 'abandoned', closed_at = now()
   where id in (select id from public.player_runs where player_id = v_pid and status = 'open'
                order by opened_at desc, id desc offset c_open_max - 1);
  insert into public.player_runs (player_id, mode) values (v_pid, p_mode) returning * into v_run;
  return jsonb_build_object('status', 'ok', 'run', v_run.id);
end $$;

-- ...and claims it when it ends. At most 3 coins a second since it opened, at most the score, once, and at most 6000
-- coins a day from runs of this kind.
create or replace function public.gs_run_claim(p_account uuid, p_run uuid, p_score integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c_rate    constant numeric := 3;
  c_day_cap constant bigint := 6000;
  c_max_age constant interval := interval '3 hours';
  v_pid     uuid;
  v_run     public.player_runs;
  v_open    jsonb;
  v_gain    bigint;
  v_elapsed numeric;
begin
  if p_account is null or p_run is null or p_score is null or p_score < 0 or p_score > 100000 then
    return jsonb_build_object('status', 'invalid');
  end if;
  v_open := public.gs_wallet_open(p_account, null);
  if v_open ->> 'status' <> 'ok' then return v_open; end if;
  select id into v_pid from public.players where account_id = p_account;
  select * into v_run from public.player_runs where id = p_run and player_id = v_pid for update;
  if not found then return jsonb_build_object('status', 'no-run'); end if;
  if v_run.status <> 'open' then return jsonb_build_object('status', 'run-closed'); end if;
  if now() - v_run.opened_at > c_max_age then
    update public.player_runs set status = 'expired', closed_at = now() where id = v_run.id;
    return jsonb_build_object('status', 'run-expired');
  end if;
  perform 1 from public.player_wallets where player_id = v_pid for update;
  v_elapsed := greatest(extract(epoch from (now() - v_run.opened_at)), 0);
  v_gain := least(p_score::bigint, floor(v_elapsed * c_rate)::bigint);
  v_gain := greatest(least(v_gain, c_day_cap - public.wallet_day_total(v_pid, 'run')), 0);
  update public.player_runs set status = 'used', closed_at = now(), score = p_score, coins = v_gain where id = v_run.id;
  insert into public.wallet_ledger (player_id, kind, ref, delta) values (v_pid, 'run', p_run::text, v_gain) on conflict do nothing;
  update public.player_wallets set coins = coins + v_gain, updated_at = now() where player_id = v_pid;
  return jsonb_build_object('status', 'ok', 'gained', v_gain) || public.wallet_json(v_pid);
end $$;

-- Achievement rewards: p_claims is [{ "c": chain, "t": tier, "r": reward }, ...] and the Worker has already replaced every
-- reward with its own schedule. Each (chain, tier) pays once; at most 3000 coins a day from this source.
create or replace function public.gs_wallet_claim_achievements(p_account uuid, p_claims jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c_day_cap constant bigint := 3000;
  v_pid   uuid;
  v_open  jsonb;
  v_total bigint;
  v_gain  bigint := 0;
  v_done  integer;
  e       jsonb;
begin
  if p_account is null or p_claims is null or jsonb_typeof(p_claims) <> 'array' or jsonb_array_length(p_claims) > 100 then
    return jsonb_build_object('status', 'invalid');
  end if;
  v_open := public.gs_wallet_open(p_account, null);
  if v_open ->> 'status' <> 'ok' then return v_open; end if;
  select id into v_pid from public.players where account_id = p_account;
  perform 1 from public.player_wallets where player_id = v_pid for update;
  v_total := public.wallet_day_total(v_pid, 'achievement');
  for e in select value from jsonb_array_elements(p_claims) loop
    if jsonb_typeof(e -> 'r') <> 'number' or (e ->> 'r')::numeric < 0 or (e ->> 'r')::numeric > 1000
       or coalesce(e ->> 'c', '') !~ '^[a-z]{2,16}$' or jsonb_typeof(e -> 't') <> 'number' or (e ->> 't') !~ '^[0-9]{1,2}$' then
      continue;
    end if;
    if v_total + v_gain + (e ->> 'r')::bigint > c_day_cap then continue; end if;
    insert into public.wallet_ledger (player_id, kind, ref, delta)
      values (v_pid, 'achievement', (e ->> 'c') || ':' || (e ->> 't'), (e ->> 'r')::bigint) on conflict do nothing;
    get diagnostics v_done = row_count;
    if v_done > 0 then v_gain := v_gain + (e ->> 'r')::bigint; end if;
  end loop;
  if v_gain > 0 then
    update public.player_wallets set coins = coins + v_gain, updated_at = now() where player_id = v_pid;
  end if;
  return jsonb_build_object('status', 'ok', 'gained', v_gain) || public.wallet_json(v_pid);
end $$;

-- Only the Worker (service_role) may call these.
revoke all on function public.wallet_json(uuid), public.wallet_day_total(uuid, text),
  public.gs_wallet_open(uuid, jsonb), public.gs_wallet_buy(uuid, text), public.gs_wallet_credit_ranked(uuid, uuid),
  public.gs_run_open(uuid, text), public.gs_run_claim(uuid, uuid, integer), public.gs_wallet_claim_achievements(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.gs_wallet_open(uuid, jsonb), public.gs_wallet_buy(uuid, text), public.gs_wallet_credit_ranked(uuid, uuid),
  public.gs_run_open(uuid, text), public.gs_run_claim(uuid, uuid, integer), public.gs_wallet_claim_achievements(uuid, jsonb)
  to service_role;

commit;
