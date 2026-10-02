import {describe, it, expect, vi, afterEach} from 'vitest';
import {UniversalStudiosBeijing, isScareZone} from '../universalbeijing.js';

/**
 * Scare zones arrive in the perform list with the same record shape as a
 * performance. Trimmed from the live feed (September 2026): the field set a
 * scare zone and a real show share is identical, so the title prefix is the
 * only thing to key on.
 */
function row(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title,
    material_type: 'perform',
    gems_status: '3',
    is_closed: 0,
    show_indoor: '2',
    area: '2',
    thrilling_degree: 0,
    position: {longitude: '116.68088', latitude: '39.85674'},
    service_time: {open: '19:00', close: '22:00'},
    show_time_arr: null,
    ...extra,
  };
}

const SCARE_ZONES = [
  row('6a8e9b2e910beee08e0b081b', 'Scare Zone: Kill Cute Party'),
  row('6a8e906f7f2fcbff5102fbf8', 'Scare Zone: M3GAN'),
  row('6a8e91f2e6f7335bcb043904', "Scare Zone: Mel's Die In"),
  row('6a8e626894373fd9a2070c24', 'Scare Zone: Underworld'),
];

const SHOWS = [
  // Same event, same area and hours, a real timed performance.
  row('6a8e9c65d72829775a0330ea', 'Underworld Uprising', {
    service_time: {open: '19:00', close: '21:00'},
    show_time_arr: [{time: '19:00', is_full_show: false}],
  }),
  row('6a8e9d1aaa8a7b8c6f0a2397', 'Mortus Meet and Greet'),
  row('6346223cdbd19c09e313e2c5', 'Universal on Parade ', {service_time: {open: null, close: null}}),
  row('5f917d212cf659025855ad3c', 'WaterWorld Stunt Show', {
    area: '5',
    service_time: {open: '11:00', close: '20:00'},
    show_time_arr: [{time: '11:00', is_full_show: false}],
  }),
  row('68b14c1d148ab41e74660ff5', 'Death Eaters{1} Takeover'),
  row('5fa248fe9b219261f97cb702', 'Transformers: More than Meets the Eye'),
];

// A Halloween house from the attraction list: the walk-through the scare
// zones should now match.
const HOUSE = {
  id: '6a8d57a0676f15eb6b0f7544',
  title: 'A Quiet Place',
  material_type: 'scenic',
  gems_status: '',
  position: {longitude: 116.68, latitude: 39.855},
};

function stubbedPark(): UniversalStudiosBeijing {
  const park = new UniversalStudiosBeijing();
  vi.spyOn(park as any, 'getAttractionData').mockResolvedValue([HOUSE]);
  vi.spyOn(park as any, 'getShowData').mockResolvedValue([...SCARE_ZONES, ...SHOWS]);
  return park;
}

afterEach(() => vi.restoreAllMocks());

describe('isScareZone', () => {
  it('matches every scare zone title in the feed', () => {
    for (const z of SCARE_ZONES) expect(isScareZone(z)).toBe(true);
  });

  it('matches no performance, parade or meet and greet', () => {
    for (const s of SHOWS) expect(isScareZone(s)).toBe(false);
  });

  it('only matches the prefix, not the phrase elsewhere in a title', () => {
    expect(isScareZone({title: 'Scare Zone Photo Op'})).toBe(false);
    expect(isScareZone({title: 'Meet the Scare Zone: Monsters'})).toBe(false);
    expect(isScareZone({title: 'scare zone: lower case'})).toBe(true);
    expect(isScareZone({})).toBe(false);
  });
});

describe('Universal Beijing scare zones in the entity list', () => {
  it('publishes the four scare zones as ATTRACTION / RIDE under their feed ids', async () => {
    const entities = await stubbedPark().getEntities();
    for (const z of SCARE_ZONES) {
      const e = entities.find((x) => x.id === z.id) as any;
      expect(e, z.title).toBeDefined();
      expect(e.entityType).toBe('ATTRACTION');
      expect(e.attractionType).toBe('RIDE');
      expect(e.parentId).toBe('universalstudiosbeijing');
    }
  });

  it('types a scare zone the same as the Halloween houses', async () => {
    const entities = await stubbedPark().getEntities();
    const house = entities.find((x) => x.id === HOUSE.id) as any;
    const zone = entities.find((x) => x.id === SCARE_ZONES[0].id) as any;
    expect([zone.entityType, zone.attractionType]).toEqual([house.entityType, house.attractionType]);
  });

  it('leaves performances, the parade and meet and greets as SHOW', async () => {
    const entities = await stubbedPark().getEntities();
    for (const s of SHOWS) {
      const e = entities.find((x) => x.id === s.id) as any;
      expect(e, s.title).toBeDefined();
      expect(e.entityType).toBe('SHOW');
      expect(e.attractionType).toBeUndefined();
    }
  });

  it('keeps every feed id and emits each exactly once', async () => {
    const entities = await stubbedPark().getEntities();
    const ids = entities.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of [...SCARE_ZONES, ...SHOWS, HOUSE]) expect(ids).toContain(r.id);
  });
});
