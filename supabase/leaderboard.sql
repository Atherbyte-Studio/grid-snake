-- Grid Snake global leaderboard: Time Attack scores.
-- Run once in Supabase: Dashboard > SQL Editor > New query > paste > Run.
-- Safe to re-run: it only creates what is missing.

create table if not exists public.time_attack_scores (
  id         bigint generated always as identity primary key,
  -- one id per finished run: a second post of the same run is refused (409 Conflict on insert)
  run_id     uuid not null unique,
  name       text not null
             check (char_length(name) between 1 and 16)
             -- no markup, quotes, backslashes or control characters; the page checks the rest
             check (name !~ '[<>&"''`\\\\[:cntrl:]]'),
  -- Time Attack: 60 s run, the highest sane score is 1000 (see CONFIG.maxScore in src/leaderboard.js)
  score      integer not null check (score between 0 and 1000),
  created_at timestamptz not null default now()
);

-- The board is read best score first, the earlier run first on a tie.
create index if not exists time_attack_scores_rank
  on public.time_attack_scores (score desc, created_at asc);

alter table public.time_attack_scores enable row level security;

-- Anyone with the public key may read the board and add a run. Nobody may change or delete a row.
drop policy if exists "read the board" on public.time_attack_scores;
create policy "read the board" on public.time_attack_scores
  for select to anon, authenticated using (true);

drop policy if exists "add a run" on public.time_attack_scores;
create policy "add a run" on public.time_attack_scores
  for insert to anon, authenticated with check (true);

revoke update, delete on public.time_attack_scores from anon, authenticated;
