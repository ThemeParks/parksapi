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
import type {Entity} from '@themeparks/typelib';
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
