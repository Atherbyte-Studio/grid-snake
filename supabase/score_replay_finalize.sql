-- Grid Snake replayed scores, PART B2 of 2: the Worker can no longer count a score without a replay.
-- Apply ONLY after score_replay.sql (part A2), the Worker that replays rounds, and the game page that records them are
-- all live. Before that, the live Worker still calls gs_submit_round and this would break its scores.
-- One privilege, no data. Undo: rollback_score_replay.sql grants it back.
begin;

do $$
begin
  if to_regprocedure('public.gs_submit_replay(uuid, uuid, integer, integer)') is null then
    raise exception 'STOP: score_replay.sql (part A2) is not applied. Nothing was changed.';
  end if;
end $$;

revoke execute on function public.gs_submit_round(uuid, uuid, integer, boolean, boolean, text) from service_role;

commit;
