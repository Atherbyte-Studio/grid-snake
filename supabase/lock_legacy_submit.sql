-- Grid Snake: closes the old direct score path.
-- submit_best(secret, score, ...) is callable by anyone with the public (anon) key. It trusts the score the caller sends
-- (any whole number 0 to 1000), so a visitor can put any score on the global board without playing. The ranked path
-- (gs_start_round, gs_submit_replay) is only callable by the Worker, which replays the run; this file closes the old one.
-- Apply ONLY when no game build still calls submit_best from the browser: the web page and the app must be the account-only
-- builds (src/web/account-link.js sends scores through the Worker). An older cached page or app build stops updating scores.
-- It changes privileges only, no data. Undo: rollback_lock_legacy_submit.sql.
-- It stops with an error, changing nothing, unless the replayed path (score_replay.sql) is applied.
begin;

do $$
begin
  if to_regprocedure('public.gs_submit_replay(uuid, uuid, integer, integer)') is null then
    raise exception 'STOP: score_replay.sql is not applied, so closing submit_best would leave no way to score. Nothing was changed.';
  end if;
end $$;

revoke all on function public.submit_best(text, integer, boolean, boolean, text) from public, anon, authenticated;

commit;
