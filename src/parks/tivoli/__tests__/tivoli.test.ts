import {describe, test, expect, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {
  Tivoli,
  tivoliDateWindow,
  tivoliHeightTags,
  tivoliHoursEntry,
  tivoliRestaurantEntities,
  tivoliRideEntities,
  tivoliRideSchedules,
  tivoliScheduleEntries,
  type TivoliBatchHours,
  type TivoliContentFeed,
  type TivoliContentItem,
  type TivoliHoursRow,
} from '../tivoli.js';

/**
 * Tivoli's content API lists rides and restaurants with static data, and a
 * separate opening-hours API publishes hours per park and per ride.
 *
 * The ride batch reports `status: "Open"` for a ride in service this season,
 * synced nightly. The closed-day fixture was captured on a day the park had no
 * hours for a week: every ride reads "Open" and carries no hours. Nothing here
 * may turn that status into an open ride.
 *
 * Fixtures are trimmed from the live responses captured on 2026-11-06.
 */

const TZ = 'Europe/Copenhagen';
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = <T>(name: string): T => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));

const ridesFeed = fixture<TivoliContentFeed>('rides.json');
const foodFeed = fixture<TivoliContentFeed>('food.json');
const parkHours = fixture<{hours: TivoliHoursRow[]}>('park-hours.json');
const closedDay = fixture<TivoliBatchHours>('ride-hours-closed-day.json');
const openWeek = fixture<TivoliBatchHours>('ride-hours-open-week.json');

const ctx = {destinationId: 'tivoli', parkId: 'tivoligardens', timezone: TZ};
const ride = (name: string): TivoliContentItem =>
  ridesFeed.items.find(i => i.properties.entityName === name)!;

const item = (properties: TivoliContentItem['properties'], contentType = 'rideEntity'): TivoliContentItem => ({
  contentType,
  id: 'abc',
  properties,
});

describe('tivoliRideEntities', () => {
  const entities = tivoliRideEntities(ridesFeed, ctx);

  test('every ride in the feed becomes an attraction under the park', () => {
    expect(ridesFeed.items).toHaveLength(33);
    expect(entities).toHaveLength(33);
    for (const e of entities) {
      expect(e.entityType).toBe('ATTRACTION');
      expect(e.attractionType).toBe('RIDE');
      expect(e.parentId).toBe('tivoligardens');
      expect(e.destinationId).toBe('tivoli');
      expect(e.timezone).toBe(TZ);
      expect(typeof e.id).toBe('string');
      expect(e.location?.latitude).toBeGreaterThan(55);
      expect(e.location?.longitude).toBeGreaterThan(12);
    }
  });

  test('the entity id is the content id, not the CRM id', () => {
    const aquila = entities.find(e => e.name === 'Aquila')!;
    expect(aquila.id).toBe(ride('Aquila').id);
    expect(aquila.id).not.toBe(ride('Aquila').properties.crmId);
  });

  test('ids are unique', () => {
    expect(new Set(entities.map(e => e.id)).size).toBe(entities.length);
  });

  test('a row with no name or no id is dropped, other content types are ignored', () => {
    const feed: TivoliContentFeed = {
      items: [
        item({entityName: '  '}),
        {contentType: 'rideEntity', id: '', properties: {entityName: 'No id'}},
        item({entityName: 'Food', latitude: 55.6, longitude: 12.5}, 'foodEntity'),
        item({entityName: 'Real ride', latitude: 55.6, longitude: 12.5}),
      ],
    };
    expect(tivoliRideEntities(feed, ctx).map(e => e.name)).toEqual(['Real ride']);
  });

  test('missing, non-finite and 0,0 coordinates give no location rather than a bad one', () => {
    const feed: TivoliContentFeed = {
      items: [
        {...item({entityName: 'null coords', latitude: null, longitude: null}), id: '1'},
        {...item({entityName: 'zero coords', latitude: 0, longitude: 0}), id: '2'},
        {...item({entityName: 'string coords', latitude: '55.6' as any, longitude: '12.5' as any}), id: '3'},
        {...item({entityName: 'NaN coords', latitude: NaN, longitude: 12.5}), id: '4'},
      ],
    };
    for (const e of tivoliRideEntities(feed, ctx)) expect(e.location, String(e.name)).toBeUndefined();
  });
});

