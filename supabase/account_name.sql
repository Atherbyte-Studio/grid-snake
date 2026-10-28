-- Grid Snake: the Atherbyte username is the player's name (needs account_link.sql first).
--
-- gs_use_account_name(account, create), for the Worker only:
--   * the account has a player: its name becomes the account's username, read HERE from public.profiles (never from a
--     browser). Same row, same id, score, rank, saves and link. The old name is kept in player_name_history.
--     If another player already uses that name (any letter case), or it breaks the name rules, the name is left as it is.
--   * the account has no player and create is true: a new player is made with that name, linked to the account.
--     It has no recovery code; the account is how it is reached. create is only sent when the player chose it.
-- Re-running it is safe. rollback_account_link.sql also undoes it (nothing is deleted).
begin;

do $$
begin
  if to_regprocedure('public.gs_link_player(uuid, text)') is null then
    raise exception 'STOP: account_link.sql is not applied. Nothing was changed.';
  end if;
end $$;

create table if not exists public.player_name_history (
  id         bigint generated always as identity primary key,
  player_id  uuid not null references public.players (id) on delete restrict,
  old_name   text not null,
  new_name   text not null,
  changed_at timestamptz not null default now()
);
alter table public.player_name_history enable row level security;
revoke all on public.player_name_history from public, anon, authenticated;

create or replace function public.gs_use_account_name(p_account uuid, p_create boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text;
  v_row  public.players;
begin
  if p_account is null then return jsonb_build_object('status', 'invalid'); end if;
  select username into v_name from public.profiles where id = p_account;
  if v_name is null then return jsonb_build_object('status', 'no-profile'); end if;

  select * into v_row from public.players where account_id = p_account for update;
  if found then
    if v_row.name = v_name then
      return jsonb_build_object('status', 'ok', 'name', v_row.name, 'renamed', false);
    end if;
    if not public.player_name_ok(v_name) then
      return jsonb_build_object('status', 'ok', 'name', v_row.name, 'renamed', false, 'reason', 'name-invalid');
    end if;
    begin
      update public.players set name = v_name where id = v_row.id;
    exception when unique_violation then
      return jsonb_build_object('status', 'ok', 'name', v_row.name, 'renamed', false, 'reason', 'name-taken');
    end;
    insert into public.player_name_history (player_id, old_name, new_name) values (v_row.id, v_row.name, v_name);
    return jsonb_build_object('status', 'ok', 'name', v_name, 'renamed', true);
  end if;

  if p_create is distinct from true then return jsonb_build_object('status', 'no-player'); end if;
  if not public.player_name_ok(v_name) then return jsonb_build_object('status', 'name-invalid'); end if;
  begin
    insert into public.players (name, account_id, linked_at) values (v_name, p_account, now()) returning * into v_row;
  exception when unique_violation then   -- the name is another player's, or this account got a player at the same moment
    return jsonb_build_object('status', 'name-taken');
  end;
  insert into public.player_link_log (account_id, player_id, outcome) values (p_account, v_row.id, 'created');
  return jsonb_build_object('status', 'created', 'name', v_row.name);
end $$;

revoke all on function public.gs_use_account_name(uuid, boolean) from public, anon, authenticated;
grant execute on function public.gs_use_account_name(uuid, boolean) to service_role;

commit;
