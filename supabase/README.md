# Grid Snake global board: setup (version 2)

The board ranks each player by their **personal best** in ranked Time Attack. A player has a permanent name, and
each name appears once on the board. The game talks to Supabase through its database functions (RPC). Nothing here
needs a server of your own.

Ranked Time Attack means: **Walls ON, Golden Apple ON, Hard**. Other modes and other settings never reach the board.

## Files

| File | Use |
| --- | --- |
| `leaderboard.sql` | Creates or upgrades the board. Run it once per project (re-running is covered below). |
| `check_before_upgrade.sql` | **Read-only.** Shows the state of a project before you upgrade it. Changes nothing. |
| `rollback_v2.sql` | Returns a version 2 project to version 1 without deleting anything. |

Tests for these files (run on a scratch PostgreSQL, never on Supabase): `tests/db/run.sh`.

## What changes on an existing project

Version 1 stored one row per round in `time_attack_scores`. Running `leaderboard.sql` does this, in one transaction:

1. Creates `players`: one row per player, with a unique name (ignoring letter case), a hash of the recovery code,
   and the best score with the time it was reached.
2. Copies each legacy name's best score into `players` as an **unclaimed** record. An unclaimed name has no recovery
   code, so nobody can play as it. It stays reserved on the board until you release it (see below).
3. Renames `time_attack_scores` to `time_attack_scores_legacy` and removes all access to it. **Nothing is deleted.**
   Drop it yourself when you are sure.
4. Creates the functions the game calls. Browsers can no longer insert, update or delete rows directly.

### How legacy names are copied

- A legacy name is normalised exactly as `register_player` normalises a name: spaces at the ends are removed, and
  any run of spaces or tabs becomes one space. Letter case is kept as written. Arabic names are kept as they are.
- A legacy row whose name is **not valid after normalisation** (empty, longer than 16 characters, or containing
  `< > & " \`` or a control character), or whose score is outside 0 to 1000, is **skipped, not repaired**. It stays
  in `time_attack_scores_legacy`, and its id is printed as a notice when the file runs. The migration does not stop.
- Names that are the same after normalisation, **ignoring letter case, are one player**. That player keeps the
  **highest score**. On a tie, the **earliest** time. On a tie again, the **lowest id**. The spelling kept is the one
  from that winning row.
- A name that already exists in `players` is left alone.

`check_before_upgrade.sql` shows how many rows will be skipped and how many distinct names there are before you run
anything.

## When to stop

`leaderboard.sql` checks the state first and changes nothing in these cases. It stops with a message beginning
`STOP:`. **Do not run it again to get past a stop.** Find out why first.

| What you see | Meaning | What to do |
| --- | --- | --- |
| `STOP: public.players and public.time_attack_scores both exist` | The project is version 2, and something created a new table with the old name. A version 1 project has no `players`. | Do not rename or drop anything yet. Check what `time_attack_scores` is. If it is a new table, leave it alone. |
| `STOP: ... an index named players_name_ci or players_rank already exists without a players table` | A leftover index from an earlier attempt or rollback. | Ask for help before you drop it. |
| `STOP: both time_attack_scores and time_attack_scores_legacy exist` | The old table was renamed, and a new table took its name. | Compare both tables. Keep the one with the version 1 rows. |
| `STOP: public.time_attack_scores does not have the version 1 columns` | The table is not the version 1 table. | Check the columns with `check_before_upgrade.sql`. |

## Re-running

- **On a finished version 2 project, re-running is safe.** It finds `players` and no `time_attack_scores`, and changes nothing.
- **On a version 1 project that was not yet upgraded,** running it again after a successful run is the same as the
  finished case above. After a failed run, nothing was changed (the whole file is one transaction).
- **Stop instead of re-running** when a `STOP:` message appears, and whenever `time_attack_scores` exists alongside
  `players` or `time_attack_scores_legacy`.
- Re-running after a rollback works. The rollback keeps the old players under other names (see "Rolling back").

## Setup (new project)

1. Create a project at https://supabase.com (**New project**).
2. Open **SQL Editor > New query**, paste all of `supabase/leaderboard.sql`, and press **Run**.
3. Check that the functions exist. Run this in the SQL Editor:

       select proname from pg_proc where pronamespace = 'public'::regnamespace order by proname;

   The list must include `get_me`, `get_top`, `register_player` and `submit_best`.
