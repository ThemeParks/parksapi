import {describe, it, expect, vi, afterEach} from 'vitest';
import {UniversalStudiosJapan, isWalkthroughShow} from '../universalstudiosjapan.js';

/**
 * Hogwarts Castle Walk is a walk-through that both USJ feeds file as a Show,
 * with no field that sets it apart from a performance: its `other` category
 * is shared with the Snoopy photo opportunity. Place records trimmed from the
 * live places feed (September 2026).
 */
function place(place_id: string, name: string, type: string, categories: string[], lat: number, lng: number) {
  return {
    place_id,
    name,
    place_type: {type, categories},
    geometry: {locations: [{location_type: 'map', lat_lng: {lat, lng}}]},
    venue_id: 'usj.usj',
  };
}

const CASTLE_WALK = place('usj.usj.shows.hogwarts_castle_walk_2026', 'Hogwarts™ Castle Walk', 'Show', ['other'], 34.668686, 135.431678);

const SHOWS = [
  place('usj.usj.show.waterworld', 'WaterWorld', 'Show', ['shows'], 34.667232, 135.429906),
  place('usj.usj.show.frog_choir', 'Frog Choir', 'Show', ['street_shows'], 34.6681406, 135.4319426),
  place('usj.usj.show.no_limit_parade_25th_anniversary_discover_u_2026', 'NO LIMIT! Parade: Discover U!!! Version', 'Show', ['parade'], 34.664456, 135.434551),
  place('usj.usj.show.jurassic_park_dinosaur_meet_greet_2026', 'Jurassic Park Dinosaur Meet & Greet', 'Show', ['street_shows'], 34.666, 135.43),
  // Same `other` category as the Castle Walk, and a real photo op.
  place('usj.usj.show.peanuts_photo_opportunity', 'Snoopy Photo Opportunity', 'Show', ['other'], 34.66699, 135.432285),
];

// The feed's own walk-through: typed Ride upstream, untouched by this fix.
const OLLIVANDERS = place('usj.usj.show.ollivanders', 'Ollivanders™', 'Ride', ['kid-friendly', 'live-Action-show'], 34.66793, 135.43155);

function stubbedPark(): UniversalStudiosJapan {
  const park = new UniversalStudiosJapan();
  vi.spyOn(park as any, 'getPlaces').mockResolvedValue([CASTLE_WALK, ...SHOWS, OLLIVANDERS]);
  return park;
}

afterEach(() => vi.restoreAllMocks());

describe('isWalkthroughShow', () => {
  it('matches the Castle Walk, including a later year re-issue', () => {
    expect(isWalkthroughShow(CASTLE_WALK)).toBe(true);
    expect(isWalkthroughShow({...CASTLE_WALK, place_id: 'usj.usj.shows.hogwarts_castle_walk_2027'})).toBe(true);
    expect(isWalkthroughShow({...CASTLE_WALK, place_id: 'usj.usj.show.hogwarts_castle_walk'})).toBe(true);
  });

  it('matches no real show, and nothing the feed does not call a Show', () => {
    for (const s of SHOWS) expect(isWalkthroughShow(s)).toBe(false);
    expect(isWalkthroughShow({...CASTLE_WALK, place_type: {type: 'Dining'}})).toBe(false);
    expect(isWalkthroughShow({...CASTLE_WALK, place_id: 'usj.usj.shows.hogwarts_castle_walk_2026_extra'})).toBe(false);
  });
});

describe('USJ entity list', () => {
  it('publishes Hogwarts Castle Walk as ATTRACTION / RIDE under its feed id', async () => {
    const entities = await stubbedPark().getEntities();
    const e = entities.find((x) => x.id === 'usj.usj.shows.hogwarts_castle_walk_2026') as any;
    expect(e).toBeDefined();
    expect(e.entityType).toBe('ATTRACTION');
    expect(e.attractionType).toBe('RIDE');
    expect(e.location).toEqual({latitude: 34.668686, longitude: 135.431678});
  });

  it('types it the same as the feed-typed walk-through Ollivanders', async () => {
    const entities = await stubbedPark().getEntities();
    const walk = entities.find((x) => x.id === CASTLE_WALK.place_id) as any;
    const oll = entities.find((x) => x.id === OLLIVANDERS.place_id) as any;
    expect([walk.entityType, walk.attractionType]).toEqual([oll.entityType, oll.attractionType]);
  });

  it('leaves real shows, the parade, meet and greets and photo ops as SHOW', async () => {
    const entities = await stubbedPark().getEntities();
    for (const s of SHOWS) {
      const e = entities.find((x) => x.id === s.place_id) as any;
      expect(e, s.name).toBeDefined();
      expect(e.entityType).toBe('SHOW');
      expect(e.attractionType).toBeUndefined();
    }
  });
});
