#!/usr/bin/env bash
# Usage: wait-for-boot.sh <container> <expected "Server listening" count>
# Passes once the container has logged "Server listening" that many times and
# /api/health answers; fails fast if the container stops, or after 120s.
set -euo pipefail
name="$1"
want="$2"
for i in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
    echo "::error::Container '$name' stopped during boot $want"
    docker logs "$name" 2>&1 | tail -80
    exit 1
  fi
  count=$(docker logs "$name" 2>&1 | grep -c "Server listening" || true)
  if [ "$count" -ge "$want" ] && curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo "Boot $want: Server listening and /api/health OK after ~$((i * 2))s"
    exit 0
  fi
  sleep 2
done
echo "::error::Boot $want did not reach 'Server listening' + healthy /api/health within 120s"
docker logs "$name" 2>&1 | tail -80
exit 1
