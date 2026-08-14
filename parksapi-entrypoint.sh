#!/bin/sh
set -e

# Report an unwritable bind mount here rather than letting tsx fail with a
# missing .env three commands later. Runs on every start, not just the first.
probe=/app/.parksapi-write-probe
if ! (touch "$probe" && rm -f "$probe") 2>/dev/null; then
  echo "✗ cannot write to /app as uid $(id -u):$(id -g)" >&2
  echo "  The source tree is bind-mounted from a host user this container is not mapped to." >&2
  echo "  Docker: use make, or pass --user \"\$(id -u):\$(id -g)\"" >&2
  echo "  Podman: make COMPOSE=\"podman-compose --env-file /dev/null --podman-run-args=--userns=keep-id:uid=$(id -u),gid=$(id -g)\" …" >&2
  exit 1
fi

# Every npm script runs `tsx --env-file=.env`, which aborts if the file is
# missing. An empty .env is valid: all @config props default to empty strings.
[ -f /app/.env ] || touch /app/.env

# The bind mount shadows the image's node_modules, so this is the real install
# path. The stamp makes a lockfile change reinstall instead of going unnoticed.
ensure_deps() {
  dir="$1"
  stamp="$dir/node_modules/.parksapi-deps"
  want=$(sha256sum "$dir/package-lock.json" | cut -d' ' -f1)
  if [ "${PARKSAPI_FORCE_DEPS:-}" != "1" ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then
    return 0
  fi
  echo "→ installing dependencies in $dir…" >&2
  (cd "$dir" && npm ci --ignore-scripts)
  echo "$want" > "$stamp"
}

ensure_deps /app
if [ "${ENSURE_WEB_UI:-}" = "1" ]; then
  ensure_deps /app/web-ui
fi

exec "$@"