4. In the game, `src/leaderboard.js` holds the project URL and the publishable key (`sb_publishable_...`). This is
   public by design. Row-level security protects the data. **Never** put the `service_role` / secret key in the repository.
   To use another project, change `CONFIG.url` and `CONFIG.anonKey`, then run `node build.js`.

## Existing project (upgrade from version 1)

Do this in order. Do not skip the backup.

1. **Check.** Run `supabase/check_before_upgrade.sql` in the SQL Editor. Save the results. Confirm that the legacy
   table has the five version 1 columns and that `has_players` is false.
2. **Back up.** Copy the table into a schema that the API does not expose. Run:

       create schema if not exists gs_backup;
       create table gs_backup.time_attack_scores_v1 as select * from public.time_attack_scores;
       select count(*) from gs_backup.time_attack_scores_v1;
       select count(*) from public.time_attack_scores;

   The two counts must match. Keep the `gs_backup` schema until you have checked the upgrade. Drop it yourself afterwards.
3. **Upgrade.** Paste all of `supabase/leaderboard.sql` into the SQL Editor and press **Run**. Read the notices: they
   give the number of players copied, the rows merged, and the rows skipped with their ids.
4. **Check.** Run:

       select count(*) from players;
       select to_regclass('public.time_attack_scores_legacy');   -- not null
       select to_regclass('public.time_attack_scores');          -- null

   `players` must hold one row per distinct name (ignoring case and spaces). Compare this with the preview from step 1.
5. **Publish the version 2 page** close to the time of step 3. Until the page is updated, old copies of the game
   show "not set up on the server yet" (the old copy writes to `time_attack_scores`, which no longer exists after step 3).

Nothing is deleted at any point. The old rows are in `time_attack_scores_legacy` and in `gs_backup`.

## Rolling back

Rolling back **keeps every player**: it renames `players` to `players_v2_saved` and does not drop it. It also removes
the version 2 functions. It stops, changing nothing, unless the project is exactly in the version 2 state.

1. Run `supabase/rollback_v2.sql` in the SQL Editor.
2. Check the access that version 1 had. The rollback gives `anon` and `authenticated` `select, insert` on
   `time_attack_scores`, as version 1 did. Compare with the grants you saved in step 1 of the upgrade (the grant
   query in `check_before_upgrade.sql`). If they differ, change them by hand.
3. Publish the version 1 page.

Version 1 rounds written after the rollback stay in `time_attack_scores`. Upgrading again later migrates them, and
`players_v2_saved` is left as it is.

Version 2 players are never deleted by any of this. If you want to remove them for good, drop `players_v2_saved`
yourself, after you are sure.

## Releasing an unclaimed legacy name (owner only)

Unclaimed names come from version 1 and have no code. To free one, run in the SQL Editor:

    delete from public.players where secret_hash is null and lower(name) = lower('the-name');

Only the owner should run this. Anyone can then register that name again.

## How players and recovery work

- On first play the game asks for a **player name**: 1 to 16 letters, digits, spaces, or `_ . ' -` (Arabic is fine).
  Names are unique ignoring case. Once created, the name cannot be changed.
- The game then shows a **recovery code** (32 characters, in groups of four). Write it down and keep it private.
- The browser keeps the code so the player stays signed in. The server keeps only a SHA-256 hash of it.
- **A lost answer does not lose the player.** The browser keeps the code on this device before it sends the request,
  and sends the same code again on a retry. If the server already has that code, the game restores the player.
  A player that was created but whose answer was lost is also restored on the next page load.
- **Clearing browser data or playing on another device** needs the code: choose *I already have a recovery code*
  on the welcome screen and type it. The name and personal best come back.
- **Lost code and cleared storage:** the player cannot prove the name is theirs, so the name stays taken. Nobody else
  can use it, but nobody can post under it either. The player must choose a new name. (The owner can release it;
  see the section above, for legacy names only.)
- The name is never sent with a score. A score can only raise the best of the player whose code it carries.

### The recovery code is a secret credential

- It is the **only** proof that a player is theirs. Anyone who has it can post scores as that player.
- It is stored in the browser's local storage in plain text, so any script running on the game's page, or anyone with
  access to the device, can read it. It is also sent to the server on each page load.
