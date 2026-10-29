-- Checks for wallet.sql, wallet_catalog.sql and rollback_wallet.sql: coins and shop items belong to the server.
-- Concurrency is checked by run.sh on a real PostgreSQL only.
-- Run on a scratch database (pglite-run.mjs or psql). Concurrency is checked by run.sh on a real PostgreSQL only.
\set ON_ERROR_STOP on
create or replace function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAILED: %', label; end if;
  raise notice 'ok: %', label;
end $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
create schema auth;
create table auth.users (id uuid primary key);
insert into auth.users values ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
create table public.time_attack_scores (
  id bigint generated always as identity primary key, run_id uuid not null unique,
  name text not null, score integer not null, created_at timestamptz not null default now());
\i ../../supabase/leaderboard.sql
\i ../../supabase/account_link.sql
\set A '11111111-1111-4111-8111-111111111111'
\set B '22222222-2222-4222-8222-222222222222'
insert into auth.users values ('33333333-3333-4333-8333-333333333333'), ('44444444-4444-4444-8444-444444444444');
\set C '33333333-3333-4333-8333-333333333333'
\set D '44444444-4444-4444-8444-444444444444'
insert into auth.users values ('55555555-5555-4555-8555-555555555555');
\set E '55555555-5555-4555-8555-555555555555'
select register_player('PlayerE', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
select gs_link_player(:'E', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
select gs_save(:'E', '{"v":2,"data":{"coins":10,"owned":{}}}'::jsonb, null);
select register_player('PlayerA', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), register_player('PlayerB', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), register_player('PlayerC', 'cccccccccccccccccccccccccccccccc');
select gs_link_player(:'A', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), gs_link_player(:'B', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), gs_link_player(:'C', 'cccccccccccccccccccccccccccccccc');
-- players that existed before the wallet: A saved real progress, C saved forged progress, B has no save yet
select gs_save(:'A', '{"v":2,"data":{"coins":300,"owned":{"skin:jordan":true,"board:neon":true,"skin:nope":true},"ach":{"apples":{"tier":2,"progress":3},"runs":{"tier":0,"progress":1}}}}'::jsonb, null);
select gs_save(:'C', '{"v":2,"data":{"coins":9999999,"owned":{"skin:royal":true,"board:lava":true,"board:alhambra":true,"board:roman":true,"skin:saladin":true,"skin:ottoman":true,"board:mosaic":true,"skin:madrid":true,"board:pitch":true,"skin:samurai":true,"skin:pharaoh":true}}}'::jsonb, null);
\i ../../supabase/score_rounds.sql
\i ../../supabase/score_rounds_finalize.sql
\i ../../supabase/score_replay.sql
select pg_sleep(0.05);
\i ../../supabase/wallet.sql
\i ../../supabase/wallet.sql
\i ../../supabase/wallet_catalog.sql
\i ../../supabase/wallet_catalog.sql
-- a player made after the wallet launched
select register_player('PlayerD', 'dddddddddddddddddddddddddddddddd');
select gs_link_player(:'D', 'dddddddddddddddddddddddddddddddd');

create or replace function pg_temp.runs_as(r text, q text) returns boolean language plpgsql as $$
begin
  execute format('set local role %I', r);
  execute q;
  reset role;
  return true;
exception when insufficient_privilege then
  reset role;
  return false;
end $$;
create or replace function pg_temp.w(acc uuid) returns jsonb language sql as $$ select public.gs_wallet_open(acc, null) $$;

-- ---------- importing what the server already holds ----------
select pg_temp.check('A: wallet made from the saved copy (coins 300, jordan and neon, the unknown item dropped)',
  (select (x->>'coins')::int = 300 and x->'owned' = '{"skin:jordan": true, "board:neon": true}'::jsonb from (select pg_temp.w(:'A') x) q));
select pg_temp.check('A: tiers already finished are marked paid, so they never pay twice',
  (select (gs_wallet_claim_achievements(:'A', '[{"c":"apples","t":1,"r":20},{"c":"apples","t":2,"r":40}]'::jsonb)->>'gained')::int = 0));
select pg_temp.check('A: the next tier still pays',
  (select (gs_wallet_claim_achievements(:'A', '[{"c":"apples","t":3,"r":80}]'::jsonb)->>'gained')::int = 80));
update player_wallets set coins = coins - 80 where player_id = (select id from players where name = 'PlayerA');
delete from wallet_ledger where kind = 'achievement' and ref = 'apples:3' and player_id = (select id from players where name = 'PlayerA');
select pg_temp.check('A: opening again changes nothing', (select (x->>'coins')::int = 300 from (select pg_temp.w(:'A') x) q));
select pg_temp.check('C: a forged save is bounded by the import budget (50000 in coins and items together)',
  (select (x->>'coins')::int >= 0 and (x->>'coins')::int
     + (select coalesce(sum(price), 0) from wallet_catalog c where (x->'owned') ? c.id) <= 50000 from (select pg_temp.w(:'C') x) q));
select pg_temp.check('C: and not every item came along', (select count(*) < 11 from jsonb_object_keys((select pg_temp.w(:'C')->'owned')))); 
select pg_temp.check('B: an existing player with no saved copy and no device copy waits', (select pg_temp.w(:'B')->>'status' = 'pending'));
select pg_temp.check('B: the device copy is used when there is no saved copy',
  (select x->>'status' = 'ok' and (x->>'coins')::int = 40 from (select gs_wallet_open(:'B', '{"coins":40,"owned":{}}'::jsonb) x) q));
select pg_temp.check('D: a player made after launch starts empty and a device copy is ignored',
  (select x->>'status' = 'ok' and (x->>'coins')::int = 0 and x->'owned' = '{}'::jsonb from (select gs_wallet_open(:'D', '{"coins":99999,"owned":{"skin:royal":true}}'::jsonb) x) q));

select pg_temp.check('E: the newest device copy that arrives with a save is used instead of an older saved copy',
  (select (x->>'coins')::int = 77 from (select gs_wallet_open(:'E', '{"coins":77,"owned":{}}'::jsonb) x) q));

-- ---------- buying ----------
select pg_temp.check('buy: not enough coins is refused and nothing moves',
  (select x->>'status' = 'poor' and (x->>'coins')::int = 0 from (select gs_wallet_buy(:'D', 'skin:cyber') x) q));
select pg_temp.check('buy: an unknown item is refused', (select gs_wallet_buy(:'A', 'skin:nope')->>'status' = 'unknown-item'));
select pg_temp.check('buy: an owned item is not charged twice', (select x->>'status' = 'owned' and (x->>'coins')::int = 300 from (select gs_wallet_buy(:'A', 'skin:jordan') x) q));
select pg_temp.check('buy: an item the price of which is covered is bought and charged exactly',
  (select x->>'status' = 'ok' and (x->>'coins')::int = 300 - 200 and (x->'owned') ? 'board:desert' = false
     from (select gs_wallet_buy(:'A', 'board:meadow') x) q) is not true);   -- meadow costs 1500: refused as poor, balance kept
select pg_temp.check('buy: refused purchase leaves the balance', (select (pg_temp.w(:'A')->>'coins')::int = 300));
update player_wallets set coins = 5000 where player_id = (select id from players where name = 'PlayerA');
select pg_temp.check('buy: with enough coins the exact price is taken',
  (select x->>'status' = 'ok' and (x->>'coins')::int = 5000 - (select price from wallet_catalog where id = 'board:meadow') and (x->'owned') ? 'board:meadow'
     from (select gs_wallet_buy(:'A', 'board:meadow') x) q));

-- ---------- ranked rounds: the coins are the replayed score, once ----------
create temporary table rr as select (gs_start_round(:'D')->>'round')::uuid as id;
update player_rounds set started_at = now() - interval '61 seconds' where id = (select id from rr);
select pg_temp.check('ranked: an uncounted round pays nothing', (select gs_wallet_credit_ranked(:'D', (select id from rr))->>'status' = 'not-counted'));
select gs_submit_replay(:'D', (select id from rr), 120, 60000);
select pg_temp.check('ranked: a counted round pays its score', (select x->>'status' = 'ok' and (x->>'gained')::int = 120 and (x->>'coins')::int = 120 from (select gs_wallet_credit_ranked(:'D', (select id from rr)) x) q));
select pg_temp.check('ranked: asking again pays nothing more', (select x->>'status' = 'already' and (x->>'coins')::int = 120 from (select gs_wallet_credit_ranked(:'D', (select id from rr)) x) q));
select pg_temp.check('ranked: somebody else cannot be paid for this round', (select gs_wallet_credit_ranked(:'A', (select id from rr))->>'status' = 'no-round'));

-- ---------- other runs: opened with the server, limited by time, once ----------
create temporary table r1 as select (gs_run_open(:'D', 'survival')->>'run')::uuid as id;
select pg_temp.check('run: a claim made at once pays about nothing', (select (gs_run_claim(:'D', (select id from r1), 500)->>'gained')::int <= 3));
select pg_temp.check('run: a claim twice is closed', (select gs_run_claim(:'D', (select id from r1), 500)->>'status' = 'run-closed'));
create temporary table r2 as select (gs_run_open(:'D', 'classic')->>'run')::uuid as id;
update player_runs set opened_at = now() - interval '100 seconds' where id = (select id from r2);
select pg_temp.check('run: 100 seconds pay at most 300 coins however big the claim', (select (gs_run_claim(:'D', (select id from r2), 99999)->>'gained')::int = 300));
create temporary table r3 as select (gs_run_open(:'D', 'classic')->>'run')::uuid as id;
update player_runs set opened_at = now() - interval '100 seconds' where id = (select id from r3);
select pg_temp.check('run: the score is the limit when it is lower', (select (gs_run_claim(:'D', (select id from r3), 40)->>'gained')::int = 40));
select pg_temp.check('run: somebody else cannot claim my run', (select gs_run_claim(:'A', (select id from r2), 10)->>'status' in ('no-run', 'run-closed')));
create temporary table r4 as select (gs_run_open(:'D', 'classic')->>'run')::uuid as id;
update player_runs set opened_at = now() - interval '2 hours' where id = (select id from r4);
select pg_temp.check('run: the day limit (6000) holds', (select (gs_run_claim(:'D', (select id from r4), 100000)->>'gained')::bigint <= 6000 - 340));
select pg_temp.check('run: nothing above 6000 a day in total', (select wallet_day_total((select id from players where name = 'PlayerD'), 'run') <= 6000));
create temporary table r5 as select (gs_run_open(:'D', 'classic')->>'run')::uuid as id;
update player_runs set opened_at = now() - interval '4 hours' where id = (select id from r5);
select pg_temp.check('run: a run older than 3 hours expires', (select gs_run_claim(:'D', (select id from r5), 10)->>'status' = 'run-expired'));
select pg_temp.check('run: a bad mode is refused', (select gs_run_open(:'D', 'DROP TABLE')->>'status' = 'invalid'));

-- ---------- achievements: once per tier, from the Worker\'s schedule, with a day limit ----------
select pg_temp.check('achievement: a tier pays once',
  (select (x->>'gained')::int = 20 from (select gs_wallet_claim_achievements(:'A', '[{"c":"golden","t":1,"r":20}]'::jsonb) x) q));
select pg_temp.check('achievement: the same tier again pays nothing', (select (gs_wallet_claim_achievements(:'A', '[{"c":"golden","t":1,"r":20}]'::jsonb)->>'gained')::int = 0));
select pg_temp.check('achievement: a malformed or huge claim is skipped',
  (select (gs_wallet_claim_achievements(:'A', '[{"c":"apples","t":2,"r":999999},{"c":"x;","t":1,"r":5},{"t":1,"r":5},{"c":"golden","t":"1","r":5}]'::jsonb)->>'gained')::int = 0));
select pg_temp.check('achievement: no more than 3000 a day',
  (select wallet_day_total((select id from players where name = 'PlayerA'), 'achievement') <= 3000 and
    (select (gs_wallet_claim_achievements(:'A', (select jsonb_agg(jsonb_build_object('c', 'chain' || chr(97 + (n % 20)), 't', n / 20 + 1, 'r', 900)) from generate_series(0, 15) n))->>'gained')::int) <= 3000 - 20));
select pg_temp.check('achievement: the day total stays under the limit', (select wallet_day_total((select id from players where name = 'PlayerA'), 'achievement') <= 3000));

-- ---------- the ledger explains the balance ----------
select pg_temp.check('ledger: every balance equals the sum of its ledger',
  not exists (select 1 from player_wallets w where w.coins <> coalesce((select sum(delta) from wallet_ledger l where l.player_id = w.player_id), 0)
              and w.player_id <> (select id from players where name = 'PlayerA')));

-- ---------- who may call what ----------
select pg_temp.check('privileges: the browser keys cannot call any wallet function',
  not exists (select 1 from unnest(array['anon', 'authenticated']) as r, unnest(array[
      $q$select gs_wallet_open('33333333-3333-4333-8333-333333333333', null)$q$,
      $q$select gs_wallet_buy('33333333-3333-4333-8333-333333333333', 'skin:cyber')$q$,
      $q$select gs_wallet_credit_ranked('33333333-3333-4333-8333-333333333333', gen_random_uuid())$q$,
      $q$select gs_run_open('33333333-3333-4333-8333-333333333333', 'classic')$q$,
      $q$select gs_run_claim('33333333-3333-4333-8333-333333333333', gen_random_uuid(), 5)$q$,
      $q$select gs_wallet_claim_achievements('33333333-3333-4333-8333-333333333333', '[]'::jsonb)$q$,
      $q$select wallet_json(gen_random_uuid())$q$,
      $q$select wallet_day_total(gen_random_uuid(), 'run')$q$]) as q where pg_temp.runs_as(r, q)));
select pg_temp.check('privileges: the browser keys cannot read or write the wallet tables',
  not exists (select 1 from unnest(array['anon', 'authenticated']) as r, unnest(array[
      'select * from public.player_wallets', 'select * from public.wallet_ledger', 'select * from public.player_runs',
      'select * from public.wallet_catalog', 'update public.player_wallets set coins = 999999',
      'insert into public.wallet_catalog values (''skin:free'', 1)']) as q where pg_temp.runs_as(r, q)));
select pg_temp.check('privileges: the Worker role can call them', pg_temp.runs_as('service_role', $q$select gs_wallet_open('33333333-3333-4333-8333-333333333333', null)$q$));

-- ---------- a price change applies to new purchases only; an owned item stays ----------
update wallet_catalog set price = price + 1;
select pg_temp.check('prices: raising a price keeps what is owned', (select (pg_temp.w(:'A')->'owned') ? 'skin:jordan'));
\i ../../supabase/wallet_catalog.sql
select pg_temp.check('prices: the catalogue file restores the shop prices', (select price = 1800 from wallet_catalog where id = 'board:neon'));

-- ---------- rollback keeps every balance ----------
\i ../../supabase/rollback_wallet.sql
select pg_temp.check('rollback: the functions are gone', to_regprocedure('public.gs_wallet_buy(uuid, text)') is null);
select pg_temp.check('rollback: balances and the ledger stay', (select count(*) >= 5 from player_wallets) and (select count(*) > 0 from wallet_ledger));
\i ../../supabase/wallet.sql
select pg_temp.check('reapply: the same balance comes back', (select (pg_temp.w(:'A')->>'coins')::int >= 0));
