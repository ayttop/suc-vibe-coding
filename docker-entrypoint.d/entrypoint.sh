#!/bin/sh
# Run every *.sh script under /app/docker-entrypoint.d (sorted) before exec'ing
# the main container command. Each helper script gets the full env of the
# container and is responsible for its own error handling.
set -eu

for script in /app/docker-entrypoint.d/*.sh; do
  case "$script" in
    *entrypoint.sh) continue ;;
  esac
  if [ -x "$script" ]; then
    echo "[entrypoint] running $(basename "$script")"
    "$script"
  fi
done

exec "$@"
