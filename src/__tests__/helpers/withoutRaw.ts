/**
 * A deep copy of `value` with every `raw` field removed.
 *
 * Builders and module-level helpers always attach their raw upstream pieces;
 * the public getters strip them unless `includeRaw` is on. A test that calls a
 * builder or helper directly, and is about something other than those pieces,
 * compares through this so the pieces do not have to be spelled out.
 */
export function withoutRaw<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => withoutRaw(item)) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key !== 'raw') out[key] = withoutRaw(item);
    }
    return out as T;
  }
  return value;
}
