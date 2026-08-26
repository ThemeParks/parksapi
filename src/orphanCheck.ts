/**
 * Cross-check that emitted rows are keyed to entities that actually exist.
 *
 * Deliberately dependency-free. It lives outside testRunner so the collector
 * can assert the same invariant on the push path, where orphan rows reach
 * consumers continuously, rather than only when someone runs the harness by
 * hand — and so its unit tests don't drag in the HTTP queue's interval timer
 * and the SQLite cache to exercise a pure function.
 */

/**
 * Distinct ids in `rows` that no published entity claims.
 *
 * Live data or schedules keyed to an id `getEntities()` never emits cannot be
 * looked up by a consumer, so they are dead weight in the output. Usually it
 * means a build path is reading a wider upstream feed than the entity list.
 *
 * Returns nothing when `publishedIds` is empty — that means the entity list
 * is unavailable, not that everything is an orphan, and reporting every row
 * would bury whatever real failure emptied it. One published id is a real
 * entity list and is checked normally.
 *
 * Does not modify `publishedIds`.
 */
export function findOrphanIds(
  rows: Array<{id?: string}>,
  publishedIds: ReadonlySet<string>,
): string[] {
  if (publishedIds.size === 0) return [];

  const orphans = new Set<string>();
  for (const row of rows) {
    if (row?.id && !publishedIds.has(row.id)) orphans.add(row.id);
  }
  return [...orphans];
}
