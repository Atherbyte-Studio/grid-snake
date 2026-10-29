-- Undoes lock_legacy_submit.sql: the browser may call submit_best again (the unchecked score path). Only for an emergency.
begin;
grant execute on function public.submit_best(text, integer, boolean, boolean, text) to anon, authenticated;
commit;
