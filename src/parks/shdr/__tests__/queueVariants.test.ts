/**
 * The Shanghai Disney facility list files a ride's single-rider queue as an
 * Attraction of its own: “Zootopia: Hot Pursuit” Single Rider Line
 * (attHotPursuitSingleDsp) beside Zootopia: Hot Pursuit (attZootopiaHotPursuit).
 * The record is a queue on the ride, not a second ride, and carries no wait
 * time of its own.
 *
 * The facet that says a ride has a single-rider line cannot tell them apart:
 * the ride and its queue record both carry `single-rider-line`, and so does
 * Seven Dwarfs Mine Train, which has a line and no second record. The park's
 * own wording of the queue record ("... Single Rider Line") is what separates
 * them, the way the other non-ride records here are told apart.
 *
 * Fixture records keep the live ids, names and facet groups.
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {ShanghaiDisneylandResort} from '../shanghaidisneyresort.js';
import {CacheLib} from '../../../cache.js';

const SUFFIX = ';entityType=Attraction;destination=shdr';
const PARK_ID = 'shdr-park;entityType=theme-park;destination=shdr';

const facet = (id: string, group: string) => ({id, group, facetId: `f-${id}`, name: id});

const PARK = {id: PARK_ID, name: 'Shanghai Disneyland', type: 'theme-park'};
const attraction = (id: string, name: string, facets: ReturnType<typeof facet>[] = []) => ({
  id: `${id}${SUFFIX}`,
  name,
  type: 'Attraction',
  ancestors: [{id: PARK_ID, type: 'theme-park'}],
  facets,
});

const HOT_PURSUIT = attraction('attZootopiaHotPursuit', 'Zootopia: Hot Pursuit', [
  facet('single-rider-line', 'interests'),
  facet('81cm-32in-or-taller', 'height'),
]);
const HOT_PURSUIT_QUEUE = attraction('attHotPursuitSingleDsp', '“Zootopia: Hot Pursuit” Single Rider Line', [
  facet('single-rider-line', 'interests'),
  facet('81cm-32in-or-taller', 'height'),
]);
const MINE_TRAIN = attraction('attSevenDwarfsMineTrain', 'Seven Dwarfs Mine Train', [
  facet('single-rider-line', 'interests'),
  facet('97cm-38in-or-taller', 'height'),
]);
const ROARING_RAPIDS = attraction('attRoaringRapids', 'Roaring Rapids');

const waitRow = (id: string, waitTime: Record<string, unknown>) => ({id: `${id}${SUFFIX}`, waitTime});

const WAITS = [
  waitRow('attZootopiaHotPursuit', {status: 'Operating', singleRider: true, postedWaitMinutes: 80}),
  waitRow('attSevenDwarfsMineTrain', {status: 'Operating', singleRider: true, postedWaitMinutes: 105}),
  waitRow('attRoaringRapids', {status: 'Operating', singleRider: false, postedWaitMinutes: 45}),
];

function park(facilities: unknown[], waits: unknown[] = WAITS): ShanghaiDisneylandResort {
  const p = new ShanghaiDisneylandResort();
  vi.spyOn(p as any, 'getFacilities').mockResolvedValue(facilities);
  vi.spyOn(p as any, 'getWaitTimes').mockResolvedValue(waits);
  return p;
}

const idOf = (raw: string) => raw.replace(/;cacheId=[^;]*/g, '');

describe('SHDR single-rider queue records', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('ShanghaiDisneylandResort', {includePersistent: true});
  });

  const FACILITIES = [PARK, HOT_PURSUIT, HOT_PURSUIT_QUEUE, MINE_TRAIN, ROARING_RAPIDS];

  it('does not publish the queue record as an attraction', async () => {
    const entities = await park(FACILITIES).getEntities();
    expect(entities.map((e: any) => e.id)).not.toContain(idOf(HOT_PURSUIT_QUEUE.id));
    expect(entities.some((e: any) => /single rider line/i.test(e.name))).toBe(false);
  });

  it('keeps the ride itself, and every ride that has a single-rider line', async () => {
    const entities = await park(FACILITIES).getEntities();
    const attractions = entities.filter((e: any) => e.entityType === 'ATTRACTION');
    expect(attractions.map((e: any) => e.id).sort()).toEqual([
      idOf(HOT_PURSUIT.id), idOf(MINE_TRAIN.id), idOf(ROARING_RAPIDS.id),
    ].sort());
    expect(attractions.find((e: any) => e.id === idOf(HOT_PURSUIT.id))).toMatchObject({
      name: 'Zootopia: Hot Pursuit',
      parentId: idOf(PARK_ID),
    });
  });

  it('keeps the ride\'s own single-rider queue in live data', async () => {
    const live = await park(FACILITIES).getLiveData();
    const ride = live.find((l: any) => l.id === idOf(HOT_PURSUIT.id));
    expect(ride?.status).toBe('OPERATING');
    expect(ride?.queue?.STANDBY).toEqual({waitTime: 80});
    expect(ride?.queue?.SINGLE_RIDER).toEqual({waitTime: null});
    const train = live.find((l: any) => l.id === idOf(MINE_TRAIN.id));
    expect(train?.queue?.SINGLE_RIDER).toEqual({waitTime: null});
  });

  it('emits no live row for the queue record, even if the feed ever sends one', async () => {
    const waits = [...WAITS, waitRow('attHotPursuitSingleDsp', {status: 'Operating', postedWaitMinutes: 20})];
    const live = await park(FACILITIES, waits).getLiveData();
    expect(live.map((l: any) => l.id)).not.toContain(idOf(HOT_PURSUIT_QUEUE.id));
  });

  it.each([
    ['“Zootopia: Hot Pursuit” Single Rider Line'],
    ['Seven Dwarfs Mine Train Single-Rider Line'],
    ['Roaring Rapids (single rider line)'],
    ['TRON Lightcycle Power Run Single Rider  Line'],
  ])('%j is a queue record', async name => {
    // A real ride alongside, as the list is never empty in the feed.
    const entities = await park([PARK, ROARING_RAPIDS, attraction('attX', name)]).getEntities();
    expect(entities.some((e: any) => e.id === idOf(`attX${SUFFIX}`))).toBe(false);
    expect(entities.some((e: any) => e.id === idOf(ROARING_RAPIDS.id))).toBe(true);
  });

  it.each([
    ['Zootopia: Hot Pursuit'],
    ['Seven Dwarfs Mine Train'],
    ['Rider Switch Adventure'],
    ['Single Rider Express Coaster'],
    // Made-up names that only embed the phrase in a longer word.
    ['Multisingle Rider Line'],
    ['Single Rider Lineup'],
  ])('%j is a ride', async name => {
    const entities = await park([PARK, attraction('attX', name)]).getEntities();
    expect(entities.some((e: any) => e.id === idOf(`attX${SUFFIX}`))).toBe(true);
  });
});
