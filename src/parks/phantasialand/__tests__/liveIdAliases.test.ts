import {describe, it, expect, vi, afterEach} from 'vitest';
import {Phantasialand} from '../phantasialand.js';

/**
 * Phantasialand's POI feed carries several records per venue: one with
 * seasons, which becomes the entity, and retired or placeholder copies with
 * `seasons: []`, which do not. The signage feed reports live state against
 * whichever copy it likes.
 *
 * Live: Black Mamba's 40-minute wait arrived under unpublished id 225 while
 * published entity 52 got a bare CLOSED, and across the whole park not one
 * published entity carried a queue. The live rows are aliased onto the
 * published id so the wait reaches something a consumer can look up.
 */
const SEASON = [{from: '2026-01-01', to: '2026-12-31'}];

function poi(over: Record<string, unknown>) {
  return {
    id: 1,
    title: 'Ride',
    category: 'ATTRACTIONS',
    seasons: SEASON,
    tags: [],
    entrance: {world: {lat: 50.79, lng: 6.87}},
    ...over,
  };
}

function stubbedPark(pois: any[], signage: any[]): Phantasialand {
  const park = new Phantasialand();
  vi.spyOn(park as any, 'getPOI').mockResolvedValue(pois);
  vi.spyOn(park as any, 'getSignage').mockResolvedValue(signage);
  return park;
}

/** The published live row for an id, if one was emitted. */
async function rowFor(park: Phantasialand, id: string) {
  const live = await park.getLiveData();
  return live.find((l) => l.id === id);
}

describe('Phantasialand live-id aliasing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lands a wait time reported against an unpublished copy on the published entity', async () => {
    const park = stubbedPark(
      [
        poi({id: 52, title: 'Black Mamba'}),
        poi({id: 225, title: 'Black Mamba', seasons: []}),
      ],
      [{poiId: 225, waitTime: 40, open: true}],
    );

    expect(await rowFor(park, '52')).toMatchObject({
      status: 'OPERATING',
      queue: {STANDBY: {waitTime: 40}},
    });
    expect(await rowFor(park, '225')).toBeUndefined();
  });

  it('keeps the real state when the published copy also reports a bare closed', async () => {
    // Both orders, because the merge must not depend on signage ordering.
    const pois = [
      poi({id: 52, title: 'Black Mamba'}),
      poi({id: 225, title: 'Black Mamba', seasons: []}),
    ];

    const closedFirst = stubbedPark(pois, [
      {poiId: 52, open: false},
      {poiId: 225, waitTime: 40, open: true},
    ]);
    expect(await rowFor(closedFirst, '52')).toMatchObject({
      status: 'OPERATING',
      queue: {STANDBY: {waitTime: 40}},
    });

    const closedLast = stubbedPark(pois, [
      {poiId: 225, waitTime: 40, open: true},
      {poiId: 52, open: false},
    ]);
    expect(await rowFor(closedLast, '52')).toMatchObject({
      status: 'OPERATING',
      queue: {STANDBY: {waitTime: 40}},
    });
  });

  it('emits one row per entity, never a duplicate', async () => {
    const park = stubbedPark(
      [
        poi({id: 52, title: 'Black Mamba'}),
        poi({id: 225, title: 'Black Mamba', seasons: []}),
      ],
      [
        {poiId: 52, open: false},
        {poiId: 225, waitTime: 40, open: true},
      ],
    );
    const live = await park.getLiveData();
    const ids = live.map((l) => l.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it('aliases showtimes too, not just wait times', async () => {
    const park = stubbedPark(
      [
        poi({id: 194, title: 'Fantissima', category: 'SHOWS'}),
        poi({id: 112, title: 'Fantissima', category: 'SHOWS', seasons: []}),
      ],
      [{poiId: 112, showTimes: ['2026-08-13 19:30:00']}],
    );
    const row = await rowFor(park, '194');
    expect(row?.status).toBe('OPERATING');
    expect(row?.showtimes).toHaveLength(1);
  });

  it('drops a venue with no published copy at all', async () => {
    // Nobis: three records, none published, so there is nothing to alias onto.
    const park = stubbedPark(
      [
        poi({id: 7, title: 'Nobis', category: 'PHOTO_POINT', seasons: []}),
        poi({id: 13, title: 'Nobis', category: 'SHOWS', seasons: []}),
        poi({id: 90, title: 'Nobis', category: 'SHOWS', seasons: []}),
      ],
      [{poiId: 13, open: true}],
    );
    const live = await park.getLiveData();
    expect(live.find((l) => ['7', '13', '90'].includes(l.id))).toBeUndefined();
  });

  it('does not alias when a copy is unpublished only because of its category', async () => {
    // Face painter: the twin has seasons but SERVICE is never an entity type,
    // so there is still no published entity to attach to.
    const park = stubbedPark(
      [
        poi({id: 189, title: 'Face painter', category: 'SERVICE', seasons: []}),
        poi({id: 231, title: 'Face painter', category: 'SERVICE'}),
      ],
      [{poiId: 189, open: true}],
    );
    const live = await park.getLiveData();
    expect(live).toHaveLength(0);
  });

  it('refuses to guess when a title has two published records', async () => {
    // Focaccia Mexico genuinely has two published records. Picking one would
    // put a wait on the wrong venue, so the unpublished copy stays dropped.
    const park = stubbedPark(
      [
        poi({id: 35, title: 'Focaccia Mexico', category: 'RESTAURANTS_AND_SNACKS'}),
        poi({id: 37, title: 'Focaccia Mexico', category: 'RESTAURANTS_AND_SNACKS'}),
        poi({id: 999, title: 'Focaccia Mexico', category: 'RESTAURANTS_AND_SNACKS', seasons: []}),
      ],
      [{poiId: 999, open: true}],
    );
    expect(await rowFor(park, '999')).toBeUndefined();
    expect(await rowFor(park, '35')).toBeUndefined();
    expect(await rowFor(park, '37')).toBeUndefined();
  });

  it('leaves an unambiguous published id alone', async () => {
    const park = stubbedPark(
      [poi({id: 60, title: 'Taron'})],
      [{poiId: 60, waitTime: 25, open: true}],
    );
    expect(await rowFor(park, '60')).toMatchObject({
      status: 'OPERATING',
      queue: {STANDBY: {waitTime: 25}},
    });
  });

  it('never emits a row for an id the entity list does not publish', async () => {
    // The invariant the whole change exists to restore.
    const park = stubbedPark(
      [
        poi({id: 52, title: 'Black Mamba'}),
        poi({id: 225, title: 'Black Mamba', seasons: []}),
        poi({id: 189, title: 'Face painter', category: 'SERVICE', seasons: []}),
        poi({id: 162, title: 'ATM', category: 'SERVICE'}),
      ],
      [
        {poiId: 225, waitTime: 40, open: true},
        {poiId: 189, open: true},
        {poiId: 162, open: true},
      ],
    );
    const entityIds = new Set((await park.getEntities()).map((e) => e.id));
    const live = await park.getLiveData();
    expect(live.filter((l) => !entityIds.has(l.id))).toEqual([]);
  });
});
