-- READ-ONLY. Run in the SQL Editor BEFORE supabase/leaderboard.sql on a project that may still have version 1.
-- It changes nothing. Save the results with your backup. Each block is one result table.

-- 1. Which tables exist. A version 1 project has time_attack_scores and no players.
select to_regclass('public.time_attack_scores') is not null as has_time_attack_scores,
       to_regclass('public.time_attack_scores_legacy') is not null as has_legacy_table,
       to_regclass('public.players') is not null as has_players;

-- 2. The columns. The migration needs exactly: created_at, id, name, run_id, score.
select column_name, data_type from information_schema.columns
where table_schema = 'public' and table_name = 'time_attack_scores' order by column_name;

-- 3. Who can use it, and its policies. Write these down: the rollback restores version 1 access by hand.
select grantee, privilege_type from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'time_attack_scores' order by grantee, privilege_type;
select policyname, cmd, roles from pg_policies where schemaname = 'public' and tablename = 'time_attack_scores';

-- 4. What the migration will do, as a preview: rows, rows it will skip, and distinct names after normalisation.
with n as (
  select btrim(regexp_replace(coalesce(name, ''), '\s+', ' ', 'g')) as name, score
  from public.time_attack_scores
)
select count(*) as legacy_rows,
       count(*) filter (where not (char_length(name) between 1 and 16 and name !~ '[<>&"`\\\\[:cntrl:]]'
                                   and name = btrim(name) and name !~ '  ' and name <> '' and score between 0 and 1000)) as rows_to_skip,
       count(distinct lower(name)) as distinct_names_ignoring_case
from n;
