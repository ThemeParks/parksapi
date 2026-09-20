/**
 * Raw upstream pieces behind each element (`raw`, `includeRaw`, `addRaw`,
 * `attachRaw`, `rawSource`).
 *
 * A consumer that stores the data itself can opt into the slice of the
 * upstream response each entity, live-data row and schedule entry was built
 * from. Off by default: the public getters then strip `raw` from anything a
 * park set, so the default output is unchanged.
 */

import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {Destination, attachRaw, type WithRaw} from '../destination.js';
import config from '../config.js';
import {CacheLib} from '../cache.js';
import {Entity, LiveData, EntitySchedule, ScheduleEntry} from '@themeparks/typelib';

const signageRow = {poiId: '12', waitTime: 25, open: true, showTimes: null};
const showRow = {showId: 7, today: ['11:00', '14:00']};
const calendarDay = {dayNr: 21, openingHoursFrom: '10:00:00', openingHoursTo: '18:00:00'};
const poiItem = {Id: 12, Name: 'Colossos', Lat: 53.02, Lng: 9.87};

@config
class RawTestDestination extends Destination {
  public liveIds: string[] = ['12', '7'];

  constructor(opts?: {includeRaw?: boolean; retire?: boolean}) {
    super();
    if (opts?.includeRaw !== undefined) this.includeRaw = opts.includeRaw;
    if (opts?.retire !== undefined) this.retireMissingLiveEntities = opts.retire;
  }

