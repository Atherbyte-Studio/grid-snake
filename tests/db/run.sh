#!/usr/bin/env bash
# Checks the global board's database side against a scratch Postgres (version 16 or newer).
# Usage: PGHOST=/path/to/socket PGPORT=5432 PGUSER=postgres tests/db/run.sh
set -euo pipefail
cd "$(dirname "$0")"
DB="gs_check_$$"
P=(psql -X -q -v ON_ERROR_STOP=1)
"${P[@]}" -d postgres -c "create database $DB"
trap '"${P[@]}" -d postgres -c "drop database if exists $DB" >/dev/null' EXIT
if ! "${P[@]}" -d "$DB" -f leaderboard_v2.sql >"$DB.log" 2>&1; then
  grep -E 'FAILED|ERROR' "$DB.log" | head -5; rm -f "$DB.log"; echo "FAILED: schema checks stopped"; exit 1
fi
grep -c 'NOTICE:  ok:' "$DB.log" | sed 's/^/schema checks passed: /'; rm -f "$DB.log"

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
  "${P[@]}" -d "$DB" -tA -c "select register_player('Clash', '$code')->>'status'" >>"$DB.out" &
done
wait
ok=$(grep -c '^ok$' "$DB.out" || true); taken=$(grep -c '^taken$' "$DB.out" || true); rm -f "$DB.out"
[ "$ok" = "1" ] && [ "$taken" = "9" ] && echo "ok: one winner for a contested name (1 ok, 9 taken)" || { echo "FAILED: $ok ok, $taken taken"; exit 1; }
echo "all database checks passed"
