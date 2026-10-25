# Grid Snake global leaderboard: setup

The game reads and writes the Time Attack board through Supabase's REST API. Nothing here needs a server
you run yourself. The code is in place, but the board is **not live** until you finish these steps.

## 1. Create the project
1. Go to https://supabase.com, sign in, and choose **New project**.
2. Pick a name and a database password (keep the password somewhere safe), then create it.

## 2. Create the table
1. In the project, open **SQL Editor > New query**.
2. Paste the whole of `supabase/leaderboard.sql` and press **Run**.
3. Check that **Table Editor** now lists `time_attack_scores`.

## 3. Copy the two public values
1. Open **Project Settings > API** (sometimes under **Data API**).
2. Copy the **Project URL** (looks like `https://xxxx.supabase.co`).
3. Copy the **anon / public** key. Do **not** copy the `service_role` key. It must never go in the game.

## 4. Put the values in the game
Edit `src/leaderboard.js` and fill the two empty strings in `CONFIG`:

    url: 'https://xxxx.supabase.co',
    anonKey: 'eyJ...your anon key...',

Then run `node build.js` and commit. The anon key is designed to be public, and row-level security is what
protects the table. The `service_role` key must stay out of the repository.

## 5. Test it
1. Open the deployed page, play one Time Attack run, and press **Post to the global board**.
2. Open **Global board** from the home screen. The run should appear at the right rank.
3. You can also check **Table Editor** in Supabase.

## What is and is not protected
- Rows are checked for shape and range: name length, allowed characters, score 0 to 1000, and one row per run.
- Anyone who reads the game's code can send a made-up score. This is not cheat-proof. Stopping that needs a
  trusted Supabase Edge Function that verifies a run, which is a separate project.
- REST inserts are not rate-limited by default. If someone floods the table, add a Supabase rate limit or
  move inserts behind an Edge Function.