  async getDestinations(): Promise<Entity[]> {
    return [{id: 'resort', name: 'Resort', entityType: 'DESTINATION', timezone: 'UTC'} as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const park = {id: 'park', name: 'Park', entityType: 'PARK', parentId: 'resort', destinationId: 'resort', timezone: 'UTC'} as Entity;
    const ride = this.addRaw(
      {id: '12', name: 'Ride', entityType: 'ATTRACTION', parentId: 'park', destinationId: 'resort', timezone: 'UTC'} as Entity,
      'poi', poiItem,
    );
    // A park that sets `raw` by hand instead of through the helper
    const show = {id: '7', name: 'Show', entityType: 'SHOW', parentId: 'park', destinationId: 'resort', timezone: 'UTC', raw: {poi: showRow}} as WithRaw<Entity>;
    return [park, ride, show];
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    return this.liveIds.map((id) => {
      if (id === '12') {
        const ld = this.addRaw({id, status: 'OPERATING', queue: {STANDBY: {waitTime: 25}}} as LiveData, 'signage', signageRow);
        return this.addRaw(ld, 'showTimes', showRow);
      }
      return {id, status: 'OPERATING', raw: {direct: showRow}} as WithRaw<LiveData>;
    });
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const day = this.addRaw(
      {date: '2026-09-21', type: 'OPERATING', openingTime: '2026-09-21T10:00:00+02:00', closingTime: '2026-09-21T18:00:00+02:00'} as ScheduleEntry,
      'calendar', calendarDay,
    );
    const direct = {date: '2026-09-22', type: 'OPERATING', openingTime: '2026-09-22T10:00:00+02:00', closingTime: '2026-09-22T18:00:00+02:00', raw: {calendar: calendarDay}} as WithRaw<ScheduleEntry>;
    return [{id: 'park', schedule: [day, direct]}];
  }

  protected async *buildLiveDataStream(): AsyncGenerator<LiveData[]> {
    yield [this.addRaw({id: '12', status: 'DOWN'} as LiveData, 'stream', signageRow)];
    yield [{id: '7', status: 'CLOSED', raw: {direct: showRow}} as WithRaw<LiveData>];
  }

  public mapWithRaw(rawSource?: string): Entity[] {
    return this.mapEntities([poiItem], {
      idField: 'Id',
      nameField: 'Name',
      entityType: 'ATTRACTION',
      parentIdField: () => 'park',
      locationFields: {lat: 'Lat', lng: 'Lng'},
      destinationId: 'resort',
      timezone: 'UTC',
      rawSource,
    });
  }
}

const rawOf = (element: object): unknown => (element as WithRaw<object>).raw;

describe('raw upstream pieces', () => {
  beforeEach(() => {
    CacheLib.clearByClassName('RawTestDestination', {includePersistent: true});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('includeRaw defaults to false', () => {
    expect(new RawTestDestination().includeRaw).toBe(false);
  });

  test('off: no element carries raw, not even one a park set by hand', async () => {
    const park = new RawTestDestination();

    const entities = await park.getEntities();
    expect(entities).toHaveLength(4);
    for (const entity of entities) expect(rawOf(entity)).toBeUndefined();

    const live = await park.getLiveData();
    expect(live).toHaveLength(2);
    for (const entry of live) expect(rawOf(entry)).toBeUndefined();
    expect(live[0]).toEqual({id: '12', status: 'OPERATING', queue: {STANDBY: {waitTime: 25}}});

    const schedules = await park.getSchedules();
    expect(schedules).toHaveLength(1);
    for (const entry of schedules[0].schedule) expect(rawOf(entry)).toBeUndefined();

    const streamed: LiveData[] = [];
    for await (const batch of park.streamLiveData()) streamed.push(...batch);
    expect(streamed).toHaveLength(2);
    for (const entry of streamed) expect(rawOf(entry)).toBeUndefined();
  });

  test('on: raw carries the pieces under their request names, unchanged and uncopied', async () => {
    const park = new RawTestDestination({includeRaw: true});

    const entities = await park.getEntities();
    const ride = entities.find((e) => e.id === '12') as WithRaw<Entity>;
    expect(Object.keys(ride.raw!)).toEqual(['poi']);
    expect(ride.raw!.poi).toBe(poiItem);
    const show = entities.find((e) => e.id === '7') as WithRaw<Entity>;
    expect(show.raw).toEqual({poi: showRow});
    // Structural entities built from constants carry nothing
    expect(rawOf(entities.find((e) => e.id === 'resort')!)).toBeUndefined();
    expect(rawOf(entities.find((e) => e.id === 'park')!)).toBeUndefined();

    const live = await park.getLiveData();
    const rideLive = live.find((d) => d.id === '12') as WithRaw<LiveData>;
    expect(Object.keys(rideLive.raw!)).toEqual(['signage', 'showTimes']);
    expect(rideLive.raw!.signage).toBe(signageRow);
    expect(rideLive.raw!.showTimes).toBe(showRow);
    expect(rideLive.queue).toEqual({STANDBY: {waitTime: 25}});

    const schedules = await park.getSchedules();
    const [day, direct] = schedules[0].schedule as WithRaw<ScheduleEntry>[];
    expect(day.raw).toEqual({calendar: calendarDay});
    expect(day.raw!.calendar).toBe(calendarDay);
    expect(direct.raw).toEqual({calendar: calendarDay});

    const streamed: LiveData[] = [];
    for await (const batch of park.streamLiveData()) streamed.push(...batch);
    expect((streamed[0] as WithRaw<LiveData>).raw).toEqual({stream: signageRow});
    expect((streamed[1] as WithRaw<LiveData>).raw).toEqual({direct: showRow});
  });

  test('two addRaw calls on one element give two keys, a repeated key replaces', () => {
    const park = new RawTestDestination({includeRaw: true});
    const element = {id: 'x'} as LiveData;
    const addRaw = (park as unknown as {addRaw: (e: object, s: string, p: unknown) => object}).addRaw.bind(park);

    addRaw(element, 'first', 1);
    addRaw(element, 'second', 2);
    expect(rawOf(element)).toEqual({first: 1, second: 2});

    addRaw(element, 'first', 3);
    expect(rawOf(element)).toEqual({first: 3, second: 2});
  });

  test('mapEntities attaches the source item under rawSource, and only then', () => {
    const on = new RawTestDestination({includeRaw: true});
    const [withSource] = on.mapWithRaw('poiData');
    expect((withSource as WithRaw<Entity>).raw!.poiData).toBe(poiItem);
    expect(withSource.location).toEqual({latitude: 53.02, longitude: 9.87});

    const [withoutSource] = on.mapWithRaw();
    expect(rawOf(withoutSource)).toBeUndefined();

    const off = new RawTestDestination();
    const [flagOff] = off.mapWithRaw('poiData');
    expect(rawOf(flagOff)).toBeUndefined();
  });

  test('a retirement CLOSED row has no raw', async () => {
    vi.useFakeTimers();
    const park = new RawTestDestination({includeRaw: true, retire: true});

    park.liveIds = ['12', '7'];
    await park.getLiveData();

    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    park.liveIds = ['12'];
    await park.getLiveData();
    await park.getLiveData();
    const live = await park.getLiveData();

    expect(live.find((d) => d.id === '7')).toEqual({id: '7', status: 'CLOSED'});
    expect((live.find((d) => d.id === '12') as WithRaw<LiveData>).raw!.signage).toBe(signageRow);
  });

  test('null values inside a piece survive the undefined scrub', async () => {
    const park = new RawTestDestination({includeRaw: true});
    const live = await park.getLiveData();
    const piece = (live.find((d) => d.id === '12') as WithRaw<LiveData>).raw!.signage as typeof signageRow;
    expect(piece).toBe(signageRow);
    expect(piece.showTimes).toBeNull();
    expect(Object.keys(piece)).toEqual(['poiId', 'waitTime', 'open', 'showTimes']);
  });

  test('attachRaw attaches regardless of any flag, addRaw only with the flag on', () => {
    const element = {id: 'x'} as LiveData;
    expect(attachRaw(element, 'source', signageRow)).toBe(element);
    expect(rawOf(element)).toEqual({source: signageRow});

    const off = new RawTestDestination();
    const untouched = {id: 'y'} as LiveData;
    const addRaw = (off as unknown as {addRaw: (e: object, s: string, p: unknown) => object}).addRaw.bind(off);
    expect(addRaw(untouched, 'source', signageRow)).toBe(untouched);
    expect(rawOf(untouched)).toBeUndefined();
  });
});
