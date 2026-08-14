import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {Phantasialand} from '../phantasialand.js';

/**
 * The signage feed regenerates a row for every venue it is still reporting on
 * and never deletes the ones it has stopped reporting. Retired rows keep their
 * original timestamp and their last observed state forever.
 *
 * Live, that meant Mystic Winter Castle published OPERATING with nine
 * showtimes in August off a February observation, and Hack & Buddl published
 * CLOSED off a row last touched 521 days earlier. Rows older than a day are
 * dropped so a stale observation is never restated as current.
 *
 * Every test here carries a fresh row that must survive, so a test cannot pass
 * by the pipeline silently producing nothing.
 */
const NOW = new Date('2026-08-14T10:00:00Z');

/** A POI record that becomes a published entity. */
function poi(id: number, title: string, category = 'ATTRACTIONS') {
  return {
    id,
    title,
    category,
    seasons: ['SUMMER', 'WINTER'],
    tags: [],
    entrance: {world: {lat: 50.79, lng: 6.87}},
  };
}

/** A signage row, aged `hoursAgo` before the pinned now. */
function row(poiId: number, hoursAgo: number, state: Record<string, unknown>) {
  const at = new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();
  return {poiId: String(poiId), updatedAt: at, createdAt: at, updatedRow: at, ...state};
}

/** The canary: always fresh, always published, must appear in every test. */
const FRESH_POI = poi(60, 'Taron');
const freshRow = () => row(60, 0, {waitTime: 25, open: true});

function stubbedPark(extraPois: any[], extraSignage: any[]): Phantasialand {
  const park = new Phantasialand();
  vi.spyOn(park as any, 'getPOI').mockResolvedValue([FRESH_POI, ...extraPois]);
  vi.spyOn(park as any, 'getSignage').mockResolvedValue([freshRow(), ...extraSignage]);
  return park;
}

async function live(park: Phantasialand) {
  const rows = await park.getLiveData();
  // Canary: if this ever goes missing the test is proving nothing.
  expect(rows.find((l) => l.id === '60')).toMatchObject({
    status: 'OPERATING',
    queue: {STANDBY: {waitTime: 25}},
  });
  return rows;
}

describe('Phantasialand stale signage rows', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('drops a months-old row that would publish a show as running', async () => {
    // Mystic Winter Castle: OPERATING with showtimes, last observed in February.
    const park = stubbedPark(
      [poi(223, 'Mystic Winter Castle', 'SHOWS')],
      [row(223, 4055, {showTimes: ['2026-02-14 18:00:00', '2026-02-14 19:00:00']})],
    );
    expect((await live(park)).find((l) => l.id === '223')).toBeUndefined();
  });

  it('drops a stale CLOSED row just as readily as a stale OPERATING one', async () => {
    // Staleness is about the observation, not about which way it reads.
    const park = stubbedPark(
      [poi(78, 'Hack & Buddl', 'RESTAURANTS_AND_SNACKS')],
      [row(78, 12501, {open: false})],
    );
    expect((await live(park)).find((l) => l.id === '78')).toBeUndefined();
  });

  it('drops a stale wait time rather than restating it as current', async () => {
    const park = stubbedPark(
      [poi(225, 'Black Mamba')],
      [row(225, 10077, {waitTime: 40, open: true})],
    );
    expect((await live(park)).find((l) => l.id === '225')).toBeUndefined();
  });

  it('keeps a row from earlier the same day', async () => {
    const park = stubbedPark([poi(52, 'Black Mamba')], [row(52, 6, {waitTime: 5, open: true})]);
    expect((await live(park)).find((l) => l.id === '52')).toMatchObject({
      status: 'OPERATING',
      queue: {STANDBY: {waitTime: 5}},
    });
  });

  it('keeps a row right up to the day boundary and drops it just past', async () => {
    const inside = stubbedPark([poi(52, 'Black Mamba')], [row(52, 23.9, {waitTime: 5, open: true})]);
    expect((await live(inside)).find((l) => l.id === '52')).toBeDefined();

    const outside = stubbedPark([poi(52, 'Black Mamba')], [row(52, 24.1, {waitTime: 5, open: true})]);
    expect((await live(outside)).find((l) => l.id === '52')).toBeUndefined();
  });

  it('keeps a row when any one of its timestamps is fresh', async () => {
    // Only every timestamp agreeing makes a row stale.
    const stale = new Date(NOW.getTime() - 4055 * 3600_000).toISOString();
    const park = stubbedPark(
      [poi(52, 'Black Mamba')],
      [{
        poiId: '52',
        createdAt: stale,
        updatedRow: stale,
        updatedAt: NOW.toISOString(),
        waitTime: 5,
        open: true,
      }],
    );
    expect((await live(park)).find((l) => l.id === '52')).toBeDefined();
  });

  it('keeps a row carrying no readable timestamp at all', async () => {
    // Cannot tell, so do not drop: guessing here would empty the feed if the
    // shape ever changed.
    const park = stubbedPark([poi(52, 'Black Mamba')], [{poiId: '52', waitTime: 5, open: true}]);
    expect((await live(park)).find((l) => l.id === '52')).toBeDefined();
  });

  it('ignores an unparseable timestamp rather than treating it as ancient', async () => {
    const park = stubbedPark(
      [poi(52, 'Black Mamba')],
      [{poiId: '52', updatedAt: 'not a date', createdAt: null, waitTime: 5, open: true}],
    );
    expect((await live(park)).find((l) => l.id === '52')).toBeDefined();
  });

  it('leaves a feed of entirely fresh rows untouched', async () => {
    const park = stubbedPark(
      [poi(52, 'Black Mamba'), poi(224, 'Colorado Adventure')],
      [row(52, 0, {waitTime: 5, open: true}), row(224, 0, {open: false})],
    );
    const rows = await live(park);
    expect(rows).toHaveLength(3);
    expect(rows.find((l) => l.id === '224')).toMatchObject({status: 'CLOSED'});
  });
});
