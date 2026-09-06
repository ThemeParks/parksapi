/**
 * Catalogue of cache keys that hold persistent operational state rather than
 * cached upstream data.
 *
 * The cache stores two different kinds of thing under one namespace. Most of
 * it is a copy of an upstream response: disposable, and re-fetchable at the
 * cost of one request. A little of it is a record of what we have OBSERVED
 * over time, which no request can rebuild. Flushing the first is routine.
 * Flushing the second changes what we publish.
 *
 * A flush means "re-fetch from upstream". It must never also mean "forget what
 * we have observed", so the clear paths in cache.ts step over any key carrying
 * a fragment listed here. Callers that genuinely want a destination reset
 * rather than a re-fetch pass `includePersistent`.
 *
 * Fragments are matched anywhere in the key, so a per-park or per-id segment
 * in the middle is fine. Kept in their own module, rather than in cache.ts, so
 * a generic cache does not have to name domain concepts, and out of the
 * package entry point so they stay internal.
 */

/**
 * Whether an entity id has ever been seen live, plus the degraded-feed guard
 * beside it. Only ever gains entries for ids PRESENT in the current feed, so
 * losing it leaves an already-absent id unretireable for good and freezes its
 * stale published row. See Destination.applyLiveEntityRetirement.
 */
export const LIVE_ENTITY_RETIREMENT_FRAGMENT = ':liveEntityRetirement';

/**
 * Every fragment marking persistent state.
 *
 * Frozen because `as const` is compile-time only: without it a JavaScript
 * consumer of the built package could push onto the live array and change
 * what every future flush protects.
 *
 * Add to this list when adding state whose loss changes what we publish, or
 * costs someone other than us, rather than merely costing a fetch.
 */
export const PERSISTENT_KEY_FRAGMENTS = Object.freeze([
  LIVE_ENTITY_RETIREMENT_FRAGMENT,

  // Which DLP attractions bear a queue. The wait feed falls silent after park
  // close, so rebuilding from it then classifies roughly a hundred rides as
  // walkthroughs and publishes them with no `queue` object at all: STANDBY and
  // SINGLE_RIDER vanish until the feed wakes the next morning.
  ':dlp:queueBearingHistory',

  // Which DLP attractions have recently advertised a single-rider line. Milder
  // sibling of the above: SINGLE_RIDER drops off rides not currently
  // advertising it, until re-observed.
  ':dlp:singleRiderRecent',

  // Fantawild's never-shrink roster baseline. Lose it inside the upstream
  // overnight prune window and the shrunken roster becomes the new baseline,
  // which truncates buildEntityList — entity deletion downstream, not a frozen
  // row.
  ':roster:v1:',

  // Whether a Fantawild park has ever reported a real wait. Write-once by
  // design; losing it re-suppresses live waits until one is next seen.
  ':liveWaitsObserved:v1:',

  // Long-lived upstream refresh tokens. Losing one is self-healing for us and
  // not free for the operator: a park whose auth mints a fresh anonymous
  // account per sign-up gets a permanent extra account every time we flush.
  ':refreshToken',
] as const);

/**
 * SQL `AND` clauses and bound parameters that exclude persistent keys from a
 * DELETE or eviction SELECT.
 *
 * Returns clauses only, so the caller composes them into its own statement.
 * The patterns are built with an explicit ESCAPE: `_` is a single-character
 * wildcard in SQL LIKE, so an unescaped fragment would protect more than it
 * names. An empty fragment is skipped rather than expanded to `%%`, which
 * matches every key and would silently turn the whole DELETE into a no-op.
 */
export function persistentKeyExclusion(): {clauses: string[], params: string[]} {
  const clauses: string[] = [];
  const params: string[] = [];
  for (const fragment of PERSISTENT_KEY_FRAGMENTS) {
    if (!fragment) continue;
    clauses.push("key NOT LIKE ? ESCAPE '\\'");
    params.push(`%${fragment.replace(/[\\%_]/g, '\\$&')}%`);
  }
  return {clauses, params};
}
