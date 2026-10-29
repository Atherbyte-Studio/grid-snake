#!/usr/bin/env bash
# Checks the global board's database side against a scratch Postgres (version 16 or newer).
# Usage: PGHOST=/path/to/socket PGPORT=5432 PGUSER=postgres tests/db/run.sh
set -euo pipefail
cd "$(dirname "$0")"
DB="gs_check_$$"
LOG="$(mktemp)"; OUT="$(mktemp)"
DBS=()
P=(psql -X -q -v ON_ERROR_STOP=1)
# One cleanup for everything this run creates: scratch databases and temporary files.
cleanup() {
  for d in "${DBS[@]:-}"; do [ -n "$d" ] && "${P[@]}" -d postgres -c "drop database if exists $d" >/dev/null 2>&1 || true; done
  rm -f "$LOG" "$OUT"
}
trap cleanup EXIT
new_db() { DBS+=("$1"); "${P[@]}" -d postgres -c "create database $1" >/dev/null; }
new_db "$DB"
if ! "${P[@]}" -d "$DB" -f leaderboard_v2.sql >"$LOG" 2>&1; then
  grep -E 'FAILED|ERROR' "$LOG" | head -5; echo "FAILED: schema checks stopped"; exit 1
fi
grep -c 'NOTICE:  ok:' "$LOG" | sed 's/^/schema checks passed: /'

# Concurrency: many submissions at once must leave one row and the highest score.
"${P[@]}" -d "$DB" -c "select register_player('Racer', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')" >/dev/null
for i in $(seq 1 30); do
  s=$(( (i * 37) % 700 + 10 ))
  "${P[@]}" -d "$DB" -c "select submit_best('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', $s, true, true, 'hard')" >/dev/null &
done
"${P[@]}" -d "$DB" -c "select submit_best('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 5, true, true, 'hard')" >/dev/null &
wait
best=$("${P[@]}" -d "$DB" -tA -c "select best_score from players where name = 'Racer'")
rows=$("${P[@]}" -d "$DB" -tA -c "select count(*) from players where lower(name) = 'racer'")
expect=$(( 0 ))
for i in $(seq 1 30); do s=$(( (i * 37) % 700 + 10 )); [ $s -gt $expect ] && expect=$s; done
[ "$best" = "$expect" ] && echo "ok: concurrent submissions keep the highest score ($best)" || { echo "FAILED: concurrent best $best, expected $expect"; exit 1; }
[ "$rows" = "1" ] && echo "ok: concurrent submissions leave one row" || { echo "FAILED: $rows rows"; exit 1; }

# Concurrency: the same name registered by many people at once gives exactly one winner.
for i in $(seq 1 10); do
  code=$(printf '%032x' $i)
  "${P[@]}" -d "$DB" -tA -c "select register_player('Clash', '$code')->>'status'" >>"$OUT" &
done
wait
ok=$(grep -c '^ok$' "$OUT" || true); taken=$(grep -c '^taken$' "$OUT" || true); : > "$OUT"
[ "$ok" = "1" ] && [ "$taken" = "9" ] && echo "ok: one winner for a contested name (1 ok, 9 taken)" || { echo "FAILED: $ok ok, $taken taken"; exit 1; }
# ---- migration cases: each one in its own scratch database (tests/db/migration/*.sql)
mig=migration
db="gs_case_names_$$"; new_db "$db"
"${P[@]}" -d "$db" -f "$mig/names.sql" >"$LOG" 2>&1 || { echo "FAILED: names case"; grep -E 'ERROR|assert' "$LOG" | head -5; exit 1; }
for note in 'ok: migration keeps the policy' 'ok: re-running after the migration' 'ok: registration normalises'; do
  grep -q "$note" "$LOG" || { echo "FAILED: names case did not reach: $note"; exit 1; }
done
echo "ok: names, ties, Arabic, skipped rows, re-run, and registration normalisation"

stop_case() {  # name expected-kind: the file must stop with STOP, and the tables must be left as they were
  local c="$1"; db="gs_case_stop_$$_$c"; new_db "$db"
  if "${P[@]}" -d "$db" -f "$mig/stop_$c.sql" >"$LOG" 2>&1; then echo "FAILED: stop_$c did not stop"; exit 1; fi
  grep -q 'STOP:' "$LOG" || { echo "FAILED: stop_$c failed for another reason"; grep ERROR "$LOG" | head -3; exit 1; }
}
stop_case shape
[ "$("${P[@]}" -d "gs_case_stop_$$_shape" -tA -c "select count(*) from time_attack_scores")" = "1" ] || { echo "FAILED: shape case changed the table"; exit 1; }
echo "ok: an unexpected shape stops the migration and nothing is moved"
stop_case both
[ "$("${P[@]}" -d "gs_case_stop_$$_both" -tA -c "select count(*) from time_attack_scores")" = "1" ] || { echo "FAILED: both case changed the table"; exit 1; }
echo "ok: both tables present stops the migration and nothing is moved"
stop_case future
future_ok=$("${P[@]}" -d "gs_case_stop_$$_future" -tA -c "select count(*) from time_attack_scores where name = 'Future'")
legacy_ok=$("${P[@]}" -d "gs_case_stop_$$_future" -tA -c "select count(*) from time_attack_scores_legacy")
[ "$future_ok" = "1" ] && [ "$legacy_ok" = "2" ] || { echo "FAILED: a future table with the old name was moved"; exit 1; }
echo "ok: a future table with the old name is not moved"

