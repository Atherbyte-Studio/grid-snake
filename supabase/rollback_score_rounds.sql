-- Undoes score_rounds.sql (part A) and score_rounds_finalize.sql (part B), and nothing else.
--   * gs_submit_best is callable by the Worker again (as before part B);
--   * gs_start_round and gs_submit_round go (they hold no data);
--   * the rounds table moves, with every row, to the private schema gs_rolledback (it is not dropped).
-- Players, names, scores, best times, recovery codes, account links and saves are not touched.
-- Publish the previous Worker and game page first: the new ones need the round functions.
-- It stops with an error, changing nothing, unless part A is applied and no earlier rollback of it is kept.
begin;

do $$
begin
  if to_regclass('public.player_rounds') is null then
    raise exception 'STOP: public.player_rounds not found (score_rounds.sql is not applied). Nothing was changed.';
  end if;
  if to_regclass('gs_rolledback.player_rounds') is not null then
    raise exception 'STOP: gs_rolledback.player_rounds exists (an earlier rollback). Rename it first. Nothing was changed.';
  end if;
  if to_regprocedure('public.gs_submit_best(uuid, integer, boolean, boolean, text)') is null then
    raise exception 'STOP: gs_submit_best not found (account_link.sql is not applied as expected). Nothing was changed.';
  end if;
end $$;

grant execute on function public.gs_submit_best(uuid, integer, boolean, boolean, text) to service_role;
drop function if exists public.gs_start_round(uuid);
drop function if exists public.gs_submit_round(uuid, uuid, integer, boolean, boolean, text);

create schema if not exists gs_rolledback;
revoke all on schema gs_rolledback from public, anon, authenticated;
alter table public.player_rounds set schema gs_rolledback;

commit;
