/**
 * Cross-check that an entity list claims each id exactly once.
 *
 * Deliberately dependency-free, for the same reasons as orphanCheck: the
 * collector can assert the invariant on the push path rather than only when
 * someone runs the harness, and the unit tests stay clear of the HTTP queue
 * and the SQLite cache.
 *
 * A duplicate id is not a reporting curiosity like an orphan row. Two entities
 * under one id means one of them is silently discarded downstream, and the
 * loss is invisible: Walibi Holland published `Walibi Express Station 1` and
 * `Station 2` under a single CMS wait-time id for as long as that feed has
 * been read, and Station 2 has never existed on the wiki as a result.
 */

/** A repeated id, with the names competing for it in emission order. */
export type DuplicateEntityId = {
  id: string;
  /** Every entity claiming this id, in the order getEntities() emitted them. */
  names: string[];
  /** How many entities claim it — always >= 2. */
  count: number;
};

/**
 * Ids claimed by more than one entity, in first-seen order.
 *
 * Entities without an id are skipped rather than grouped together under
 * `undefined`: a missing id is a different defect, and the harness already
 * fails on it separately.
 */
export function findDuplicateEntityIds(
  entities: Array<{id?: string; name?: unknown}>,
): DuplicateEntityId[] {
  const seen = new Map<string, string[]>();

  for (const entity of entities) {
    if (!entity?.id) continue;
    const names = seen.get(entity.id);
    const name = nameToString(entity.name);
    if (names) {
      names.push(name);
    } else {
      seen.set(entity.id, [name]);
    }
  }

  const duplicates: DuplicateEntityId[] = [];
  for (const [id, names] of seen) {
    if (names.length > 1) duplicates.push({id, names, count: names.length});
  }
  return duplicates;
}

/**
 * A name for the report. Entity names are `LocalisedString`, so they are
 * either a plain string or a language-keyed object; anything else is a defect
 * the harness reports on its own terms, and here it just needs to not throw.
 */
function nameToString(name: unknown): string {
  if (typeof name === 'string') return name;
  if (name && typeof name === 'object') {
    const first = Object.values(name as Record<string, unknown>).find(
      (v) => typeof v === 'string',
    );
    if (typeof first === 'string') return first;
  }
  return '(unnamed)';
}

/** One-line summary for an error or a log line. */
export function describeDuplicateEntityIds(duplicates: DuplicateEntityId[]): string {
  return duplicates
    .map((d) => `"${d.id}" claimed by ${d.count}: ${d.names.map((n) => `"${n}"`).join(', ')}`)
    .join('; ');
}
