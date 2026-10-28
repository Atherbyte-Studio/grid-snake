-- Undoes account_link.sql. NOTHING is deleted:
--   * every link (player id, account id, time) is copied to gs_rolledback.players_account_link first;
--   * the save tables move to the private schema gs_rolledback (with their indexes), they are not dropped;
--   * players keeps every row, id, name, recovery code hash and score. Only the two link columns go.
-- account_link.sql can be applied again afterwards; it starts with empty save tables.
-- It stops with an error, changing nothing, unless account_link.sql is applied and no earlier rollback is kept.
begin;

do $$
begin
  if to_regclass('public.players') is null
     or not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'players' and column_name = 'account_id') then
    raise exception 'STOP: public.players has no account_id (account_link.sql is not applied). Nothing was changed.';
  end if;
  if to_regclass('gs_rolledback.players_account_link') is not null or to_regclass('gs_rolledback.player_saves') is not null then
    raise exception 'STOP: an earlier rollback is kept in schema gs_rolledback. Check and rename it first. Nothing was changed.';
  end if;
end $$;

create schema if not exists gs_rolledback;
revoke all on schema gs_rolledback from public, anon, authenticated;

create table gs_rolledback.players_account_link as
  select id as player_id, account_id, linked_at from public.players where account_id is not null or linked_at is not null;

drop function if exists public.gs_link_player(uuid, text);
drop function if exists public.gs_account_player(uuid);
drop function if exists public.gs_save(uuid, jsonb, integer);
drop function if exists public.gs_submit_best(uuid, integer, boolean, boolean, text);
drop function if exists public.gs_use_account_name(uuid, boolean);   -- account_name.sql
-- Names stay as they are now; player_name_history (kept below) lists every change if one must be undone by hand.
-- A player created for an account (no recovery code) stays, with its name and score, as a player without a code.

alter table if exists public.player_name_history set schema gs_rolledback;
alter table if exists public.player_saves set schema gs_rolledback;
alter table if exists public.player_save_history set schema gs_rolledback;
alter table if exists public.player_link_log set schema gs_rolledback;

drop index if exists public.players_account;
alter table public.players drop column account_id;
alter table public.players drop column linked_at;

commit;
