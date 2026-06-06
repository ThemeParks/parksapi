/**
 * Unit tests for Europa-Park pure helpers.
 *
 * The class itself is integration-tested via `npm run dev -- europapark`.
 * Pure logic is exercised here without network access.
 */
import {describe, test, expect} from 'vitest';
import {EuropaPark} from '../europapark.js';

const mkWait = (code: number, time = 0) => ({code, time});
const mkAttraction = (id: number, code: number) =>
  ({id: `pois_${id}`, name: `Attraction ${id}`, entityType: 'ATTRACTION', scopes: ['europapark'], code} as any);

// Sub-class to expose the protected glitch detector for testing.
class Probe extends EuropaPark {
  public probe(waits: any[], entities: any[]): boolean {
    return this._isWaitsGlitch(waits, entities);
  }
}

describe('_isWaitsGlitch', () => {
  const probe = new Probe();

  test('returns false when no coded attractions exist', () => {
    // Defensive: avoid divide-by-zero when the entity build returned nothing.
    expect(probe.probe([mkWait(1)], [])).toBe(false);
  });

  test('returns false on a typical operating-day mix (~45% of attractions in waits)', () => {
    const entities = Array.from({length: 100}, (_, i) => mkAttraction(i, i));
    const waits = Array.from({length: 45}, (_, i) => mkWait(i, 5 + (i % 30)));
    expect(probe.probe(waits, entities)).toBe(false);
  });

  test('returns false at the boundary (exactly 85%)', () => {
    // Strict > 0.85 — equal-to is treated as non-glitch.
    const entities = Array.from({length: 100}, (_, i) => mkAttraction(i, i));
    const waits = Array.from({length: 85}, (_, i) => mkWait(i, 0));
    expect(probe.probe(waits, entities)).toBe(false);
  });

  test('returns true just above the boundary (86%)', () => {
    const entities = Array.from({length: 100}, (_, i) => mkAttraction(i, i));
    const waits = Array.from({length: 86}, (_, i) => mkWait(i, 0));
    expect(probe.probe(waits, entities)).toBe(true);
  });

  test('returns true for the observed glitch fingerprint (~94% of catalogue)', () => {
    // 2026-04-20 shape: ~129 of ~137 coded attractions present.
    const entities = Array.from({length: 137}, (_, i) => mkAttraction(i, i));
    const waits = Array.from({length: 129}, (_, i) => mkWait(i, 0));
    expect(probe.probe(waits, entities)).toBe(true);
  });

  test('returns true even when wait values look plausible (different time shape)', () => {
    // Detector is agnostic to time values — a future glitch with all entries
    // showing e.g. waitTime=1 would still match if it covered the whole
    // catalogue. This is the headline reason we picked this signal.
    const entities = Array.from({length: 100}, (_, i) => mkAttraction(i, i));
    const waits = Array.from({length: 95}, (_, i) => mkWait(i, 1));
    expect(probe.probe(waits, entities)).toBe(true);
  });

  test('ignores SHOW entities in the denominator', () => {
    // Shows have codes and appear in the entities list but should not count
    // toward the attraction catalogue.
    const entities = [
      ...Array.from({length: 50}, (_, i) => mkAttraction(i, i)),
      ...Array.from({length: 30}, (_, i) =>
        ({id: `shows_${i}`, name: `Show ${i}`, entityType: 'SHOW', scopes: ['europapark'], code: 9000 + i} as any),
      ),
    ];
    const waits = Array.from({length: 46}, (_, i) => mkWait(i, 0));
    // 46/50 attractions = 92% → glitch, even though 46/80 entities is only 58%.
    expect(probe.probe(waits, entities)).toBe(true);
  });

  test('ignores attractions without a code (cannot appear in waits)', () => {
    // No-code attractions (walk-around trails, saunas) can never appear in
    // waits, so they must be excluded from the denominator.
    const entities = [
      ...Array.from({length: 50}, (_, i) => mkAttraction(i, i)),
      ...Array.from({length: 10}, (_, i) => mkAttraction(2000 + i, undefined as any)),
    ];
    const waits = Array.from({length: 46}, (_, i) => mkWait(i, 0));
    // 46/50 coded attractions = 92%. With the 10 no-code attractions counted,
    // the ratio would be 46/60 = 77% and we'd miss the glitch.
    expect(probe.probe(waits, entities)).toBe(true);
  });

  test('ignores attractions with NaN/Infinity codes', () => {
    // Non-finite codes from malformed upstream JSON would inflate the
    // denominator without ever matching a wait; mirrors the Number.isFinite
    // gate already applied to waits.
    const entities = [
      ...Array.from({length: 50}, (_, i) => mkAttraction(i, i)),
      mkAttraction(9001, NaN),
      mkAttraction(9002, Infinity),
    ];
    const waits = Array.from({length: 46}, (_, i) => mkWait(i, 0));
    expect(probe.probe(waits, entities)).toBe(true);
  });
});