- **Losing it means losing the identity**, unless a recovery mechanism exists that the server can verify (none does
  in this version). The server cannot show it again: it keeps only a hash.
- The game never writes the code to the console or to diagnostic output.

## Who can call what

Browsers use the publishable key. The database lets the `anon` and `authenticated` roles call **only** these four
functions. Everything else is refused for those roles, by direct call and by privilege check. `tests/db/privileges.sql`
checks this.

| Function | Browser may call | Why |
| --- | --- | --- |
| `register_player(name, code)` | yes | Creates a player. |
| `submit_best(code, score, walls, golden, difficulty)` | yes | Raises the best of one player. |
| `get_me(code)` | yes | Returns the player's own record. |
| `get_top(limit)` | yes | Returns the top ten: names and scores only. |
| `secret_hash_of`, `player_rank`, `normalize_player_name`, `player_name_ok` | **no** | Internal helpers. |
| `players`, `time_attack_scores_legacy` (tables) | **no** | No direct access at all. |

The functions run with the owner's rights and a fixed `search_path`. No `service_role` key is used or needed in the
browser code.

## Checks

- **Database checks** (a scratch PostgreSQL 16, never production):

      PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=postgres tests/db/run.sh

  They cover the schema, concurrent submissions and registrations, the migration policy (extra spaces, tabs, Arabic,
  ties, skipped rows, re-running), the stop cases (nothing is moved), rollback followed by a second upgrade, and the
  anon and authenticated privileges.
- **Game checks:** `node build.js`, then `NODE_PATH=$(npm root -g) node --test tests/*.test.js`. The browser tests need
  Playwright and a Chromium it can start. `NODE_PATH` is needed because Playwright is installed globally here.
- After deploying, play one ranked Time Attack round, open **Global board**, and confirm your name and score appear.

## Testing the upgrade on a separate Supabase project

Never test on the live project. Create a second project, and use it for the whole list below:

1. Create a new Supabase project (for example `gridsnake-migration-test`).
2. Recreate version 1 there: in the SQL Editor, create `public.time_attack_scores` with the five version 1 columns
   (`id bigint generated always as identity primary key`, `run_id uuid not null unique`, `name text not null`,
   `score integer not null`, `created_at timestamptz not null default now()`), then insert rows with extra spaces,
   a tab, an Arabic name, and two names that differ only in case. `tests/db/migration/names.sql` has examples.
3. Run `check_before_upgrade.sql`, then the backup, then `leaderboard.sql`, then the checks in "Existing project".
4. Run `rollback_v2.sql`, confirm every player is in `players_v2_saved`, then upgrade again.
5. Point a copy of the game at that project (change `CONFIG.url` and `CONFIG.anonKey` in a local build only, never in
   the repository) and play a ranked round. Then delete the test project.

## What is and is not protected

- The database checks the shape and range of every value: names, codes, scores 0 to 1000, the exact ranked rule,
  and one row per player. It cannot check that a run really happened.
- **The results are not cheat-proof.** A modified browser can send any score it likes, and the server cannot replay a
  run. Stopping that needs a trusted replay of each run on a server, which this version does not do.
- Anyone with a recovery code can post as that player. Keep codes private.
- There is no rate limit on registration or submissions. Add one in Supabase if the board is abused.
- Names are not checked for offensive words. Anyone can register a name first, and nobody can take it back except the owner.
- Names and scores on the board are public. Codes and internal ids are never returned.
- The rank query is an index range scan, not a download of the board. It stays fast for large boards, but it is
  not free: for very large boards, consider caching the rank.

## Atherbyte account link (`account_link.sql`)

Links a Grid Snake player to an Atherbyte account, keeps a copy of the player's device progress, and lets ranked scores
reach the board through the Atherbyte API (the Worker) instead of the browser. **Not applied to the live project yet.**

- Adds `players.account_id` and `players.linked_at`, and the tables `player_saves`, `player_save_history` (the 20 most
  recent replaced copies per player) and `player_link_log`. Existing rows, ids, names, codes and scores are not changed.
- Adds `gs_link_player`, `gs_account_player`, `gs_save` and `gs_submit_best`, callable by `service_role` only (the Worker).
  `register_player`, `submit_best`, `get_me`, `get_top` and their privileges are not touched.
