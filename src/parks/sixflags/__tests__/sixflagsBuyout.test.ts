import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {SixFlags} from '../sixflags.js';
import {CacheLib} from '../../../cache.js';
import type {EntitySchedule} from '@themeparks/typelib';

/**
 * The operating-hours feed marks a private buyout by setting `isBuyout: true`
 * on the Park window it publishes for that day. The park is open that day, but
 * only to the group that bought it out. Publishing the window as OPERATING
 * told the public the park was open: Six Flags Over Texas showed five extra
 * open days in November 2026 (the 7th, 8th, 13th, 15th and 21st) that the
 * park's own calendar does not list.
 *
 * A buyout day is published as PRIVATE_EVENT instead. Downstream, that type
 * means "not open to the public".
 *
 * The day shapes below are the ones the feed served for Six Flags Over Texas
 * (parkId 901) in November 2026.
 */

const SFOT = 901;
const DALLAS = {latitude: '32.76', longitude: '-97.07'};

type Item = {timeFrom: string; timeTo: string; isBuyout?: unknown};
type Day = {date: string; isParkClosed: boolean; venues: unknown[]; operatings: unknown[]};

/** One feed day whose Park window is made of `items`. */
function day(iso: string, items: Item[], extra: Partial<Day> = {}): Day {
  return {
    date: `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`,
    isParkClosed: false,
    venues: [],
    operatings: items.length === 0 ? [] : [{
      operatingTypeId: 24,
      operatingTypeName: 'Park',
      items: items.map(i => ({assignmentDisplayName: 'Park', assignmentDescription: '', ...i})),
    }],
    ...extra,
  };
}

/** A venue's per-ride hours, as the feed lists them under `venues`. */
const venue = (venueId: number, hours: Array<[string, string]>) =>
  ({venueId, detailHours: hours.map(([operatingTimeFrom, operatingTimeTo]) => ({operatingTimeFrom, operatingTimeTo}))});

const toYmd = (mdy: string) => `${mdy.slice(6, 10)}${mdy.slice(0, 2)}${mdy.slice(3, 5)}`;

class Probe extends SixFlags {
  public calendar: Day[] = [];

  constructor() {
    super({config: {timezone: 'UTC', baseUrl: 'https://vendor.invalid'}});
  }

  override async getParkData(): Promise<any> {
    return [{parkId: SFOT, code: 'SFOT', name: 'SFOT', waterParks: []}];
  }

  override async getPOI(): Promise<any> {
    return [{fimsId: 'RIDE-901-00001', name: 'Ride', parkId: SFOT, venueId: 1, location: DALLAS}];
  }

  override async getVenueStatus(): Promise<any> {
    return {venues: [{venueId: 1, details: [{fimsId: 'RIDE-901-00001', status: 'Opened'}]}]};
  }

  override async getWaitTimes(): Promise<any> {
    return null;
  }

  override async fetchOperatingHours(_parkId: number, date: string): Promise<any> {
    const dates = this.calendar.filter(d => toYmd(d.date).startsWith(date));
    return {json: async () => ({dates})};
  }

  public async scheduleForTest() {
    const schedules: EntitySchedule[] = await this.getSchedules();
    return schedules.find(s => s.id === 'sixflags_park_SFOT')?.schedule ?? [];
  }
}

beforeEach(() => {
  vi.useFakeTimers({toFake: ['Date']});
  // Wednesday 28 October 2026, midday Central. November is in the window.
  vi.setSystemTime(new Date('2026-10-28T17:00:00Z'));
  CacheLib.clearByClassName('Probe');
  CacheLib.clearByClassName('SixFlags');
});

afterEach(() => {
  vi.useRealTimers();
});

const on = (schedule: Awaited<ReturnType<Probe['scheduleForTest']>>, date: string) =>
  schedule.filter(e => e.date === date).map(e => ({type: e.type, open: e.openingTime, close: e.closingTime}));