db="gs_case_rollback_$$"; new_db "$db"
"${P[@]}" -d "$db" -f "$mig/rollback_cycle.sql" >"$LOG" 2>&1 || { echo "FAILED: rollback cycle"; grep -E 'ERROR|assert' "$LOG" | head -5; exit 1; }
grep -q 'ok: rollback renames' "$LOG" && grep -q 'ok: rollback then upgrade' "$LOG" || { echo "FAILED: rollback notices missing"; exit 1; }
echo "ok: rollback keeps every player, and a second upgrade works"

db="gs_privileges_$$"; new_db "$db"
"${P[@]}" -d "$db" -f privileges.sql >"$LOG" 2>&1 || { echo "FAILED: privileges"; grep -E 'ERROR|assert' "$LOG" | head -6; exit 1; }
grep -q 'ok: privileges as designed' "$LOG" || { echo "FAILED: privileges notice missing"; exit 1; }
echo "ok: anon and authenticated: four game functions only, internal functions and the table refused"

# ---- account link (account_link.sql and its rollback)
db="gs_account_link_$$"; new_db "$db"
"${P[@]}" -d "$db" -f account_link.sql >"$LOG" 2>&1 || { echo "FAILED: account link"; grep -E 'FAILED|ERROR' "$LOG" | head -5; exit 1; }
grep -q 'ok: reapply: linking works again' "$LOG" || { echo "FAILED: account link notices missing"; exit 1; }
grep -c 'NOTICE:  ok:' "$LOG" | sed 's/^/account link checks passed: /'

# Concurrency: two accounts and two players, linked in every combination at once: never one account with two players.
"${P[@]}" -d "$db" -c "insert into auth.users values ('66666666-6666-4666-8666-666666666666'), ('77777777-7777-4777-8777-777777777777')" >/dev/null
"${P[@]}" -d "$db" -c "select register_player('Race1', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'), register_player('Race2', 'ffffffffffffffffffffffffffffffff')" >/dev/null
for a in 66666666-6666-4666-8666-666666666666 77777777-7777-4777-8777-777777777777; do
  for s in eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee ffffffffffffffffffffffffffffffff; do
    for i in 1 2 3; do "${P[@]}" -d "$db" -c "select gs_link_player('$a', '$s')" >/dev/null & done
  done
done
wait
pairs=$("${P[@]}" -d "$db" -tA -c "select count(*) from players where name in ('Race1', 'Race2') and account_id is not null")
dup=$("${P[@]}" -d "$db" -tA -c "select count(*) from (select account_id from players where account_id is not null group by account_id having count(*) > 1) d")
[ "$dup" = "0" ] && [ "$pairs" -ge 1 ] && echo "ok: parallel links never give one account two players ($pairs linked)" || { echo "FAILED: parallel links ($pairs linked, $dup duplicated)"; exit 1; }

# ---- ranked rounds (score_rounds.sql)
db="gs_score_rounds_$$"; new_db "$db"
"${P[@]}" -d "$db" -f score_rounds.sql >"$LOG" 2>&1 || { echo "FAILED: score rounds"; grep -E 'FAILED|ERROR' "$LOG" | head -5; exit 1; }
grep -c 'NOTICE:  ok:' "$LOG" | sed 's/^/score round checks passed: /'
# Concurrency: the same round submitted many times at once is counted exactly once.
"${P[@]}" -d "$db" -c "update player_rounds set status = 'abandoned' where status = 'open'" >/dev/null
rid=$("${P[@]}" -d "$db" -tA -c "select gs_start_round('11111111-1111-4111-8111-111111111111')->>'round'")
"${P[@]}" -d "$db" -c "update player_rounds set started_at = now() - interval '50 seconds' where id = '$rid'" >/dev/null
for i in $(seq 1 10); do "${P[@]}" -d "$db" -tA -c "select gs_submit_round('11111111-1111-4111-8111-111111111111', '$rid', $((100 + i)), true, true, 'hard')->>'status'" >>"$OUT" & done
wait
counted=$(grep -cE '^(improved|kept)$' "$OUT" || true); : > "$OUT"
[ "$counted" = "1" ] && echo "ok: a round submitted 10 times at once counts once" || { echo "FAILED: a round counted $counted times"; exit 1; }

# ---- replayed scores (score_replay.sql)
db="gs_score_replay_$$"; new_db "$db"
"${P[@]}" -d "$db" -f score_replay.sql >"$LOG" 2>&1 || { echo "FAILED: score replay"; grep -E 'FAILED|ERROR' "$LOG" | head -5; exit 1; }
grep -c 'NOTICE:  ok:' "$LOG" | sed 's/^/score replay checks passed: /'
# Concurrency: one replayed round submitted 10 times at once counts once; a reject racing the submits never counts twice.
rid=$("${P[@]}" -d "$db" -tA -c "select gs_start_round('11111111-1111-4111-8111-111111111111')->>'round'")
"${P[@]}" -d "$db" -c "update player_rounds set started_at = now() - interval '61 seconds' where id = '$rid'" >/dev/null
for i in $(seq 1 10); do "${P[@]}" -d "$db" -tA -c "select gs_submit_replay('11111111-1111-4111-8111-111111111111', '$rid', $((100 + i)), 60000)->>'status'" >>"$OUT" & done
"${P[@]}" -d "$db" -tA -c "select gs_reject_round('11111111-1111-4111-8111-111111111111', '$rid')->>'status'" >>"$OUT" &
wait
counted=$(grep -cE '^(improved|kept)$' "$OUT" || true); closed=$(grep -c '^closed$' "$OUT" || true); : > "$OUT"
[ $((counted + closed)) = "1" ] && echo "ok: a replayed round sent 10 times at once (and rejected once) ends exactly once" || { echo "FAILED: counted $counted, closed $closed"; exit 1; }

echo "all database checks passed"