- Linking needs a valid Atherbyte session (checked by the Worker, which passes the account id from the verified token)
  **and** the player's recovery code (checked here, by hash). One player per account; a linked player cannot move to
  another account. Unclaimed legacy names have no code, so they cannot be linked.
- A save carries the version it was based on. If another device saved in between, nothing is written (`conflict`).
- `rollback_account_link.sql` undoes it without deleting anything: links are copied to `gs_rolledback.players_account_link`
  and the save tables move to the `gs_rolledback` schema.

Checks: `tests/db/account_link.sql` (run by `tests/db/run.sh`, or without a Postgres server:
`npm install --no-save @electric-sql/pglite@0.2.17 && node tests/db/pglite-run.mjs`).

### Going live: owner steps, in this order (nothing here has been done for you)

1. **Back up the database** (nothing below can be undone without it):
   - Table Editor > `players` > **Export > CSV**. Do the same for `profiles` and `time_attack_scores_legacy`. Keep the files
     offline: `players` holds recovery-code hashes.
   - Or, with the connection string from Project Settings > Database (needs the database password):
     `pg_dump "<connection string>" --schema=public --no-owner -f atherbyte-public-backup.sql`
2. **Back up your own game progress** on each device you play on: Profile > Backup and restore > copy the `GS2.` code, and
   Profile > Show recovery code. Keep both somewhere safe. (Linking also keeps a backup on the device by itself, but
   only for the device it runs on.)
3. **Close direct profile creation** (atherbyte-api repository): run `migrations/000_owner_readonly_checks.sql` (read-only)
   and look at check 10. If `can_insert` or `can_update` is `true`, or an INSERT/UPDATE policy exists on `profiles`, apply
   `migrations/001_profiles_hardening.DRAFT.sql` first (it only removes browser writes; the Worker keeps working). If check
   10a lists any trigger on `auth.users`, **stop** and review it before going on: such a trigger could give a user who
   signed up directly in Supabase a profile, and 001 does not block it.
4. **Apply `account_link.sql`** in the SQL Editor (one transaction: it either applies fully or changes nothing). Then check:
   `select count(*) from public.players;` gives the same count as before (24), and
   `select has_function_privilege('anon', 'public.gs_link_player(uuid, text)', 'execute');` gives `false`.
   Then `account_name.sql`.
5. **Ranked rounds, part A (`score_rounds.sql`)**: additive only (a table and two Worker-only functions). The Worker
   that is live keeps working after it. Check: `tests/db/score_rounds.sql`.
6. **Publish the game's `index.html` FIRST.** It works with both Workers: while the live Worker has no
   `/v1/games/grid-snake/round` (it answers `404 not_found`), the page sends scores the old way, exactly as today; once
   the new Worker is live, every run gets a round. Check a Time Attack round still counts. Then **wait at least 15
   minutes**: GitHub Pages sends `Cache-Control: max-age=600`, so for 10 minutes some visitors may still get the old page.
7. **Deploy the Worker** (atherbyte-api, branch `feature/grid-snake-link`). `GET /v1/games/grid-snake/player` without a
   token must answer `401`, and `POST /v1/games/grid-snake/round` without a token `401` (not `404`). From now on a score
   needs a round. What can still be lost: a run that started before this switch and ends after it (the page says "The
   board was updated during this run…"), and scores from a tab opened before step 6 and never reloaded (the old page
   says "That name or code is not valid.").
8. **Ranked rounds, part B (`score_rounds_finalize.sql`)**: only after step 7 works, take away the Worker's right to the
   unchecked `gs_submit_best`. One privilege, no data. Applied before step 7, it would break every score (502).

To undo the rounds only: redeploy the previous Worker, then run
`rollback_score_rounds.sql` (gives `gs_submit_best` back to the Worker, removes the two round functions, moves the rounds
table with every row to `gs_rolledback`; players, scores, codes and links are not touched). Never use
`rollback_account_link.sql` for this: it refuses to run while rounds exist, and it would unlink every account.

What can and cannot be undone: parts A and B and the rollback change no player, score or link. The scores counted while
rounds were live stay counted (a best only goes up). The ranked-round time limit (`score_rounds.sql` header) is a
plausibility filter, not anti-cheat.