describe('tivoliHeightTags', () => {
  const kinds = (i: TivoliContentItem) => tivoliHeightTags(i).map(t => [t.tag, (t.value as any).height]);

  test('a ride that is lower with an adult gets both tags', () => {
    expect(ride('The Astronomer').properties.minHeight).toBe(120);
    expect(ride('The Astronomer').properties.minHeightWithAdult).toBe(95);
    expect(kinds(ride('The Astronomer'))).toEqual([
      ['MINIMUM_HEIGHT', 95],
      ['MINIMUM_HEIGHT_UNACCOMPANIED', 120],
    ]);
  });

  test('equal heights give one minimum and no unaccompanied tag', () => {
    expect(kinds(ride('The Demon'))).toEqual([['MINIMUM_HEIGHT', 132]]);
  });

  test('a single height is the minimum', () => {
    expect(kinds(ride('Aquila'))).toEqual([['MINIMUM_HEIGHT', 120]]);
  });

  test('a minimum age is not a height', () => {
    expect(ride('Hotel Hikari').properties.minAge).toBe(10);
    expect(kinds(ride('Hotel Hikari'))).toEqual([]);
  });

  test('zero, negative and non-numeric heights are ignored', () => {
    expect(kinds(item({minHeight: 0, minHeightWithAdult: null}))).toEqual([]);
    expect(kinds(item({minHeight: -5}))).toEqual([]);
    expect(kinds(item({minHeight: '' as any}))).toEqual([]);
  });
});

describe('tivoliRestaurantEntities', () => {
  test('food entries become restaurants under the park', () => {
    const entities = tivoliRestaurantEntities(foodFeed, ctx);
    expect(entities).toHaveLength(foodFeed.items.length);
    for (const e of entities) {
      expect(e.entityType).toBe('RESTAURANT');
      expect(e.parentId).toBe('tivoligardens');
    }
  });

  test('rides are not restaurants', () => {
    expect(tivoliRestaurantEntities(ridesFeed, ctx)).toEqual([]);
  });
});

describe('tivoliHoursEntry', () => {
  const row = (over: Partial<TivoliHoursRow> = {}): TivoliHoursRow => ({
    id: 'r1',
    fromDatetime: '2026-11-13T10:00:00Z',
    toDatetime: '2026-11-13T22:00:00Z',
    statecode: 'Active',
    tivoliDay: '2026-11-12T23:00:00Z',
    ...over,
  });

  test('winter hours: UTC instants become Copenhagen time, the date is the local day', () => {
    expect(tivoliHoursEntry(row(), TZ)).toEqual({
      date: '2026-11-13',
      type: 'OPERATING',
      openingTime: '2026-11-13T11:00:00+01:00',
      closingTime: '2026-11-13T23:00:00+01:00',
    });
  });

  test('summer hours carry the summer offset, and the local day starts at 22:00Z', () => {
    expect(tivoliHoursEntry(row({
      fromDatetime: '2026-07-01T08:00:00Z',
      toDatetime: '2026-07-01T21:00:00Z',
      tivoliDay: '2026-06-30T22:00:00Z',
    }), TZ)).toEqual({
      date: '2026-07-01',
      type: 'OPERATING',
      openingTime: '2026-07-01T10:00:00+02:00',
      closingTime: '2026-07-01T23:00:00+02:00',
    });
  });

  test('the date is not the UTC day of tivoliDay', () => {
    // 2026-11-12T23:00Z is still the 12th in UTC. The park's day is the 13th.
    expect(tivoliHoursEntry(row(), TZ)!.date).not.toBe('2026-11-12');
  });

  test('inactive, reversed, empty and unparseable rows are dropped', () => {
    expect(tivoliHoursEntry(row({statecode: 'Inactive'}), TZ)).toBeUndefined();
    expect(tivoliHoursEntry(row({toDatetime: '2026-11-13T09:00:00Z'}), TZ)).toBeUndefined();
    expect(tivoliHoursEntry(row({toDatetime: '2026-11-13T10:00:00Z'}), TZ)).toBeUndefined();
    expect(tivoliHoursEntry(row({fromDatetime: 'not a date'}), TZ)).toBeUndefined();
    expect(tivoliHoursEntry(row({tivoliDay: ''}), TZ)).toBeUndefined();
  });
});

