-- Rolls a version 2 project back to version 1. NOTHING is deleted: the players table is renamed, not dropped,
-- so every player and score stays in the database as public.players_v2_saved.
-- Run in the SQL Editor only after the version 1 page is published again, or accept that the game shows
-- "not set up on the server yet" until it is. Read supabase/README.md, "Rolling back", first.
-- It stops with an error, changing nothing, unless the project is exactly in the version 2 state.
begin;

do $$
begin
  if to_regclass('public.players') is null then
    raise exception 'STOP: public.players not found. Nothing was changed.';
  end if;
  if to_regclass('public.time_attack_scores_legacy') is null then
    raise exception 'STOP: public.time_attack_scores_legacy not found. Nothing was changed.';
  end if;
  if to_regclass('public.time_attack_scores') is not null then
    raise exception 'STOP: public.time_attack_scores already exists. Nothing was changed.';
  end if;
  if to_regclass('public.players_v2_saved') is not null then
    raise exception 'STOP: public.players_v2_saved already exists (an earlier rollback). Nothing was changed.';
  end if;
end $$;

-- The version 2 functions go. They hold no data.
drop function if exists public.register_player(text, text);
drop function if exists public.submit_best(text, integer, boolean, boolean, text);
drop function if exists public.get_me(text);
drop function if exists public.get_top(integer);
drop function if exists public.player_rank(uuid);
drop function if exists public.secret_hash_of(text);
drop function if exists public.normalize_player_name(text);
drop function if exists public.player_name_ok(text);

-- The table and its indexes are kept under new names. The indexes are renamed too, so that a later upgrade
-- creates its own indexes instead of silently keeping these.
alter index public.players_name_ci rename to players_v2_saved_name_ci;
alter index public.players_rank rename to players_v2_saved_rank;
alter table public.players rename to players_v2_saved;
alter table public.time_attack_scores_legacy rename to time_attack_scores;
-- Version 1 access. Check it against your backup (see README, step 1) before you rely on it.
grant select, insert on public.time_attack_scores to anon, authenticated;

commit;
