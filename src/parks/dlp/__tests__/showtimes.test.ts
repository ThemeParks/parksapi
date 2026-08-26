import {describe, it, expect, vi, afterEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';

/**
 * The schedule feed reports every PERFORMANCE_TIME slot with endTime equal to
 * startTime, so a show's window has to come from its POI duration. Shows
 * without a published duration keep the feed's own endTime.
 */
function stubbedPark(): DisneylandParis {
  const park = new DisneylandParis();

  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({
    ThemePark: [{id: 'P1', name: 'Disneyland Park', type: 'ThemePark'}],
    Entertainment: [
      {
        id: 'P1GS21',
        name: 'Disney Stars on Parade',
        type: 'Entertainment',
        subType: 'Parade',
        location: {id: 'P1'},
        duration: {hours: 0, minutes: 30},
      },
      {
        id: 'P1GS99',
        name: 'Disney Tales of Magic',
        type: 'Entertainment',
        subType: 'Fireworks',
        location: {id: 'P1'},
        duration: {hours: 1, minutes: 5},
      },
      {
        // No duration published — must fall back to the feed's endTime.
        id: 'P2GS54',
        name: 'Animation Academy',
        type: 'Entertainment',
        subType: 'Stage Show',
        location: {id: 'P1'},
      },
    ],
  });

  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue([]);
  vi.spyOn(park as any, 'getPremierAccess').mockResolvedValue([]);
  vi.spyOn(park as any, 'getVirtualQueueData').mockResolvedValue([]);
  vi.spyOn(park as any, 'getScheduleForDate').mockImplementation(async (date) => [
    {
      id: 'P1GS21',
      schedules: [{date, startTime: '17:30:00', endTime: '17:30:00', status: 'PERFORMANCE_TIME'}],
    },
    {
      id: 'P1GS99',
      schedules: [{date, startTime: '22:45:00', endTime: '22:45:00', status: 'PERFORMANCE_TIME'}],
    },
    {
      // No duration published — the feed's zero-length slot survives.
      id: 'P2GS54',
      schedules: [{date, startTime: '10:30:00', endTime: '10:30:00', status: 'PERFORMANCE_TIME'}],
    },
  ]);

  return park;
}

/** Minutes between two ISO timestamps. */
function spanMinutes(startTime: string, endTime: string): number {
  return (new Date(endTime).getTime() - new Date(startTime).getTime()) / 60000;
}

describe('DLP showtimes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('derives the end time from the POI duration', async () => {
    const live = await stubbedPark().getLiveData();

    const parade = live.find((l) => l.id === 'P1GS21');
    expect(parade?.showtimes).toHaveLength(1);
    expect(spanMinutes(parade!.showtimes![0].startTime!, parade!.showtimes![0].endTime!)).toBe(30);
  });

  it('folds an aliased twin onto the published id, with its duration', async () => {
    // ID_ALIASES promises live rows for the hidden PhilharMagic twin fold onto
    // the published record, and the wait-time path honours that. This path did
    // not: it read the duration under the raw feed id, found nothing, then
    // handed the raw id to getOrCreate, which drops it for not being a
    // published entity. The row vanished and the schedule path disagreed with
    // the live one by the show's whole running time.
    const park = new DisneylandParis();
    vi.spyOn(park as any, 'getPOIData').mockResolvedValue({
      ThemePark: [{id: 'P1', name: 'Disneyland Park', type: 'ThemePark'}],
      Entertainment: [{
        id: 'P1G103', name: 'Mickey’s PhilharMagic', type: 'Entertainment',
        subType: 'Stage Show', location: {id: 'P1'}, duration: {hours: 0, minutes: 12},
      }],
    });
    vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue([]);
    vi.spyOn(park as any, 'getPremierAccess').mockResolvedValue([]);
    vi.spyOn(park as any, 'getVirtualQueueData').mockResolvedValue([]);
    vi.spyOn(park as any, 'getScheduleForDate').mockImplementation(async (date: string) => [{
      id: 'P1DA13', // the hidden twin
      schedules: [{date, startTime: '12:30:00', endTime: '12:30:00', status: 'PERFORMANCE_TIME'}],
    }]);

    const live = await park.getLiveData();
    const show = live.find((l) => l.id === 'P1G103');
    expect(show?.showtimes).toHaveLength(1);
    expect(spanMinutes(show!.showtimes![0].startTime!, show!.showtimes![0].endTime!)).toBe(12);
    // And nothing published under the raw feed id.
    expect(live.find((l) => l.id === 'P1DA13')).toBeUndefined();
  });

  it('adds hours and minutes together', async () => {
    const live = await stubbedPark().getLiveData();

    const fireworks = live.find((l) => l.id === 'P1GS99');
    expect(spanMinutes(fireworks!.showtimes![0].startTime!, fireworks!.showtimes![0].endTime!)).toBe(65);
  });

  it('keeps the feed end time when no duration is published', async () => {
    const live = await stubbedPark().getLiveData();

    const show = live.find((l) => l.id === 'P2GS54');
    expect(show?.showtimes).toHaveLength(1);
    expect(spanMinutes(show!.showtimes![0].startTime!, show!.showtimes![0].endTime!)).toBe(0);
  });

  it('resolves the same durations with and without a preceding getEntities call', async () => {
    // getLiveData is a standalone entry point; both call orders must agree.
    const cold = stubbedPark();
    const coldLive = await cold.getLiveData();

    const warm = stubbedPark();
    await warm.getEntities();
    const warmLive = await warm.getLiveData();

    for (const live of [coldLive, warmLive]) {
      const parade = live.find((l) => l.id === 'P1GS21');
      expect(spanMinutes(parade!.showtimes![0].startTime!, parade!.showtimes![0].endTime!)).toBe(30);
    }
    expect(warmLive.find((l) => l.id === 'P1GS21')?.showtimes)
      .toEqual(coldLive.find((l) => l.id === 'P1GS21')?.showtimes);
  });
});

