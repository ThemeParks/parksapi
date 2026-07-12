/**
 * Plopsa decision-logic regression tests.
 *
 * The full decision matrix for the status a ride emits: OPERATING, DOWN,
 * or CLOSED. The interesting cases are:
 *  - a *positive* wait time + a stale `temporarily_closed: true` from POI
 *    must NOT downgrade to DOWN, or multi-collector deployments will flap
 *    any ride whose POI snapshot disagrees between instances.
 *  - `temporarily_closed: true` + a `0` wait time (the feed's default/
 *    no-signal value, present even for closed rides) MUST report DOWN,
 *    not OPERATING — `0` is not evidence of a live reading.
 */
import {describe, test, expect} from 'vitest';
import type {Entity} from '@themeparks/typelib';
import {plopsaDecideStatus, Plopsaland} from '../plopsa.js';

describe('plopsaDecideStatus', () => {
  test('park closed → ride always CLOSED regardless of other inputs', () => {
    expect(plopsaDecideStatus(false, false, false)).toBe('CLOSED');
    expect(plopsaDecideStatus(false, false, true)).toBe('CLOSED');
    expect(plopsaDecideStatus(false, true,  false)).toBe('CLOSED');
    expect(plopsaDecideStatus(false, true,  true)).toBe('CLOSED');
  });

  test('park open + ride open + has wait → OPERATING', () => {
    expect(plopsaDecideStatus(true, false, true)).toBe('OPERATING');
  });

  test('park open + ride open + no wait → OPERATING (e.g. brand-new ride before first reading)', () => {
    expect(plopsaDecideStatus(true, false, false)).toBe('OPERATING');
  });

  test('park open + POI says temp-closed + has wait → OPERATING (wait-times feed wins over stale POI hint)', () => {
    // This is the case the earlier bug report depended on: stale POI says
    // closed, but the wait-times feed has a real positive number. Trust
    // the live number.
    expect(plopsaDecideStatus(true, true, true)).toBe('OPERATING');
  });

  test('park open + POI says temp-closed + no wait → DOWN (the hint is authoritative when no live signal)', () => {
    // Regression: the waiting-times feed returns `0` (not absence) for
    // rides with no live reading, including temporarily_closed ones. `0`
    // must not be treated as `hasWait`, or these rides wrongly show
    // OPERATING instead of DOWN (e.g. SuperSplash at Plopsaland De Panne).
    expect(plopsaDecideStatus(true, true, false)).toBe('DOWN');
  });
});

describe('De Panne POI location wiring', () => {
  const fallbackLocation = {latitude: 1, longitude: 2};

  class Probe extends Plopsaland {
    protected override mapCoordinates(
      coords: {x: number; y: number} | undefined,
    ): {latitude: number; longitude: number} | undefined {
      return coords ? fallbackLocation : undefined;
    }

    public buildEntitiesForTest(): Promise<Entity[]> {
      return this.buildEntityList();
    }
  }

  function jsonResponse(payload: unknown) {
    return {json: async () => payload};
  }

  function createProbe(poiItems: unknown[]): Probe {
    const park = new Probe();
    park.fetchPOI = async () => jsonResponse({items: poiItems}) as any;
    park.fetchEntertainments = async () => jsonResponse({items: []}) as any;
    return park;
  }

  test('populates attraction location from the bundled snapshot', async () => {
    const entities = await createProbe([{
      id: 'poi-1',
      title: 'Attractions',
      type: {label: 'Attractions'},
      map_coordinates: {x: 10, y: 20},
      contains: [{
        id: 'anubis',
        title: 'Anubis The Ride',
        type: 'attraction',
      }],
    }]).buildEntitiesForTest();

    const anubis = entities.find((e) => e.id === 'anubis');
    expect(anubis?.location).toEqual({latitude: 51.081837, longitude: 2.597878});
  });

  test('prefers snapshot coordinates over mapped POI coordinates', async () => {
    const entities = await createProbe([{
      id: 'poi-1',
      title: 'Attractions',
      type: {label: 'Attractions'},
      map_coordinates: {x: 10, y: 20},
      contains: [{
        id: 'anubis',
        title: 'Anubis The Ride',
        type: 'attraction',
      }],
    }]).buildEntitiesForTest();

    const anubis = entities.find((e) => e.id === 'anubis');
    expect(anubis?.location).toEqual({latitude: 51.081837, longitude: 2.597878});
    expect(anubis?.location).not.toEqual(fallbackLocation);
  });

  test('matches snapshot titles with curly apostrophes through buildEntityList', async () => {
    const entities = await createProbe([{
      id: 'poi-1',
      title: 'Attractions',
      type: {label: 'Attractions'},
      map_coordinates: {x: 10, y: 20},
      contains: [{
        id: 'vics',
        title: 'Vic’s Whirlwind',
        type: 'attraction',
      }],
    }]).buildEntitiesForTest();

    const vics = entities.find((e) => e.id === 'vics');
    expect(vics?.location).toEqual({latitude: 51.082082, longitude: 2.5958043});
  });

  test('skips POI children without a usable title', async () => {
    const entities = await createProbe([{
      id: 'poi-1',
      title: 'Attractions',
      type: {label: 'Attractions'},
      map_coordinates: {x: 10, y: 20},
      contains: [
        {id: 'missing-title', type: 'attraction'},
        {id: 'null-title', title: null, type: 'foods_and_drinks'},
        {id: 'anubis', title: 'Anubis The Ride', type: 'attraction'},
      ],
    }]).buildEntitiesForTest();

    expect(entities.find((e) => e.id === 'missing-title')).toBeUndefined();
    expect(entities.find((e) => e.id === 'null-title')).toBeUndefined();
    expect(entities.find((e) => e.id === 'anubis')).toBeDefined();
  });
});
