import {describe, it, expect, vi, beforeEach, afterEach, afterAll} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';
import {CacheLib} from '../../../cache.js';
import {stopHttpQueue} from '../../../http.js';
import {setHttpTransport, HttpRequestOptions} from '../../../httpProxy.js';
import {formatDate, shiftDateString} from '../../../datetime.js';

/**
 * `scheduleDays` (`DLP_SCHEDULEDAYS`) sets how many days of schedules the
 * destination fetches and publishes, counting today, one request to the
 * schedule feed per day. The meet & greet gate looks at the same days, so a
 * meet & greet whose next performance falls past them stays out of the entity
 * list, and the gate's cached answer is kept per window, keyed by its first
 * day and its length. Anything but a positive whole number falls back to the
 * default of 60.
 */

const ENV_KEYS = ['DLP_SCHEDULEDAYS', 'DISNEYLANDPARIS_SCHEDULEDAYS', 'DLP_APIBASE'];

function saveEnv(): () => void {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of ENV_KEYS) delete process.env[key];
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const MEET_AND_GREET = 'Character Experience - Meet & Greet';

const POI = {
  ThemePark: [{id: 'P1', name: 'Disneyland Park', type: 'ThemePark', location: {id: 'P1'}}],
  Entertainment: [
    {id: 'P1MG01', name: 'Meets today', type: 'Entertainment', subType: MEET_AND_GREET, location: {id: 'P1'}},
    {id: 'P1MG02', name: 'Meets in two days', type: 'Entertainment', subType: MEET_AND_GREET, location: {id: 'P1'}},
    {id: 'P1MG03', name: 'Meets by virtual queue', type: 'Entertainment', subType: MEET_AND_GREET, location: {id: 'P1'}},
  ],
};

const parisToday = () => formatDate(new Date(), 'Europe/Paris');

const datesFromToday = (days: number) => Array.from({length: days}, (_, i) => shiftDateString(parisToday(), i));

const PARK_HOURS = {id: 'P1', schedules: [{startTime: '09:30:00', endTime: '22:00:00', status: 'OPERATING'}]};
const PERFORMANCE = {startTime: '11:00:00', endTime: '11:00:00', status: 'PERFORMANCE_TIME'};

/**
 * The schedule feed for a date: park hours every day, a performance of
 * P1MG01 today and of P1MG02 the day after tomorrow. P1MG03 never performs,
 * it has a virtual queue that is switched on.
 */
function scheduleRows(date: string): unknown[] {
  const rows: unknown[] = [PARK_HOURS];
  if (date === parisToday()) rows.push({id: 'P1MG01', schedules: [PERFORMANCE]});
  if (date === shiftDateString(parisToday(), 2)) rows.push({id: 'P1MG02', schedules: [PERFORMANCE]});
  return rows;
}

/** A park with POI and queue stubbed, recording each date the schedule feed is asked for. */
function stubbedPark(
  rowsFor: (date: string) => unknown[] = scheduleRows,
  park = new DisneylandParis(),
): {park: DisneylandParis; dates: () => string[]} {
  vi.spyOn(park as any, 'getPOIData').mockResolvedValue(POI);
  vi.spyOn(park as any, 'getVirtualQueueData').mockResolvedValue([{queueContentId: 'P1MG03', enabled: true}]);
  const asked: string[] = [];
  vi.spyOn(park as any, 'getScheduleForDate').mockImplementation(async (date: unknown) => {
    asked.push(String(date));
    return rowsFor(String(date));
  });
  return {park, dates: () => [...new Set(asked)]};
}

async function meetAndGreets(park: DisneylandParis): Promise<string[]> {
  return (await park.getEntities()).map((entity) => entity.id).filter((id) => id.startsWith('P1MG')).sort();
}

