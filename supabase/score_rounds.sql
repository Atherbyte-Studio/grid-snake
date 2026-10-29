-- Grid Snake ranked rounds, PART A of 2 (additive): a score must belong to a round the server opened.
-- Needs account_link.sql. Part B (score_rounds_finalize.sql) closes the old unchecked path; it is applied only after the
-- new Worker and the new game page are live. Undo with rollback_score_rounds.sql (never with rollback_account_link.sql).
--
-- This part only ADDS: the player_rounds table and two functions for the Worker. It changes no existing row, function
-- or privilege, so the Worker that is live now (which still calls gs_submit_best) keeps working after it.
--
--   gs_start_round(account)   opens a round for the account's player: a random id, the server's start time, 'open'.
--                             A player can have 3 open rounds; a 4th closes the oldest ('abandoned'). This lets a score
--                             waiting for a retry keep its own round while the player starts new runs.
--   gs_submit_round(account, round, score, ranked settings)
--                             counts the score only for that player's own open round, once, within 15 minutes, and only
--                             if the score is possible in the time that passed since the start. The round is closed
--                             whatever the answer (except malformed input), so it can never be tried with another number.
--
-- THE TIME LIMIT IS A PLAUSIBILITY FILTER, NOT ANTI-CHEAT. The server sees a start time and a number, not the moves.
-- A client that opens a round and waits can claim any score the time allows (999 after about 10 seconds).
-- Derivation (engine.js and the page loop; see supabase/README.md, "Ranked rounds"):
--   game time <= real time since start() + 100 ms     (the page passes dt = min(frame gap, 100); pause stops update())
--   game time <= 60 000 ms                            (Time Attack duration; update() clamps dt to the time left)
--   steps     <= game time / 60 ms                    (a step needs acc >= interval >= minInterval = 60)
--   points    <= 5 per step                           (randomFree keeps food, pick-up and golden apple on different cells,
--                                                      so one step collects one item: food 1 or 2, bonus 5, golden 5)
--   the server's elapsed time can be shorter than the play by the round request's head start over the score request:
--   2 s of slack is allowed for that.
--   allowed(E) = 5 * floor( min(60 000, (E + 2) * 1000 + 100) / 60 )      E = server seconds since the round opened
begin;

do $$
begin
  if to_regprocedure('public.gs_submit_best(uuid, integer, boolean, boolean, text)') is null then
    raise exception 'STOP: account_link.sql is not applied. Nothing was changed.';
  end if;
  if to_regclass('gs_rolledback.player_rounds') is not null and to_regclass('public.player_rounds') is null then
    raise notice 'An earlier rollback kept its rounds in gs_rolledback.player_rounds; they stay there.';
  end if;
end $$;

create table if not exists public.player_rounds (
  id         uuid primary key default gen_random_uuid(),
  player_id  uuid not null references public.players (id) on delete restrict,
  started_at timestamptz not null default now(),
  status     text not null default 'open' check (status in ('open', 'used', 'abandoned', 'expired', 'rejected')),
  closed_at  timestamptz,
  score      integer
);
create index if not exists player_rounds_open on public.player_rounds (player_id, started_at) where status = 'open';
alter table public.player_rounds enable row level security;
revoke all on public.player_rounds from public, anon, authenticated;

create or replace function public.gs_start_round(p_account uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c_open_max constant int := 3;
  v_pid   uuid;
  v_round public.player_rounds;
begin
  if p_account is null then return jsonb_build_object('status', 'invalid'); end if;
  -- the player row is locked: starts of the same player run one after the other, so the count below is exact
  select id into v_pid from public.players where account_id = p_account for update;
  if not found then return jsonb_build_object('status', 'no-player'); end if;
  update public.player_rounds set status = 'abandoned', closed_at = now()
   where id in (select id from public.player_rounds where player_id = v_pid and status = 'open'
                order by started_at desc, id desc offset c_open_max - 1);
  insert into public.player_rounds (player_id) values (v_pid) returning * into v_round;
  return jsonb_build_object('status', 'ok', 'round', v_round.id, 'started_at', v_round.started_at,
                            'expires_at', v_round.started_at + interval '15 minutes');
end $$;

create or replace function public.gs_submit_round(p_account uuid, p_round uuid, p_score integer, p_walls boolean, p_golden boolean, p_difficulty text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c_max_age constant interval := interval '15 minutes';
  c_slack   constant numeric := 2;          -- seconds: the round request's possible head start (see the header)
  v_pid     uuid;
  v_round   public.player_rounds;
  v_elapsed numeric;
  v_allowed integer;
  v_row     public.players;
begin
  if p_walls is distinct from true or p_golden is distinct from true or p_difficulty is distinct from 'hard' then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_account is null or p_round is null or p_score is null or p_score < 0 or p_score > 1000 then
    return jsonb_build_object('status', 'invalid');
  end if;
  select id into v_pid from public.players where account_id = p_account;
  if not found then return jsonb_build_object('status', 'no-player'); end if;

  -- the round row is locked until the end: a second submission of it waits, then sees it closed.
  -- Another player's round is answered exactly like a round that does not exist, and is left as it is.
  select * into v_round from public.player_rounds where id = p_round and player_id = v_pid for update;
  if not found then return jsonb_build_object('status', 'no-round'); end if;
  if v_round.status <> 'open' then return jsonb_build_object('status', 'round-closed'); end if;

  if now() - v_round.started_at > c_max_age then
    update public.player_rounds set status = 'expired', closed_at = now() where id = v_round.id;
    return jsonb_build_object('status', 'round-expired');
  end if;
  v_elapsed := greatest(extract(epoch from (now() - v_round.started_at)), 0);
  v_allowed := 5 * floor(least(60000, (v_elapsed + c_slack) * 1000 + 100) / 60);
  if p_score > v_allowed then
    update public.player_rounds set status = 'rejected', closed_at = now(), score = p_score where id = v_round.id;
    return jsonb_build_object('status', 'implausible');
  end if;
  update public.player_rounds set status = 'used', closed_at = now(), score = p_score where id = v_round.id;

  -- the best only ever goes up, in one atomic UPDATE (as in gs_submit_best)
  update public.players set best_score = p_score, best_at = now()
   where id = v_pid and (best_score is null or p_score > best_score)
   returning * into v_row;
  if found then
    return jsonb_build_object('status', 'improved', 'best', v_row.best_score, 'rank', public.player_rank(v_row.id));
  end if;
  select * into v_row from public.players where id = v_pid;
  return jsonb_build_object('status', 'kept', 'best', v_row.best_score,
                            'rank', case when v_row.best_score is null then null else public.player_rank(v_row.id) end);
end $$;

revoke all on function public.gs_start_round(uuid), public.gs_submit_round(uuid, uuid, integer, boolean, boolean, text)
  from public, anon, authenticated;
grant execute on function public.gs_start_round(uuid), public.gs_submit_round(uuid, uuid, integer, boolean, boolean, text)
  to service_role;

commit;
