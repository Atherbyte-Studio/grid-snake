# Grid Snake global board: setup (version 2)

The board ranks each player by their **personal best** in ranked Time Attack. A player has a permanent name, and
each name appears once on the board. The game talks to Supabase through its database functions (RPC). Nothing here
needs a server of your own.

Ranked Time Attack means: **Walls ON, Golden Apple ON, Hard**. Other modes and other settings never reach the board.

## What changes on an existing project

Version 1 stored one row per round in `time_attack_scores`. Running `supabase/leaderboard.sql` does this, in one transaction:

1. Creates `players`: one row per player, with a unique name (ignoring letter case), a hash of the recovery code, and the best score with the time it was reached.
2. Copies each name's best legacy score into `players` as an **unclaimed** record. An unclaimed name has no recovery code, so nobody can play as it. It stays reserved on the board until you release it (see below).
3. Renames `time_attack_scores` to `time_attack_scores_legacy` and removes all access to it. **Nothing is deleted.** Drop it yourself when you are sure.
4. Creates the functions the game calls. Browsers can no longer insert, update or delete rows directly.

Re-running the file is safe: step 2 and the rename run only while the old table still exists.

**Deploy order matters.** Version 1 of the page inserts into `time_attack_scores`, which no longer exists after the
migration. Run the SQL and publish the version 2 page close together. Until the page is updated, old copies of the
game show "not set up on the server yet".

## Setup (new project)

1. Create a project at https://supabase.com (**New project**).
2. Open **SQL Editor > New query**, paste all of `supabase/leaderboard.sql`, and press **Run**.
3. Check **Table Editor**: `players` exists. Then check **Database > Functions**: `register_player`, `submit_best`, `get_me`, `get_top`.
4. In the game, `src/leaderboard.js` holds the project URL and the publishable key (`sb_publishable_...`). This is
   public by design. Row-level security protects the data. **Never** put the `service_role` / secret key in the repository.
   To use another project, change `CONFIG.url` and `CONFIG.anonKey`, then run `node build.js`.

## Existing project (upgrade from version 1)

1. Back up first: in **Table Editor**, export `time_attack_scores`.
2. Run `supabase/leaderboard.sql` in the SQL Editor (see "What changes" above).
3. Check: `select count(*) from players;` (one row per name ever recorded) and `select to_regclass('public.time_attack_scores_legacy');` (not null).
4. Publish the version 2 page at the same time.

## How players and recovery work

- On first play the game asks for a **player name**: 1 to 16 letters, digits, spaces, or `_ . ' -` (Arabic is fine).
  Names are unique ignoring case. Once created, the name cannot be changed.
- The game then shows a **recovery code** (32 characters, in groups of four). It is shown once. Write it down.
- The browser keeps the code so the player stays signed in. The server keeps only a SHA-256 hash of it.
- **Clearing browser data or playing on another device** needs the code: choose *I already have a recovery code*
  on the welcome screen and type it. The name and personal best come back.
- **Lost code and cleared storage:** the player cannot prove the name is theirs, so the name stays taken. Nobody else
  can use it, but nobody can post under it either. The player must choose a new name.
- The name is never sent with a score. A score can only raise the best of the player whose code it carries.

## Releasing an unclaimed legacy name (owner only)

Unclaimed names come from version 1 and have no code. To free one, run in the SQL Editor:

    delete from public.players where secret_hash is null and lower(name) = lower('the-name');

Only the owner should run this. Anyone can then register that name again.

## Rolling back

Rolling back deletes every player created since the upgrade. Only do it if that data does not matter:

    drop function if exists public.register_player(text, text), public.submit_best(text, integer, boolean, boolean, text),
      public.get_me(text), public.get_top(integer), public.player_rank(uuid), public.secret_hash_of(text);
    drop table if exists public.players;
    alter table public.time_attack_scores_legacy rename to time_attack_scores;
    grant select, insert on public.time_attack_scores to anon, authenticated;

Then publish the version 1 page. (Version 1 used per-round rows; its data is kept in the renamed table.)

## Checks

- Database checks (run against a scratch database, not production): `PGHOST=... PGUSER=postgres tests/db/run.sh`.
  They cover the migration of legacy data, anon-role permissions, registration, the ranked rule, personal bests,
  rank and the top ten, and parallel submissions.
- Game checks: `node build.js && node --test tests/*.test.js` (browser tests need Playwright).
- After deploying, play one ranked Time Attack round, open **Global board**, and confirm your name and score appear.

## What is and is not protected

- The database checks the shape and range of every value: names, codes, scores 0 to 1000, the exact ranked rule,
  and one row per player. It cannot check that a run really happened.
- A modified browser can send any score it likes. This is **not cheat-proof**. Stopping that needs a trusted
  replay of each run on a server, which this version does not do.
- Anyone with a recovery code can post as that player. Keep codes private.
- There is no rate limit on registration or submissions. Add one in Supabase if the board is abused.
- Names and scores on the board are public. Codes and internal ids are never returned.
- The rank query is an index range scan, not a download of the board. It stays fast for large boards, but it is
  not free: for very large boards, consider caching the rank.