describe('buyout days in the schedule', () => {
  test('a public day is still OPERATING', async () => {
    const probe = new Probe();
    probe.calendar = [day('2026-11-01', [{timeFrom: '12:00', timeTo: '22:00', isBuyout: false}])];

    expect(on(await probe.scheduleForTest(), '2026-11-01')).toEqual([
      {type: 'OPERATING', open: '2026-11-01T12:00:00-06:00', close: '2026-11-01T22:00:00-06:00'},
    ]);
  });

  test('a day with no isBuyout field is OPERATING, as every park before this fix', async () => {
    const probe = new Probe();
    probe.calendar = [day('2026-11-02', [{timeFrom: '10:00', timeTo: '18:00'}])];

    expect(on(await probe.scheduleForTest(), '2026-11-02')).toEqual([
      {type: 'OPERATING', open: '2026-11-02T10:00:00-06:00', close: '2026-11-02T18:00:00-06:00'},
    ]);
  });

  test('a buyout day is PRIVATE_EVENT and not OPERATING', async () => {
    const probe = new Probe();
    probe.calendar = [day('2026-11-07', [{timeFrom: '11:00', timeTo: '18:00', isBuyout: true}])];

    expect(on(await probe.scheduleForTest(), '2026-11-07')).toEqual([
      {type: 'PRIVATE_EVENT', open: '2026-11-07T11:00:00-06:00', close: '2026-11-07T18:00:00-06:00'},
    ]);
  });

  test('a buyout that closes at midnight ends on the next calendar day', async () => {
    const probe = new Probe();
    probe.calendar = [day('2026-11-13', [{timeFrom: '18:00', timeTo: '00:00', isBuyout: true}])];

    expect(on(await probe.scheduleForTest(), '2026-11-13')).toEqual([
      {type: 'PRIVATE_EVENT', open: '2026-11-13T18:00:00-06:00', close: '2026-11-14T00:00:00-06:00'},
    ]);
  });

  test('a day with a public window and a buyout window publishes both, each under its own type', async () => {
    const probe = new Probe();
    probe.calendar = [day('2026-11-20', [
      {timeFrom: '11:00', timeTo: '17:00', isBuyout: false},
      {timeFrom: '18:00', timeTo: '23:00', isBuyout: true},
    ])];

    expect(on(await probe.scheduleForTest(), '2026-11-20')).toEqual([
      {type: 'OPERATING', open: '2026-11-20T11:00:00-06:00', close: '2026-11-20T17:00:00-06:00'},
      {type: 'PRIVATE_EVENT', open: '2026-11-20T18:00:00-06:00', close: '2026-11-20T23:00:00-06:00'},
    ]);
  });

  test('the November 2026 Over Texas calendar publishes exactly the five buyout days as PRIVATE_EVENT', async () => {
    const probe = new Probe();
    const pub = (iso: string, from: string, to: string) => day(iso, [{timeFrom: from, timeTo: to, isBuyout: false}]);
    const buy = (iso: string, from: string, to: string) => day(iso, [{timeFrom: from, timeTo: to, isBuyout: true}]);
    probe.calendar = [
      pub('2026-11-01', '12:00', '22:00'),
      buy('2026-11-07', '11:00', '18:00'),
      buy('2026-11-08', '11:00', '21:00'),
      buy('2026-11-13', '18:00', '00:00'),
      pub('2026-11-14', '11:00', '19:00'),
      buy('2026-11-15', '11:00', '18:00'),
      buy('2026-11-21', '11:00', '21:00'),
      pub('2026-11-22', '12:00', '21:00'),
    ];

    const schedule = await probe.scheduleForTest();
    const datesOf = (type: string) => schedule.filter(e => e.type === type).map(e => e.date);

    expect(datesOf('OPERATING')).toEqual(['2026-11-01', '2026-11-14', '2026-11-22']);
    expect(datesOf('PRIVATE_EVENT')).toEqual(['2026-11-07', '2026-11-08', '2026-11-13', '2026-11-15', '2026-11-21']);
  });

  test('two buyout windows on one day publish one PRIVATE_EVENT from the first open to the last close', async () => {
    const probe = new Probe();
    probe.calendar = [day('2026-11-09', [
      {timeFrom: '09:00', timeTo: '12:00', isBuyout: true},
      {timeFrom: '18:00', timeTo: '23:00', isBuyout: true},
    ])];

    expect(on(await probe.scheduleForTest(), '2026-11-09')).toEqual([
      {type: 'PRIVATE_EVENT', open: '2026-11-09T09:00:00-06:00', close: '2026-11-09T23:00:00-06:00'},
    ]);
  });

  test('a closed day publishes nothing, whatever it lists', async () => {
    const probe = new Probe();
    probe.calendar = [day('2026-11-10', [{timeFrom: '11:00', timeTo: '18:00', isBuyout: true}], {isParkClosed: true})];

    expect(on(await probe.scheduleForTest(), '2026-11-10')).toEqual([]);
  });

  test('Park items with unusable times publish nothing and do not fall back to the ride hours', async () => {
    const probe = new Probe();
    probe.calendar = [day(
      '2026-11-11',
      [{timeFrom: 'TBD', timeTo: '18:00', isBuyout: true}, {timeFrom: '', timeTo: '', isBuyout: false}],
      {venues: [venue(1, [['10:00', '18:00']])]},
    )];

    expect(on(await probe.scheduleForTest(), '2026-11-11')).toEqual([]);
  });

  test('a buyout window with an unusable time leaves the public window alone', async () => {
    const probe = new Probe();
    probe.calendar = [day('2026-11-12', [
      {timeFrom: '11:00', timeTo: '17:00', isBuyout: false},
      {timeFrom: 'TBD', timeTo: '23:00', isBuyout: true},
    ])];

    expect(on(await probe.scheduleForTest(), '2026-11-12')).toEqual([
      {type: 'OPERATING', open: '2026-11-12T11:00:00-06:00', close: '2026-11-12T17:00:00-06:00'},
    ]);
  });

  test.each([['the string "true"', 'true'], ['the number 1', 1], ['null', null]])(
    'isBuyout as %s is not a buyout: only a boolean true is',
    async (_label, flag) => {
      const probe = new Probe();
      probe.calendar = [day('2026-11-16', [{timeFrom: '10:00', timeTo: '18:00', isBuyout: flag}])];

      expect(on(await probe.scheduleForTest(), '2026-11-16').map(e => e.type)).toEqual(['OPERATING']);
    },
  );

  test('a day with no Park window falls back to the ride hours, always public', async () => {
    const probe = new Probe();
    probe.calendar = [day('2026-11-17', [], {venues: [venue(1, [['10:00', '18:00']])]})];

    expect(on(await probe.scheduleForTest(), '2026-11-17')).toEqual([
      {type: 'OPERATING', open: '2026-11-17T10:00:00-06:00', close: '2026-11-17T18:00:00-06:00'},
    ]);
  });
});

