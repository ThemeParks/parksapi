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
import {plopsaDecideOperating} from '../plopsa.js';

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
