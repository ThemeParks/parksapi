/**
 * @module
 * Find live rows the API is still serving that the park's own feed no longer
 * contains.
 *
 * The live-entity retirement gate (see Destination.retireMissingLiveEntities)
 * only tracks ids it has observed live, so an entity already frozen when the
 * gate first ran is invisible to it permanently. This module is the read-only
 * half of the reconciliation: it says what is stale, and closes nothing.
 *
 * Measured 2026-08-29: 636 rows across the fleet are served as OPERATING or
 * DOWN with a lastUpdated more than two days old, concentrated in seasonal
 * parks whose feeds drop attractions out of season.
 */

/** A live row the API is currently serving. */
export interface ServedRow {
  /** Remote GUID. */
  id: string;
  /** parksapi entity id, as published in the entity's externalId. */
  externalId?: string;
  name: string;
  entityType?: string;
  status?: string;
  lastUpdated?: string;
}

/** One row the feed no longer contains. */
export interface StaleRow {
  id: string;
  externalId: string;
  name: string;
  entityType: string;
  status: string;
  /** Whole hours since the row was last written. */
  ageHours: number;
}

export interface ReconcileOptions {
  /** Rows younger than this are ignored — a row mid-cycle is not stale. */
  minAgeHours?: number;
  /**
   * Entity types never reported. PARK is excluded by default: whether a park
   * should carry live data at all is an open product question
   * an open question, not a staleness bug.
   */
  excludeTypes?: string[];
}

export interface ReconcileResult {
  stale: StaleRow[];
  /** Live rows the API serves in a status that implies the entity is active. */
  servedLive: number;
  /** Rows the current build produced. */
  produced: number;
  /**
   * Set when the build looks too thin to trust. A feed that returns almost
   * nothing makes every row look retired, which is exactly how a bad poll
   * turns into a mass close. The caller must not act on `stale` when this is
   * set — the same reasoning as the retirement gate's degraded-feed guard.
   */
  degraded?: string;
}

/** Statuses that assert the entity is currently active. */
const ACTIVE = new Set(['OPERATING', 'DOWN']);

/**
 * Compare what the API serves against what the current build produced.
 *
 * @param produced   parksapi entity ids in this build's live data
 * @param served     live rows the API is currently serving
 * @param now        comparison instant, injected so results are deterministic
 */
export function reconcileLiveRows(
  produced: Iterable<string>,
  served: ServedRow[],
  now: Date,
  options: ReconcileOptions = {},
): ReconcileResult {
  const minAgeHours = options.minAgeHours ?? 48;
  const excludeTypes = new Set(options.excludeTypes ?? ['PARK']);
  const producedIds = new Set(produced);

  const active = served.filter(row => ACTIVE.has(row.status ?? ''));
  const stale: StaleRow[] = [];

  for (const row of active) {
    if (excludeTypes.has(row.entityType ?? '')) continue;
    // No externalId means nothing can be matched against the build, so the row
    // cannot be judged either way. Silently closing it would be a guess.
    if (!row.externalId) continue;
    if (producedIds.has(row.externalId)) continue;

    const written = row.lastUpdated ? Date.parse(row.lastUpdated) : NaN;
    if (!Number.isFinite(written)) continue;
    const ageHours = (now.getTime() - written) / 3_600_000;
    if (ageHours < minAgeHours) continue;

    stale.push({
      id: row.id,
      externalId: row.externalId,
      name: row.name,
      entityType: row.entityType ?? 'UNKNOWN',
      status: row.status ?? '',
      ageHours: Math.round(ageHours),
    });
  }

  stale.sort((a, b) => b.ageHours - a.ageHours);

  const result: ReconcileResult = {
    stale,
    servedLive: active.length,
    produced: producedIds.size,
  };

  // Guard, mirroring the retirement gate: a build that produced nothing, or a
  // fraction of what the API serves, is a broken poll rather than a park that
  // retired most of its attractions overnight.
  if (producedIds.size === 0 && active.length > 0) {
    result.degraded = 'build produced no live data at all';
  } else if (active.length >= 5 && producedIds.size < active.length / 2) {
    result.degraded = `build produced ${producedIds.size} rows against ${active.length} served — feed looks degraded`;
  }

  return result;
}
