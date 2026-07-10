/**
 * Plopsa decision-logic regression tests.
 *
 * The full decision matrix for whether a ride emits OPERATING vs CLOSED.
 * The interesting case is row 3: a numeric wait time + a stale
 * `temporarily_closed: true` from POI must NOT downgrade to CLOSED, or
 * multi-collector deployments will flap any ride whose POI snapshot
 * disagrees between instances.
 */
import {describe, test, expect} from 'vitest';
import type {Entity, EntitySchedule, LiveData} from '@themeparks/typelib';
import {plopsaDecideOperating, plopsaBuildShowtimes, plopsaShowStatus, Plopsaland} from '../plopsa.js';

describe('plopsaDecideOperating', () => {
  test('park closed → ride always CLOSED regardless of other inputs', () => {
    expect(plopsaDecideOperating(false, false, false)).toBe(false);
    expect(plopsaDecideOperating(false, false, true)).toBe(false);
    expect(plopsaDecideOperating(false, true,  false)).toBe(false);
    expect(plopsaDecideOperating(false, true,  true)).toBe(false);
  });

  test('park open + ride open + has wait → OPERATING', () => {
    expect(plopsaDecideOperating(true, false, true)).toBe(true);
  });

  test('park open + ride open + no wait → OPERATING (e.g. brand-new ride before first reading)', () => {
    expect(plopsaDecideOperating(true, false, false)).toBe(true);
  });

  test('park open + POI says temp-closed + has wait → OPERATING (wait-times feed wins over stale POI hint)', () => {
    // This is the case the bug report depends on: stale POI says closed,
    // but the wait-times feed has a real number. Trust the live number.
    expect(plopsaDecideOperating(true, true, true)).toBe(true);
  });

  test('park open + POI says temp-closed + no wait → CLOSED (the hint is authoritative when no live signal)', () => {
    expect(plopsaDecideOperating(true, true, false)).toBe(false);
  });
});

describe('De Panne POI location wiring', () => {
  const fallbackLocation = {latitude: 1, longitude: 2};

  class Probe extends Plopsaland {
    protected override mapCoordinates(
      coords: {x: number; y: number} | undefined,
    ): {latitude: number; longitude: number} | undefined {
      return coords ? fallbackLocation : undefined;
    }

    public buildEntitiesForTest(): Promise<Entity[]> {
      return this.buildEntityList();
    }
  }

  function jsonResponse(payload: unknown) {
    return {json: async () => payload};
  }

  function createProbe(poiItems: unknown[]): Probe {
    const park = new Probe();
    park.fetchPOI = async () => jsonResponse({items: poiItems}) as any;
    park.fetchEntertainments = async () => jsonResponse({items: []}) as any;
    return park;
  }

  test('populates attraction location from the bundled snapshot', async () => {
    const entities = await createProbe([{
      id: 'poi-1',
      title: 'Attractions',
      type: {label: 'Attractions'},
      map_coordinates: {x: 10, y: 20},
      contains: [{
        id: 'anubis',
        title: 'Anubis The Ride',
        type: 'attraction',
      }],
    }]).buildEntitiesForTest();

    const anubis = entities.find((e) => e.id === 'anubis');
    expect(anubis?.location).toEqual({latitude: 51.081837, longitude: 2.597878});
  });

  test('prefers snapshot coordinates over mapped POI coordinates', async () => {
    const entities = await createProbe([{
      id: 'poi-1',
      title: 'Attractions',
      type: {label: 'Attractions'},
      map_coordinates: {x: 10, y: 20},
      contains: [{
        id: 'anubis',
        title: 'Anubis The Ride',
        type: 'attraction',
      }],
    }]).buildEntitiesForTest();

    const anubis = entities.find((e) => e.id === 'anubis');
    expect(anubis?.location).toEqual({latitude: 51.081837, longitude: 2.597878});
    expect(anubis?.location).not.toEqual(fallbackLocation);
  });

  test('matches snapshot titles with curly apostrophes through buildEntityList', async () => {
    const entities = await createProbe([{
      id: 'poi-1',
      title: 'Attractions',
      type: {label: 'Attractions'},
      map_coordinates: {x: 10, y: 20},
      contains: [{
        id: 'vics',
        title: 'Vic’s Whirlwind',
        type: 'attraction',
      }],
    }]).buildEntitiesForTest();

    const vics = entities.find((e) => e.id === 'vics');
    expect(vics?.location).toEqual({latitude: 51.082082, longitude: 2.5958043});
  });

  test('skips POI children without a usable title', async () => {
    const entities = await createProbe([{
      id: 'poi-1',
      title: 'Attractions',
      type: {label: 'Attractions'},
      map_coordinates: {x: 10, y: 20},
      contains: [
        {id: 'missing-title', type: 'attraction'},
        {id: 'null-title', title: null, type: 'foods_and_drinks'},
        {id: 'anubis', title: 'Anubis The Ride', type: 'attraction'},
      ],
    }]).buildEntitiesForTest();

    expect(entities.find((e) => e.id === 'missing-title')).toBeUndefined();
    expect(entities.find((e) => e.id === 'null-title')).toBeUndefined();
    expect(entities.find((e) => e.id === 'anubis')).toBeDefined();
  });
});

