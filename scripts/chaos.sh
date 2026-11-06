#!/usr/bin/env bash
# Usage: ./scripts/chaos.sh [rounds]  - SIGKILLs the app at random intervals
set -euo pipefail
rounds="${1:-4}"
for i in $(seq 1 "$rounds"); do
  sleep $(( RANDOM % 20 + 15 ))
  echo "[chaos] round $i/$rounds: SIGKILL app"
  docker compose kill -s SIGKILL app
  sleep 3
  docker compose start app
done
echo "[chaos] done"
