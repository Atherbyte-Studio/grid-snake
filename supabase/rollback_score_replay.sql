-- Undoes score_replay.sql (part A2) and score_replay_finalize.sql (part B2), and nothing else:
--   * gs_submit_round is callable by the Worker again (rounds without replay, as before part A2);
--   * gs_round_seed, gs_submit_replay and gs_reject_round go (they hold no data);
--   * the seed and game_ms columns STAY on player_rounds (round data is never dropped), and gs_start_round keeps
--     answering the seed, which the earlier Worker ignores.
-- Players, scores, codes, links and saves are not touched. Redeploy the previous Worker first.
-- It stops with an error, changing nothing, unless part A2 is applied.
begin;

do $$
begin
  if to_regprocedure('public.gs_submit_replay(uuid, uuid, integer, integer)') is null then
    raise exception 'STOP: score_replay.sql (part A2) is not applied. Nothing was changed.';
  end if;
  if to_regprocedure('public.gs_submit_round(uuid, uuid, integer, boolean, boolean, text)') is null then
    raise exception 'STOP: gs_submit_round not found (score_rounds.sql is not applied as expected). Nothing was changed.';
  end if;
end $$;

grant execute on function public.gs_submit_round(uuid, uuid, integer, boolean, boolean, text) to service_role;
drop function if exists public.gs_round_seed(uuid, uuid);
drop function if exists public.gs_submit_replay(uuid, uuid, integer, integer);
drop function if exists public.gs_reject_round(uuid, uuid);

commit;