describe('buildSchedules feed independence', () => {
  class ScheduleProbe extends Plopsaland {
    public buildSchedulesForTest(): Promise<EntitySchedule[]> {
      return this.buildSchedules();
    }
  }

  function jsonResponse(payload: unknown) {
    return {json: async () => payload};
  }

  const showItems = [{
    id: 'show-1',
    plopsa_id: '900',
    title: 'Test Show',
    type: {label: 'Show'},
    schedule_info: {
      temporarily_closed: false,
      schedule: [{
        date: '2026-07-11',
        timeslots: [{type: 'open', start_time: '14:00', end_time: null}],
      }],
    },
  }];

  test('still returns show schedules when the park calendar fetch fails', async () => {
    const park = new ScheduleProbe();
    park.fetchCalendar = async () => { throw new Error('calendar 500'); };
    park.fetchEntertainments = async () => jsonResponse({items: showItems}) as any;

    const schedules = await park.buildSchedulesForTest();

    // Calendar failed, so no park entry — but the show schedule survives.
    expect(schedules.find((s) => s.id === 'plopsaland')).toBeUndefined();
    const show = schedules.find((s) => s.id === '900');
    expect(show?.schedule).toHaveLength(1);
    expect(show?.schedule?.[0]?.date).toBe('2026-07-11');
  });

  test('omits the park entry when the calendar yields no operating days', async () => {
    const park = new ScheduleProbe();
    park.fetchCalendar = async () => jsonResponse({schedule: {}}) as any;
    park.fetchEntertainments = async () => jsonResponse({items: []}) as any;

    expect(await park.buildSchedulesForTest()).toEqual([]);
  });
});

describe('plopsaBuildShowtimes', () => {
  const tz = 'Europe/Brussels';
  const schedule = [
    {date: '2026-07-11', timeslots: [
      {type: 'open', start_time: '14:00', end_time: null},
      {type: 'open', start_time: '16:30', end_time: '17:00'},
      {type: 'closed', start_time: '18:00', end_time: null},
    ]},
    {date: '2026-07-12', timeslots: [
      {type: 'open', start_time: '11:00', end_time: null},
    ]},
  ];

  test('returns [] for an undefined schedule or a date with no entry', () => {
    expect(plopsaBuildShowtimes(undefined, '2026-07-11', tz)).toEqual([]);
    expect(plopsaBuildShowtimes(schedule, '2026-07-13', tz)).toEqual([]);
  });

  test('builds ISO+offset slots for the matching date, skipping non-open slots', () => {
    expect(plopsaBuildShowtimes(schedule, '2026-07-11', tz)).toEqual([
      {type: 'Showtime', startTime: '2026-07-11T14:00:00+02:00', endTime: null},
      {type: 'Showtime', startTime: '2026-07-11T16:30:00+02:00', endTime: '2026-07-11T17:00:00+02:00'},
    ]);
  });
});

