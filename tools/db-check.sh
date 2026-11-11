#!/usr/bin/env bash
# Applies every migration, in order and twice, to a throwaway local Postgres.
# Catches SQL that doesn't run on a fresh database or can't be re-run. Needs Postgres 15+ installed (initdb, pg_ctl, psql).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"; [ -n "$BIN" ] && export PATH="$BIN:$PATH"
D="$(mktemp -d)"; PORT=55432
cleanup(){ pg_ctl -D "$D/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$D"; }
trap cleanup EXIT
if [ "$(id -u)" = 0 ]; then chown -R postgres "$D"; RUN="runuser -u postgres --"; else RUN=""; fi
$RUN initdb -D "$D/data" -U postgres -A trust >/dev/null
$RUN pg_ctl -D "$D/data" -o "-p $PORT -k $D -c listen_addresses=''" -l "$D/log" start -w >/dev/null
q(){ psql -h "$D" -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@" < /dev/null; }
q -f "$ROOT/supabase/local/supabase-stubs.sql"
for pass in 1 2; do
  for f in "$ROOT"/supabase/migrations/*.sql; do
    case "$f" in *push-lessons*) echo "skip $(basename "$f") (needs pg_cron/pg_net, Supabase only)"; continue;; esac
    q -f "$f" >/dev/null 2>"$D/err" || { echo "FAILED on pass $pass: $(basename "$f")"; cat "$D/err"; exit 1; }
  done
  echo "pass $pass: all migrations applied"
done
q -c "select count(*) as tables from information_schema.tables where table_schema='public'"
