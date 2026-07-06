/**
 * Plopsa decision-logic regression tests.
 *
 * The full decision matrix for whether a ride emits OPERATING vs CLOSED.
 * The interesting case is row 3: a numeric wait time + a stale
 * `temporarily_closed: true` from POI must NOT downgrade to CLOSED, or
 * multi-collector deployments will flap any ride whose POI snapshot
 * disagrees between instances.
 */
import {describe, test, expect} from 'vitest';
import {plopsaDecideOperating, Plopsaland} from '../plopsa.js';

describe('plopsaDecideOperating', () => {
  test('park closed → ride always CLOSED regardless of other inputs', () => {
    expect(plopsaDecideOperating(false, false, false)).toBe(false);
    expect(plopsaDecideOperating(false, false, true)).toBe(false);
    expect(plopsaDecideOperating(false, true,  false)).toBe(false);
    expect(plopsaDecideOperating(false, true,  true)).toBe(false);
  });

  test('park open + ride open + has wait → OPERATING', () => {
    expect(plopsaDecideOperating(true, false, true)).toBe(true);
  });

  test('park open + ride open + no wait → OPERATING (e.g. brand-new ride before first reading)', () => {
    expect(plopsaDecideOperating(true, false, false)).toBe(true);
  });

  test('park open + POI says temp-closed + has wait → OPERATING (wait-times feed wins over stale POI hint)', () => {
    // This is the case the bug report depends on: stale POI says closed,
    // but the wait-times feed has a real number. Trust the live number.
    expect(plopsaDecideOperating(true, true, true)).toBe(true);
  });

  test('park open + POI says temp-closed + no wait → CLOSED (the hint is authoritative when no live signal)', () => {
    expect(plopsaDecideOperating(true, true, false)).toBe(false);
  });
});

describe('De Panne POI location lookup', () => {
  // Expose the protected lookup + allow overriding the snapshot for the
  // normalization tests, without a full destination lifecycle.
  class Probe extends Plopsaland {
    public withLocations(
      m: Record<string, {latitude: number; longitude: number}>,
    ): this {
      (this as any).poiLocations = m;
      (this as any).normalizedPoiLocations = undefined; // force lazy rebuild
      return this;
    }
    public lookup(title: string) {
      return (this as any).lookupPoiLocation(title) as
        | {latitude: number; longitude: number}
        | undefined;
    }
  }

  test('resolves a known ride from the bundled snapshot', () => {
    // The real snapshot is assigned in the constructor; Anubis is hand-pinned.
    const loc = new Probe().lookup('Anubis The Ride');
    expect(loc).toBeDefined();
    expect(typeof loc!.latitude).toBe('number');
    expect(typeof loc!.longitude).toBe('number');
  });

  test('folds curly/straight apostrophes and is case-insensitive', () => {
    const p = new Probe().withLocations({
      "Vic's Whirlwind": {latitude: 51.08, longitude: 2.59},
    });
    // Feed emits a curly apostrophe; snapshot key uses a straight one.
    expect(p.lookup('Vic’s Whirlwind')).toEqual({latitude: 51.08, longitude: 2.59});
    // Case differences still match.
    expect(p.lookup("vic's whirlwind")).toEqual({latitude: 51.08, longitude: 2.59});
  });

  test('returns undefined for an unknown title', () => {
    expect(new Probe().lookup('Nonexistent Ride')).toBeUndefined();
  });
});