describe('plopsaShowStatus', () => {
  const ms = (iso: string) => Date.parse(iso);
  const slots = [
    {type: 'Showtime', startTime: '2026-07-11T14:00:00+02:00', endTime: null},
    {type: 'Showtime', startTime: '2026-07-11T16:30:00+02:00', endTime: '2026-07-11T17:00:00+02:00'},
  ];

  test('CLOSED when there are no showtimes', () => {
    expect(plopsaShowStatus([], ms('2026-07-11T12:00:00+02:00'))).toBe('CLOSED');
  });

  test('OPERATING until the last performance ends', () => {
    expect(plopsaShowStatus(slots, ms('2026-07-11T12:00:00+02:00'))).toBe('OPERATING');
    expect(plopsaShowStatus(slots, ms('2026-07-11T16:59:00+02:00'))).toBe('OPERATING');
  });

  test('CLOSED once the last performance has passed', () => {
    expect(plopsaShowStatus(slots, ms('2026-07-11T17:30:00+02:00'))).toBe('CLOSED');
  });

  test('falls back to the start time when a slot has no end time', () => {
    const pointOnly = [{type: 'Showtime', startTime: '2026-07-11T14:00:00+02:00', endTime: null}];
    expect(plopsaShowStatus(pointOnly, ms('2026-07-11T13:59:00+02:00'))).toBe('OPERATING');
    expect(plopsaShowStatus(pointOnly, ms('2026-07-11T14:01:00+02:00'))).toBe('CLOSED');
  });
});

describe('buildLiveData shows', () => {
  class LiveProbe extends Plopsaland {
    public buildLiveDataForTest(): Promise<LiveData[]> {
      return this.buildLiveData();
    }
  }

  function jsonResponse(payload: unknown) {
    return {json: async () => payload};
  }

  function todayIn(tz: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }

  test('emits show live data independently of the wait-times feed', async () => {
    const park = new LiveProbe();
    const date = todayIn('Europe/Brussels');

    park.fetchWaitTimes = async () => jsonResponse({}) as any;
    park.fetchPOI = async () => jsonResponse({items: []}) as any;
    park.fetchTodayHours = async () =>
      jsonResponse({date, timeslots: [{type: 'open', start_time: '00:00', end_time: '23:59'}]}) as any;
    park.fetchEntertainments = async () => jsonResponse({items: [
      {id: 'a', plopsa_id: '700', title: 'Show A', type: {label: 'Show'},
        schedule_info: {schedule: [{date, timeslots: [{type: 'open', start_time: '23:59', end_time: null}]}]}},
      {id: 'b', plopsa_id: '701', title: 'Meet B', type: {label: 'Meet&Greet'},
        schedule_info: {schedule: [{date: '2000-01-01', timeslots: [{type: 'open', start_time: '10:00', end_time: null}]}]}},
      {id: 'c', plopsa_id: '702', title: 'Parade C', type: {label: 'Parade'},
        schedule_info: {schedule: [{date, timeslots: [{type: 'open', start_time: '12:00', end_time: null}]}]}},
    ]}) as any;

    const live = await park.buildLiveDataForTest();

    // Show with a performance today → present with today's showtimes.
    const a = live.find((l) => l.id === '700');
    expect(a).toBeDefined();
    expect(a?.showtimes).toHaveLength(1);

    // Meet-and-greet whose only performance is on a past date → CLOSED, no showtimes.
    const b = live.find((l) => l.id === '701');
    expect(b?.status).toBe('CLOSED');
    expect(b?.showtimes).toBeUndefined();

    // Parades are not mapped as entities, so they must not appear in live data.
    expect(live.find((l) => l.id === '702')).toBeUndefined();
  });
});
