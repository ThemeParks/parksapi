import {describe, test, expect, beforeEach} from 'vitest';
import {SixFlags} from '../sixflags.js';
import {CacheLib} from '../../../cache.js';
import type {Entity} from '@themeparks/typelib';

/**
 * Six Flags files some seasonal walk-throughs and play areas (hay mazes,
 * trick-or-treat trails, pumpkin patches, a foam pit) in venue 2, its show
 * venue. They have no performances and must publish as ATTRACTION, while the
 * real shows sharing that venue stay SHOW.
 *
 * Row shapes below mirror /poi responses captured on 2026-09-26, trimmed to
 * the fields that matter. The classification fields are kept verbatim to
 * show the feed gives no usable signal: every row, walk-through or show,
 * reads showType "Interactive", and poiSubcategory is missing or says
 * "daytime.show" on most of the walk-throughs.
 */

type Row = {
  fimsId: string;
  name: string;
  parkId: number;
  venueId: number;
  location: {latitude: string; longitude: string; name?: string};
  showType?: {id: number; name: string};
  poiSubcategory?: string | null;
  activityType?: string;
};

const PARKS = [
  {parkId: 901, code: 'SFOT', name: 'Six Flags Over Texas', waterParks: []},
  {parkId: 902, code: 'SFOG', name: 'Six Flags Over Georgia', waterParks: []},
  {parkId: 906, code: 'SFMM', name: 'Six Flags Magic Mountain', waterParks: []},
  {parkId: 910, code: 'SFGR', name: 'Six Flags Great America', waterParks: []},
  {parkId: 936, code: 'SFDK', name: 'Six Flags Discovery Kingdom', waterParks: []},
];

const INTERACTIVE = {id: 44, name: 'Interactive'};

function row(fimsId: string, name: string, lat: string, lng: string, extra: Partial<Row> = {}): Row {
  const parkId = Number(fimsId.split('-')[1]);
  return {fimsId, name, parkId, venueId: 2, location: {latitude: lat, longitude: lng}, showType: INTERACTIVE, ...extra};
}

/** The ten walk-throughs, exactly as the feed names and classifies them. */
const WALK_THROUGHS: Row[] = [
  row('SHOW-901-00051', 'Hay Bale Maze\t\t\t \t\t\t', '32.755602', '-97.069262', {poiSubcategory: 'daytime.activity'}),
  row('SHOW-901-00056', 'Tricks & Treats Trail', '32.756741', '-97.070086'),
  row('SHOW-902-00047', "Farmer Jordan's Pumpkin Patch", '0.000000', '0.000000'),
  row('SHOW-902-00048', 'Inflatable Corn Maze', '0.000000', '0.000000'),
  row('SHOW-902-00050', 'Trick-or-Treat Trail', '0.000000', '0.000000'),
  row('SHOW-906-00030', 'Phantom Foam Pit', '34.425220', '-118.596907'),
  row('SHOW-906-00033', 'The Spellbound Harvest Trail\t\t\t \t\t\t', '34.425879', '-118.596065', {poiSubcategory: 'daytime.activity'}),
  row('SHOW-906-00034', 'Trick or Treat Trail', '34.426012', '-118.596499', {showType: {id: -1, name: ''}}),
  row('SHOW-910-00040', "Pumpkin Hollow's Corn Maize", '42.368551', '-87.934197', {poiSubcategory: 'daytime.show'}),
  row('SHOW-936-00024', 'Hay Maze', '38.137310', '-122.234360', {activityType: 'show', poiSubcategory: null}),
];

/**
 * Real performances in the same venues, with the same "Interactive"
 * showType, including ones whose names share words with the walk-throughs.
 */
const REAL_SHOWS: Row[] = [
  row('SHOW-901-00050', 'Skelebration Dance Party', '32.755', '-97.070', {activityType: 'show'}),
  row('SHOW-901-00014', 'Costume Contest', '32.755', '-97.070', {poiSubcategory: 'daytime.show'}),
  row('SHOW-901-00034', 'Character Meet & Greets', '32.755', '-97.070', {activityType: 'show'}),
  row('SHOW-902-00009', 'Looney Tunes Meet & Greet', '33.770', '-84.550', {activityType: 'show'}),
  row('SHOW-902-00052', 'The Costume Contest', '33.770', '-84.550'),
  row('SHOW-906-00031', 'Looney Tunes Skelebration Dance Party', '34.425', '-118.596'),
  row('SHOW-910-00007', 'Tricks and Treats Parade', '42.368', '-87.934', {activityType: 'show'}),
  row('SHOW-910-00039', 'Pumpkin Hollow’s Trick or Treat', '42.368', '-87.934', {poiSubcategory: 'daytime.show'}),
  row('SHOW-936-00051', 'Spooktastic! A Looney Tunes Halloween Party', '38.137', '-122.234', {activityType: 'show'}),
];

