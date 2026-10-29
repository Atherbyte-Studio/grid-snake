-- Grid Snake ranked rounds, PART B of 2: closes the unchecked score path for the Worker.
-- Apply ONLY after score_rounds.sql (part A), the Worker that sends scores with a round, and the game page that opens a
-- round per run are all live. Before that, the old Worker still calls gs_submit_best, and this would break its scores.
-- It changes one privilege and no data. Undo: rollback_score_rounds.sql grants it back.
begin;

do $$
begin
  if to_regprocedure('public.gs_submit_round(uuid, uuid, integer, boolean, boolean, text)') is null then
    raise exception 'STOP: score_rounds.sql (part A) is not applied. Nothing was changed.';
  end if;
end $$;

revoke execute on function public.gs_submit_best(uuid, integer, boolean, boolean, text) from service_role;

commit;
