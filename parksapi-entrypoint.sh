#!/bin/sh
set -e

APP=/app
STAMP="$APP/node_modules/.parksapi-deps"
LOCK="$APP/.parksapi-deps.lock"
LOCK_STALE_MINUTES=30
LOCK_WAIT_SECONDS=1800

# Report an unwritable bind mount here rather than letting tsx fail with a
# missing .env three commands later. Runs on every start, not just the first.
probe="$APP/.parksapi-write-probe"
if ! (touch "$probe" && rm -f "$probe") 2>/dev/null; then
  echo "✗ cannot write to /app as uid $(id -u):$(id -g)" >&2
  echo "  Dependencies, .env and the SQLite cache are all written into the bind mount." >&2
  echo "  If the tree belongs to a different host user, run as that user:" >&2
  echo "    Docker: use make, or pass --user \"\$(id -u):\$(id -g)\"" >&2
  echo "    Podman: make COMPOSE=\"podman-compose --env-file /dev/null --podman-run-args=--userns=keep-id:uid=\$(id -u),gid=\$(id -g)\" …" >&2
  echo "  If it is mounted read-only, drop the :ro flag." >&2
  exit 1
fi

# Every npm script runs `tsx --env-file=.env`, which aborts if the file is
# missing. An empty .env is valid: all @config props default to empty strings.
[ -f "$APP/.env" ] || touch "$APP/.env"

# Unpiped, so a missing or unreadable lockfile fails here under `set -e`
# rather than reaching `npm ci` as an empty hash.
sum=$(sha256sum "$APP/package-lock.json")
want=${sum%% *}

# The bind mount shadows the image's node_modules, so this is the real install
# path. The stamp makes a lockfile change reinstall instead of going unnoticed.
#
# npm ci exits 0 when an optional dependency fails to fetch, so a matching
# stamp can still sit on a half-installed tree. tsx is what every npm script
# runs, so require it before trusting the stamp.
deps_current() {
  if [ "${PARKSAPI_FORCE_DEPS:-}" = "1" ]; then return 1; fi
  if [ ! -f "$STAMP" ]; then return 1; fi
  if [ "$(cat "$STAMP")" != "$want" ]; then return 1; fi
  if [ ! -x "$APP/node_modules/.bin/tsx" ]; then return 1; fi
  return 0
}

# npm ci deletes node_modules before unpacking, so two containers installing
# into the same bind mount corrupt each other's tree. mkdir is the atomic
# primitive a POSIX shell has; a lock left behind by a killed container is
# broken once it is older than LOCK_STALE_MINUTES.
acquire_lock() {
  waited=0
  announced=0
  while ! mkdir "$LOCK" 2>/dev/null; do
    if [ -n "$(find "$LOCK" -maxdepth 0 -mmin "+$LOCK_STALE_MINUTES" 2>/dev/null)" ]; then
      echo "→ breaking a dependency lock left behind by an earlier run" >&2
      rm -rf "$LOCK"
      continue
    fi
    if [ "$announced" = 0 ]; then
      echo "→ another container is installing dependencies, waiting…" >&2
      announced=1
    fi
    if [ "$waited" -ge "$LOCK_WAIT_SECONDS" ]; then
      echo "✗ timed out waiting for $LOCK" >&2
      echo "  Remove it if no other container is installing." >&2
      exit 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
}

if ! deps_current; then
  acquire_lock
  trap 'rm -rf "$LOCK"' EXIT INT TERM
  # Re-check: another container may have finished while we waited for the lock.
  if ! deps_current; then
    echo "→ installing dependencies…" >&2
    (cd "$APP" && npm ci --ignore-scripts)
    echo "$want" > "$STAMP"
  fi
  rm -rf "$LOCK"
  trap - EXIT INT TERM
fi

exec "$@"
