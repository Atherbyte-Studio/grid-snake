-- Grid Snake: ranked scores proven by replay (Option C), PART A2 of 2 (additive). Needs score_rounds.sql (part A).
--
-- Each round gets a random seed when it opens. The game builds the round from that seed and records what it fed the
-- engine (frame times, turns, pause, resume). The Worker replays that record with the same engine (a copy of
-- src/engine.js) and computes the score itself; only that score reaches the board, through gs_submit_replay.
--
-- This part only ADDS: a seed and a game time per round, three Worker-only functions, and the seed in gs_start_round's
-- answer (the Worker that is live ignores it). gs_submit_round stays as it is until score_replay_finalize.sql.
--   gs_round_seed(account, round)        the seed of the player's own open round (read only)
--   gs_submit_replay(account, round, score, game_ms)
--                                        counts a replayed score: the player's own open round, once, within 15 minutes,
--                                        and the replayed game time may not exceed the real time since the round opened
--                                        (+2.1 s). The time-based score filter of score_rounds.sql stays as well.
--   gs_reject_round(account, round)      closes the player's own open round when its record does not replay
--
-- What replay proves: the score is what the engine gives for that seed and those inputs. What it does not prove: who
-- or what produced the inputs (a program can play), or that frame times were real (a slowed-down game looks like a
-- paused one).
-- Undo with rollback_score_replay.sql (it keeps the rounds and their seeds).
begin;

do $$
begin
  if to_regprocedure('public.gs_submit_round(uuid, uuid, integer, boolean, boolean, text)') is null then
    raise exception 'STOP: score_rounds.sql (part A) is not applied. Nothing was changed.';
  end if;
end $$;

-- a 32-bit seed per round; rounds that already exist get one too (they are rounds only, never player data)
alter table public.player_rounds add column if not exists seed bigint not null
  default (('x' || substr(md5(gen_random_uuid()::text), 1, 8))::bit(32)::bigint);
alter table public.player_rounds add column if not exists game_ms integer
  check (game_ms is null or game_ms between 0 and 60000);

-- as in score_rounds.sql, the answer now carries the seed, and a player can have 5 open rounds (not 3): the game fetches
-- the next round ahead, so each open tab or device holds one waiting round besides the one being played
create or replace function public.gs_start_round(p_account uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c_open_max constant int := 5;
  v_pid   uuid;
  v_round public.player_rounds;
begin
  if p_account is null then return jsonb_build_object('status', 'invalid'); end if;
  select id into v_pid from public.players where account_id = p_account for update;
  if not found then return jsonb_build_object('status', 'no-player'); end if;
  update public.player_rounds set status = 'abandoned', closed_at = now()
   where id in (select id from public.player_rounds where player_id = v_pid and status = 'open'
                order by started_at desc, id desc offset c_open_max - 1);
  insert into public.player_rounds (player_id) values (v_pid) returning * into v_round;
  return jsonb_build_object('status', 'ok', 'round', v_round.id, 'seed', v_round.seed, 'started_at', v_round.started_at,
                            'expires_at', v_round.started_at + interval '15 minutes');
end $$;

create or replace function public.gs_round_seed(p_account uuid, p_round uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_pid   uuid;
  v_round public.player_rounds;
begin
  if p_account is null or p_round is null then return jsonb_build_object('status', 'invalid'); end if;
  select id into v_pid from public.players where account_id = p_account;
  if not found then return jsonb_build_object('status', 'no-player'); end if;
  select * into v_round from public.player_rounds where id = p_round and player_id = v_pid;
  if not found then return jsonb_build_object('status', 'no-round'); end if;
  if v_round.status <> 'open' then return jsonb_build_object('status', 'round-closed'); end if;
  if now() - v_round.started_at > interval '15 minutes' then return jsonb_build_object('status', 'round-expired'); end if;
  return jsonb_build_object('status', 'ok', 'seed', v_round.seed);
end $$;

create or replace function public.gs_submit_replay(p_account uuid, p_round uuid, p_score integer, p_game_ms integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c_max_age constant interval := interval '15 minutes';
  c_slack   constant numeric := 2;
  v_pid     uuid;
  v_round   public.player_rounds;
  v_elapsed numeric;
  v_row     public.players;
begin
  if p_account is null or p_round is null or p_score is null or p_score < 0 or p_score > 1000
     or p_game_ms is null or p_game_ms < 0 or p_game_ms > 60000 then
    return jsonb_build_object('status', 'invalid');
  end if;
  select id into v_pid from public.players where account_id = p_account;
  if not found then return jsonb_build_object('status', 'no-player'); end if;
  -- locked until the end: a second submission of the same round waits, then sees it closed
  select * into v_round from public.player_rounds where id = p_round and player_id = v_pid for update;
  if not found then return jsonb_build_object('status', 'no-round'); end if;
  if v_round.status <> 'open' then return jsonb_build_object('status', 'round-closed'); end if;
  if now() - v_round.started_at > c_max_age then
    update public.player_rounds set status = 'expired', closed_at = now() where id = v_round.id;
    return jsonb_build_object('status', 'round-expired');
  end if;
  v_elapsed := greatest(extract(epoch from (now() - v_round.started_at)), 0);
  -- the replayed game cannot have run longer than the real time since the round opened (no fast-forward)
  if p_game_ms > (v_elapsed + c_slack) * 1000 + 100
     or p_score > 5 * floor(least(60000, (v_elapsed + c_slack) * 1000 + 100) / 60) then
    update public.player_rounds set status = 'rejected', closed_at = now(), score = p_score, game_ms = p_game_ms where id = v_round.id;
    return jsonb_build_object('status', 'implausible');
  end if;
  update public.player_rounds set status = 'used', closed_at = now(), score = p_score, game_ms = p_game_ms where id = v_round.id;
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

create or replace function public.gs_reject_round(p_account uuid, p_round uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_pid uuid;
begin
  if p_account is null or p_round is null then return jsonb_build_object('status', 'invalid'); end if;
  select id into v_pid from public.players where account_id = p_account;
  if not found then return jsonb_build_object('status', 'no-player'); end if;
  update public.player_rounds set status = 'rejected', closed_at = now()
   where id = p_round and player_id = v_pid and status = 'open';
  return jsonb_build_object('status', case when found then 'closed' else 'no-round' end);
end $$;

revoke all on function public.gs_round_seed(uuid, uuid), public.gs_submit_replay(uuid, uuid, integer, integer),
  public.gs_reject_round(uuid, uuid) from public, anon, authenticated;
grant execute on function public.gs_round_seed(uuid, uuid), public.gs_submit_replay(uuid, uuid, integer, integer),
  public.gs_reject_round(uuid, uuid) to service_role;
-- gs_start_round keeps its privileges (create or replace does not change them); stated again for clarity
revoke all on function public.gs_start_round(uuid) from public, anon, authenticated;
grant execute on function public.gs_start_round(uuid) to service_role;

commit;