/** A ride and a restaurant, so the other venues are proven untouched. */
const OTHER_VENUES = [
  {fimsId: 'RIDE-901-00001', name: 'Titan', parkId: 901, venueId: 1, location: {latitude: '32.756', longitude: '-97.070'}},
  {fimsId: 'RESTAURANT-906-00002', name: 'Food Court', parkId: 906, venueId: 4, location: {latitude: '34.425', longitude: '-118.596'}},
];

const POI = [...WALK_THROUGHS, ...REAL_SHOWS, ...OTHER_VENUES];

class Probe extends SixFlags {
  override async getParkData(): Promise<any> {
    return PARKS;
  }

  override async getPOI(parkId: number): Promise<any> {
    return POI.filter(p => p.parkId === parkId);
  }

  public entitiesForTest(): Promise<Entity[]> {
    return this.getEntities();
  }
}

beforeEach(() => {
  CacheLib.clearByClassName('Probe');
  CacheLib.clearByClassName('SixFlags');
});

async function entityMap(): Promise<Map<string, Entity>> {
  const entities = await new Probe().entitiesForTest();
  return new Map(entities.map(e => [e.id, e]));
}

describe('show-venue walk-throughs', () => {
  test.each(WALK_THROUGHS.map(r => [r.fimsId, r.name.trim()]))(
    '%s (%s) publishes as an ATTRACTION with attractionType OTHER',
    async (id) => {
      const entity = (await entityMap()).get(id);

      expect(entity).toBeDefined();
      expect(entity!.entityType).toBe('ATTRACTION');
      expect((entity as any).attractionType).toBe('OTHER');
    },
  );

  test('keeps every walk-through on its feed id, so downstream identity is preserved', async () => {
    const entities = await entityMap();

    for (const r of WALK_THROUGHS) {
      expect(entities.has(r.fimsId)).toBe(true);
    }
    // No derived or prefixed id sneaks in alongside.
    const walkThroughNames = new Set(WALK_THROUGHS.map(r => r.name.trim()));
    const byName = [...entities.values()].filter(e => walkThroughNames.has(e.name as string));
    expect(byName.map(e => e.id).sort()).toEqual(WALK_THROUGHS.map(r => r.fimsId).sort());
  });

  test('keeps a reclassified walk-through parented to its park', async () => {
    const entity = (await entityMap()).get('SHOW-906-00030');

    expect(entity?.parentId).toBe('sixflags_park_SFMM');
    expect(entity?.parkId).toBe('sixflags_park_SFMM');
    expect(entity?.destinationId).toBe('sixflags_destination_SFMM');
  });

  test.each(REAL_SHOWS.map(r => [r.fimsId, r.name]))(
    '%s (%s) stays a SHOW',
    async (id) => {
      const entity = (await entityMap()).get(id);

      expect(entity).toBeDefined();
      expect(entity!.entityType).toBe('SHOW');
      expect((entity as any).attractionType).toBeUndefined();
    },
  );

  test('leaves rides and restaurants as they were', async () => {
    const entities = await entityMap();

    expect(entities.get('RIDE-901-00001')?.entityType).toBe('ATTRACTION');
    expect((entities.get('RIDE-901-00001') as any)?.attractionType).toBe('RIDE');
    expect(entities.get('RESTAURANT-906-00002')?.entityType).toBe('RESTAURANT');
  });

  test('reclassifies exactly the ten listed rows and nothing else in the show venue', async () => {
    const entities = await entityMap();
    const showVenueIds = [...WALK_THROUGHS, ...REAL_SHOWS].map(r => r.fimsId);
    const reclassified = showVenueIds.filter(id => entities.get(id)?.entityType === 'ATTRACTION').sort();

    expect(reclassified).toEqual(WALK_THROUGHS.map(r => r.fimsId).sort());
  });
});