describe('tivoliScheduleEntries (park hours)', () => {
  const entries = tivoliScheduleEntries(parkHours.hours, TZ);

  test('every published day is one OPERATING entry, in date order', () => {
    expect(entries.length).toBe(parkHours.hours.length);
    expect(entries.every(e => e.type === 'OPERATING')).toBe(true);
    const dates = entries.map(e => e.date as string);
    expect([...dates].sort()).toEqual(dates);
  });

  test('a day the feed does not publish is not invented', () => {
    // The feed has 23 and 25 December and nothing for Christmas Eve. Read in
    // UTC the same rows are dated the 22nd and 24th, which is how the gap was
    // first mis-read as the 23rd.
    const dates = entries.map(e => e.date);
    expect(dates).toContain('2026-12-23');
    expect(dates).toContain('2026-12-25');
    expect(dates).not.toContain('2026-12-24');
  });

  test('the first published day is the opening day', () => {
    expect(entries[0]).toEqual({
      date: '2026-11-13',
      type: 'OPERATING',
      openingTime: '2026-11-13T11:00:00+01:00',
      closingTime: '2026-11-13T23:00:00+01:00',
    });
  });

  test('a repeated row id is counted once', () => {
    const doubled = [...parkHours.hours, ...parkHours.hours];
    expect(tivoliScheduleEntries(doubled, TZ)).toHaveLength(entries.length);
  });

  test('no rows, or no array, gives no entries', () => {
    expect(tivoliScheduleEntries([], TZ)).toEqual([]);
    expect(tivoliScheduleEntries(undefined as any, TZ)).toEqual([]);
  });
});

describe('tivoliRideSchedules', () => {
  const rides = ridesFeed.items;

  test('a day with no hours publishes no schedule, even though every ride reads Open', () => {
    // The regression: status is "in service this season", not "operating now".
    expect(closedDay.items.some(i => i.status === 'Open')).toBe(true);
    expect(closedDay.items.every(i => i.hours.length === 0)).toBe(true);
    expect(tivoliRideSchedules(rides, closedDay, TZ)).toEqual([]);
  });

  test('a ride with hours gets them, joined on the CRM id', () => {
    const schedules = tivoliRideSchedules(rides, openWeek, TZ);
    const aquila = schedules.find(s => s.id === ride('Aquila').id)!;
    expect(aquila.schedule).toHaveLength(7);
    expect(aquila.schedule[0]).toEqual({
      date: '2026-11-13',
      type: 'OPERATING',
      openingTime: '2026-11-13T11:15:00+01:00',
      closingTime: '2026-11-13T22:50:00+01:00',
    });
  });

  test('a seasonally closed ride with no hours gets no schedule', () => {
    const closed = openWeek.items.filter(i => i.status === 'Closed');
    expect(closed.length).toBeGreaterThan(0);
    const ids = new Set(tivoliRideSchedules(rides, openWeek, TZ).map(s => s.id));
    for (const c of closed) {
      const rideId = rides.find(r => r.properties.crmId === c.id)?.id;
      if (rideId) expect(ids.has(rideId), c.name).toBe(false);
    }
  });

  test('the join ignores names: the hours API calls the ice rink by its Danish name', () => {
    const rink = openWeek.items.find(i => i.name === 'Skøjtebanen');
    expect(rink).toBeDefined();
    expect(ride('Ice Skating Rink').properties.crmId).toBe(rink!.id);
  });

  test('an asset the content feed does not know is ignored', () => {
    const batch: TivoliBatchHours = {
      items: [{id: 'unknown-crm-id', hours: [{
        id: 'h', fromDatetime: '2026-11-13T10:00:00Z', toDatetime: '2026-11-13T20:00:00Z',
        statecode: 'Active', tivoliDay: '2026-11-12T23:00:00Z',
      }]}],
    };
    expect(tivoliRideSchedules(rides, batch, TZ)).toEqual([]);
  });
});