/** Feeds one show with the given duration through the live-data path. */
function parkWithDuration(duration: unknown): DisneylandParis {
  const park = new DisneylandParis();

  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({
    ThemePark: [{id: 'P1', name: 'Disneyland Park', type: 'ThemePark'}],
    Entertainment: [{
      id: 'P1GS21',
      name: 'Disney Stars on Parade',
      type: 'Entertainment',
      subType: 'Parade',
      location: {id: 'P1'},
      duration,
    }],
  });
  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue([]);
  vi.spyOn(park as any, 'getPremierAccess').mockResolvedValue([]);
  vi.spyOn(park as any, 'getVirtualQueueData').mockResolvedValue([]);
  vi.spyOn(park as any, 'getScheduleForDate').mockImplementation(async (date) => [
    {
      id: 'P1GS21',
      schedules: [{date, startTime: '17:30:00', endTime: '17:35:00', status: 'PERFORMANCE_TIME'}],
    },
  ]);

  return park;
}

async function spanFor(duration: unknown): Promise<number> {
  const live = await parkWithDuration(duration).getLiveData();
  const show = live.find((l) => l.id === 'P1GS21');
  return spanMinutes(show!.showtimes![0].startTime!, show!.showtimes![0].endTime!);
}

describe('DLP showtime duration parsing', () => {
  afterEach(() => vi.restoreAllMocks());

  // The feed reports 17:30 to 17:35, so a 5 minute span means the duration was
  // rejected and the feed's own end time survived.
  it.each([
    ['missing', undefined],
    ['empty', {}],
    ['null members', {hours: null, minutes: null}],
    ['zero', {hours: 0, minutes: 0}],
    ['negative', {hours: 0, minutes: -20}],
    ['not a number', {hours: 'soon', minutes: 'later'}],
    ['longer than a day', {hours: 99999, minutes: 0}],
  ])('falls back to the feed end time when the duration is %s', async (_label, duration) => {
    expect(await spanFor(duration)).toBe(5);
  });

  it('coerces numeric strings instead of concatenating them', async () => {
    expect(await spanFor({hours: '1', minutes: '30'})).toBe(90);
    expect(await spanFor({minutes: '45'})).toBe(45);
  });
});