/**
 * Haunt hours inferred from the mazes ignore any maze filed before the park
 * opens. "The park opens" has to mean the same thing it did before buyouts
 * were split out: the earliest open across everything the Park block lists.
 * Anchoring on the public window alone moved the haunt's open on any day a
 * buyout started earlier.
 */
describe('haunt hours on a day with a buyout', () => {
  const mazes = venue(3, [['06:00', '23:00'], ['10:00', '23:00']]);

  test('a buyout that opens earlier than the public window still anchors the haunt open', async () => {
    const probe = new Probe();
    probe.calendar = [day('2026-11-18', [
      {timeFrom: '09:00', timeTo: '12:00', isBuyout: true},
      {timeFrom: '17:00', timeTo: '22:00', isBuyout: false},
    ], {venues: [mazes]})];

    const haunt = (await probe.scheduleForTest()).filter(e => e.date === '2026-11-18' && e.type === 'TICKETED_EVENT');

    // 06:00 is before the 09:00 gates and is dropped; 10:00 is the first plausible start.
    expect(haunt.map(e => e.openingTime)).toEqual(['2026-11-18T10:00:00-06:00']);
  });

  test('a buyout-only day anchors the haunt on the buyout open', async () => {
    const probe = new Probe();
    probe.calendar = [day('2026-11-19', [{timeFrom: '09:00', timeTo: '12:00', isBuyout: true}], {venues: [mazes]})];

    const haunt = (await probe.scheduleForTest()).filter(e => e.date === '2026-11-19' && e.type === 'TICKETED_EVENT');

    expect(haunt.map(e => e.openingTime)).toEqual(['2026-11-19T10:00:00-06:00']);
  });
});

describe('the frozen-feed check on a buyout day', () => {
  test('a park bought out for the day still counts as running', async () => {
    const probe = new Probe();
    probe.calendar = [day('2026-11-07', [{timeFrom: '11:00', timeTo: '18:00', isBuyout: true}])];
    // Saturday 7 November, 13:00 Central.
    const now = new Date('2026-11-07T19:00:00Z');

    expect(await probe.scheduleSaysOpen(SFOT, 'America/Chicago', now)).toBe(true);
  });
});

