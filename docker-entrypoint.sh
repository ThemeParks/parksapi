#!/bin/sh
set -e

# Every npm script runs `tsx --env-file=.env`, which aborts if the file is
# missing. An empty .env is a valid configuration (all @config props default
# to empty strings), so create it when absent — this is the `touch .env` step.
#
# Failing here means the bind-mounted tree is not writable by this container's
# uid, which is what rootless Podman does without --userns=keep-id. Say so
# rather than letting tsx report a missing file three commands later.
# (touch, not `: > file`: a failed redirection on a special builtin kills the
# whole script in dash, before this check can report anything.)
if [ ! -f /app/.env ] && ! (touch /app/.env) 2>/dev/null; then
  echo "✗ cannot write to /app as uid $(id -u): the source tree is mounted from" >&2
  echo "  a host user this container is not mapped to." >&2
  echo "  Podman: make COMPOSE=\"podman-compose --podman-run-args=--userns=keep-id\" …" >&2
  exit 1
fi

# When the source tree is bind-mounted, node_modules comes from a named volume
# that may still be empty on the very first run.
if [ ! -d /app/node_modules/tsx ]; then
  echo "→ node_modules empty, running npm ci…"
  npm ci --ignore-scripts
fi

exec "$@"