describe('DLP scheduleDays', () => {
  let restoreEnv: () => void;

  beforeEach(() => {
    restoreEnv = saveEnv();
    // Noon in Paris, so that no test runs across midnight.
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date('2026-10-03T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreEnv();
    CacheLib.clearAll();
  });

  it('fetches and publishes 60 days, counting today, by default', async () => {
    const {park, dates} = stubbedPark();
    expect(park.scheduleDays).toBe(60);

    const schedules = await park.getSchedules();

    expect(dates()).toEqual(datesFromToday(60));
    expect(schedules.find((s) => s.id === 'P1')?.schedule).toHaveLength(60);
  });

  it.each(['DLP_SCHEDULEDAYS', 'DISNEYLANDPARIS_SCHEDULEDAYS'])('%s=2 limits the schedules to today and tomorrow', async (key) => {
    process.env[key] = '2';
    const {park, dates} = stubbedPark();

    const schedules = await park.getSchedules();

    expect(dates()).toEqual(datesFromToday(2));
    expect(schedules.find((s) => s.id === 'P1')?.schedule.map((day) => day.date)).toEqual(datesFromToday(2));
  });

  it('takes the value from the destination config as well', async () => {
    const {park, dates} = stubbedPark(scheduleRows, new DisneylandParis({config: {scheduleDays: '2'}}));

    await park.getSchedules();

    expect(dates()).toEqual(datesFromToday(2));
  });

  it.each(['0', '-1', '1.5', 'abc', '', 'Infinity'])('falls back to 60 days when DLP_SCHEDULEDAYS is %j', async (value) => {
    process.env.DLP_SCHEDULEDAYS = value;
    const {park, dates} = stubbedPark();

    const schedules = await park.getSchedules();

    expect(dates()).toEqual(datesFromToday(60));
    expect(schedules.find((s) => s.id === 'P1')?.schedule).toHaveLength(60);
    expect(CacheLib.keys()).toContain(`DisneylandParis:dlp:getScheduledActivityIds:${parisToday()}:60`);
  });

  it('reaches past 60 days when asked to', async () => {
    process.env.DLP_SCHEDULEDAYS = '90';
    const {park, dates} = stubbedPark();

    const schedules = await park.getSchedules();

    expect(dates()).toEqual(datesFromToday(90));
    expect(schedules.find((s) => s.id === 'P1')?.schedule).toHaveLength(90);
  });

  it('leaves out a meet & greet whose next performance falls past the window', async () => {
    expect(await meetAndGreets(stubbedPark().park)).toEqual(['P1MG01', 'P1MG02', 'P1MG03']);
    CacheLib.clearAll();

    process.env.DLP_SCHEDULEDAYS = '2';
    const {park, dates} = stubbedPark();

    // P1MG03 stays: an enabled virtual queue is data of its own, whatever the window.
    expect(await meetAndGreets(park)).toEqual(['P1MG01', 'P1MG03']);
    expect(dates()).toEqual(datesFromToday(2));
  });

  it('caches the meet & greet gate per window', async () => {
    expect(await meetAndGreets(stubbedPark().park)).toContain('P1MG02');

    process.env.DLP_SCHEDULEDAYS = '2';
    const narrow = stubbedPark();
    // A shared key would serve the 60-day answer here and keep P1MG02.
    expect(await meetAndGreets(narrow.park)).not.toContain('P1MG02');
    expect(narrow.dates()).toEqual(datesFromToday(2));

    delete process.env.DLP_SCHEDULEDAYS;
    const wideAgain = stubbedPark();
    expect(await meetAndGreets(wideAgain.park)).toContain('P1MG02');
    // The 60-day answer is still cached, so the feed is not asked again.
    expect(wideAgain.dates()).toEqual([]);
  });

  it('builds the gate again after midnight, once a one-day window has moved on', async () => {
    process.env.DLP_SCHEDULEDAYS = '1';
    const performsOnTheFourth = (date: string) =>
      date === '2026-10-04' ? [PARK_HOURS, {id: 'P1MG02', schedules: [PERFORMANCE]}] : [PARK_HOURS];

    vi.setSystemTime(new Date('2026-10-03T21:00:00Z')); // 23:00 in Paris
    expect(await meetAndGreets(stubbedPark(performsOnTheFourth).park)).not.toContain('P1MG02');

    // 01:00 in Paris on the 4th, well inside the 12 hours the first answer is cached for.
    vi.setSystemTime(new Date('2026-10-03T23:00:00Z'));
    expect(await meetAndGreets(stubbedPark(performsOnTheFourth).park)).toContain('P1MG02');
  });
});

/**
 * Through the HTTP layer, on the real clock: the queue paces requests by it.
 * Kept last, so that a request still queued when a case fails cannot hold up
 * the cases above.
 */
describe('DLP scheduleDays over HTTP', () => {
  let restoreEnv: () => void;

  beforeEach(() => {
    restoreEnv = saveEnv();
  });

  afterEach(() => {
    setHttpTransport(null);
    restoreEnv();
    CacheLib.clearAll();
  });

  afterAll(() => stopHttpQueue());

  it('sends one request to the schedule feed per day', async () => {
    process.env.DLP_SCHEDULEDAYS = '2';
    process.env.DLP_APIBASE = 'https://dlp.example';
    const expected = datesFromToday(2);
    const scheduleDates: string[] = [];
    setHttpTransport(async (request: HttpRequestOptions) => {
      const body = JSON.parse(String(request.body));
      if (String(body.query).includes('activitySchedules')) {
        scheduleDates.push(body.variables.date);
        return Response.json({data: {activitySchedules: scheduleRows(body.variables.date)}});
      }
      return Response.json({data: POI});
    });

    const schedules = await new DisneylandParis().getSchedules();

    expect(scheduleDates).toEqual(expected);
    expect(schedules.find((s) => s.id === 'P1')?.schedule).toHaveLength(2);
  });
});
