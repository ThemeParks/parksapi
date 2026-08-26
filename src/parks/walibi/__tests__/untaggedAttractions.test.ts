import {describe, test, expect, beforeEach, afterEach} from 'vitest';
import {WalibiBelgium} from '../walibi.js';
import {CacheLib} from '../../../cache.js';
import type {HTTPObj} from '../../../http.js';

/**
 * `waitingTimeName` is the CMS's wait-time id, and only rides with a queue
 * board get one. Walibi Belgium hands out 16 of them across 41 POIs — every
 * one of which the feed types `"poiType": "ATTRACTION"` — so keying the entity
 * list on that field drops 25 real rides: GRAND CARROUSEL, TREE HOUSE,
 * OCTOPUS, the whole family and kids side of the park.
 *
 * Those 25 were published until 42008c71 ("switch to stable API IDs instead of
 * slugified names"), which introduced `.filter(a => a.waitingTimeName)` as a
 * null-guard for the new id — the same guard the restaurants got in that
 * commit, where it drops nothing because every restaurant has a path. On
 * Walibi Holland and Bellewaerde the attraction guard drops nothing either
 * (39/39 and 36/36 tagged), which is why it went unnoticed.
 *
 * So fall back to the CMS path, exactly as restaurants already do. A tagged
 * ride keeps its wait-time id: those are live wiki records and must not shift.
 */
const attraction = (title: string, slug: string, waitingTimeName?: string) => ({
  title,
  path: `/content/wbe/fr/attractions/${slug}`,
  waitingTimeName: waitingTimeName ?? null,
  latitude: 50.7,
  longitude: 4.59,
});

function stubbedPark(attractions: any[]): WalibiBelgium {
  const park = new WalibiBelgium();
  park.fetchAttractions = (async () => ({json: async () => attractions} as any as HTTPObj)) as any;
  park.getRestaurants = async () => [];
  park.getWaitTimes = async () => [];
  return park;
}

describe('WalibiBase.buildEntityList — attractions with no wait-time id', () => {
  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test('publishes a ride the CMS never gave a wait-time id', async () => {
    const entities = await stubbedPark([
      attraction('KONDAA', 'kondaa', '45'),
      attraction('GRAND CARROUSEL', 'le-grand-carrousel'),
    ]).getEntities();

    const rides = entities.filter(e => e.entityType === 'ATTRACTION');
    expect(rides.map(e => e.name)).toEqual(['KONDAA', 'GRAND CARROUSEL']);
  });

  test('keys a tagged ride on its wait-time id and an untagged one on its path', async () => {
    // KONDAA's id is a live wiki record; the fallback must not reach it.
    const entities = await stubbedPark([
      attraction('KONDAA', 'kondaa', '45'),
      attraction('GRAND CARROUSEL', 'le-grand-carrousel'),
    ]).getEntities();

    expect(entities.filter(e => e.entityType === 'ATTRACTION').map(e => e.id))
      .toEqual(['45', 'attr_le-grand-carrousel']);
  });

  test('carries coordinates onto a ride keyed by path', async () => {
    const entities = await stubbedPark([attraction('TREE HOUSE', 'tree-house')]).getEntities();

    const ride = entities.find(e => e.entityType === 'ATTRACTION')!;
    expect(ride.location).toEqual({latitude: 50.7, longitude: 4.59});
  });

  test('sanitises an attraction slug the id charset rejects', async () => {
    // Walibi Belgium's `nl` and `en` feeds path 4X4 ADVENTURE at a segment with
    // a literal space. Left raw it would fail the charset check and take the
    // whole park's entity list down, the way `p-che-&-mignon` did.
    const entities = await stubbedPark([
      attraction('4X4 ADVENTURE', '4X4 ADVENTURE'),
    ]).getEntities();

    expect(entities.find(e => e.entityType === 'ATTRACTION')!.id).toBe('attr_4X4-ADVENTURE');
    for (const entity of entities) {
      expect(entity.id).toMatch(/^[\w.-]+$/);
    }
  });

  test('drops a POI with neither a wait-time id nor a path, rather than minting a bare prefix', async () => {
    const entities = await stubbedPark([
      {title: 'NO PATH AT ALL', waitingTimeName: null},
      attraction('KONDAA', 'kondaa', '45'),
    ]).getEntities();

    expect(entities.filter(e => e.entityType === 'ATTRACTION').map(e => e.name)).toEqual(['KONDAA']);
  });
});
