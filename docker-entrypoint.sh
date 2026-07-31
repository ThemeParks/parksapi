#!/bin/sh
set -e

# Every npm script runs `tsx --env-file=.env`, which aborts if the file is
# missing. An empty .env is a valid configuration (all @config props default
# to empty strings), so create it when absent — this is the `touch .env` step.
[ -f /app/.env ] || : > /app/.env

# When the source tree is bind-mounted, node_modules comes from a named volume
# that may still be empty on the very first run.
if [ ! -d /app/node_modules/tsx ]; then
  echo "→ node_modules empty, running npm ci…"
  npm ci --ignore-scripts
fi

exec "$@"
