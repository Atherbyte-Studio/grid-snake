-- Undoes wallet.sql: the Worker can no longer read or change wallets. The tables, balances, items and the ledger STAY
-- (nothing is deleted), so running wallet.sql again picks up where it was. Deploy the previous Worker and page first.
begin;
drop function if exists public.gs_wallet_claim_achievements(uuid, jsonb);
drop function if exists public.gs_run_claim(uuid, uuid, integer);
drop function if exists public.gs_run_open(uuid, text);
drop function if exists public.gs_wallet_credit_ranked(uuid, uuid);
drop function if exists public.gs_wallet_buy(uuid, text);
drop function if exists public.gs_wallet_open(uuid, jsonb);
drop function if exists public.wallet_day_total(uuid, text);
drop function if exists public.wallet_json(uuid);
commit;