describe('tivoliDateWindow', () => {
  test('"today" is the park day, not the UTC day', () => {
    // 23:30 UTC on 6 November is 00:30 on 7 November in Copenhagen.
    const now = new Date('2026-11-06T23:30:00Z');
    expect(tivoliDateWindow(now, TZ, 0).from).toBe('2026-11-07');
  });

  test('the end of the window is the park day `days` later', () => {
    const now = new Date('2026-11-06T10:00:00Z');
    expect(tivoliDateWindow(now, TZ, 180)).toEqual({from: '2026-11-06', to: '2027-05-05'});
  });
});

describe('Tivoli', () => {
  const make = () => new Tivoli();

  test('the destination is Tivoli Gardens in Copenhagen', async () => {
    const [dest] = await make().getDestinations();
    expect(dest).toMatchObject({id: 'tivoli', name: 'Tivoli Gardens', entityType: 'DESTINATION', timezone: TZ});
  });

  test('entities are a park, its rides and its restaurants', async () => {
    const park = make();
    vi.spyOn(park, 'getRides').mockResolvedValue(ridesFeed.items);
    vi.spyOn(park, 'getRestaurants').mockResolvedValue(foodFeed.items);
    const entities = await (park as any).buildEntityList();
    const types = entities.reduce((acc: Record<string, number>, e: any) => ({...acc, [e.entityType]: (acc[e.entityType] ?? 0) + 1}), {});
    expect(types).toEqual({PARK: 1, ATTRACTION: 33, RESTAURANT: foodFeed.items.length});
  });

  test('an empty ride feed fails the build instead of publishing an empty park', async () => {
    const park = make();
    vi.spyOn(park, 'getRides').mockResolvedValue([]);
    vi.spyOn(park, 'getRestaurants').mockResolvedValue(foodFeed.items);
    await expect((park as any).buildEntityList()).rejects.toThrow(/no attractions/);
  });

  test('a content feed with no items array is an error, not an empty list', async () => {
    const park = make();
    vi.spyOn(park, 'fetchContent').mockResolvedValue({json: async () => ({total: 0})} as any);
    await expect(park.getRides()).rejects.toThrow(/no items array/);
  });

  test('a feed reporting more rows than one page is an error, not a silent truncation', async () => {
    const park = make();
    vi.spyOn(park, 'fetchContent').mockResolvedValue({json: async () => ({total: 900, items: []})} as any);
    await expect(park.getRestaurants()).rejects.toThrow(/more than one page/);
  });

  test('live data is empty and makes no request: a ride reading "Open" is not an open ride', async () => {
    const park = make();
    const fetched = [
      vi.spyOn(park, 'fetchContent'),
      vi.spyOn(park, 'fetchParkHours'),
      vi.spyOn(park, 'fetchRideHours'),
    ];
    expect(await park.getLiveData()).toEqual([]);
    for (const spy of fetched) expect(spy).not.toHaveBeenCalled();
  });

  test('schedules are the park first, then each ride that has hours', async () => {
    const park = make();
    vi.spyOn(park, 'getRides').mockResolvedValue(ridesFeed.items);
    vi.spyOn(park, 'fetchParkHours').mockResolvedValue({json: async () => parkHours} as any);
    const batch = vi.spyOn(park, 'fetchRideHours').mockResolvedValue({json: async () => openWeek} as any);
    const schedules = await (park as any).buildSchedules();
    expect(schedules[0].id).toBe('tivoligardens');
    expect(schedules[0].schedule.length).toBe(parkHours.hours.length);
    expect(schedules.slice(1).every((s: any) => s.schedule.length > 0)).toBe(true);
    // The batch is asked for every ride's CRM id, in one call.
    const asked = batch.mock.calls[0][0];
    expect(asked).toHaveLength(33);
    expect(new Set(asked)).toEqual(new Set(ridesFeed.items.map(r => r.properties.crmId)));
  });
});
