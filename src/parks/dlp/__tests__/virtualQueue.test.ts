import {describe, it, expect, vi, afterEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';
import {constructDateTime, formatInTimezone} from '../../../datetime.js';

/**
 * A virtual queue's waves are the day's booking windows. Only an OPEN wave
 * takes bookings, so it alone publishes a return window; once a wave's
 * allocation is gone the queue is temporarily full for as long as a later
 * wave is still scheduled, and finished once none is. Before the first wave
 * of the day has opened, no RETURN_TIME is published at all.
 *
 * The fixture is a Stage Show so these tests don't depend on which
 * Entertainment subtypes happen to be publishable.
 */
function stubbedPark(
  waves: Array<Record<string, unknown>> | unknown,
  queue: Record<string, unknown> = {},
): DisneylandParis {
  const park = new DisneylandParis();

  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({
    ThemePark: [{id: 'P1', name: 'Disneyland Park', type: 'ThemePark'}],
    Entertainment: [
      {
        id: 'P1M115',
        name: 'Some Virtual Queue Show',
        type: 'Entertainment',
        subType: 'Stage Show',
        location: {id: 'P1'},
      },
    ],
  });

  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue([]);
  vi.spyOn(park as any, 'getPremierAccess').mockResolvedValue([]);
  vi.spyOn(park as any, 'getScheduleForDate').mockResolvedValue([]);
  vi.spyOn(park as any, 'getVirtualQueueData').mockResolvedValue([
    {
      queueId: 'q1',
      enabled: true,
      queueContentId: 'P1M115',
      activityId: 'HeroTrainingCenter',
      waves,
      ...queue,
    },
  ]);

  return park;
}

/**
 * Waves are dated on the park's current date. A FINISHED wave only counts as
 * evidence the day has started while its openAt still falls on that date, so
 * a fixture pinned to a fixed date would stop exercising that the day after it
 * was written.
 */
const PARK_TZ = 'Europe/Paris';
const [pMM, pDD, pYYYY] = formatInTimezone(new Date(), PARK_TZ, 'date').split('/');
const TODAY = `${pYYYY}-${pMM}-${pDD}`;

const YESTERDAY = (() => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
})();

// Park-local wall clock to an instant, so the fixture carries the offset in
// force on that date rather than a hardcoded one.
const at = (date: string, time: string) => constructDateTime(date, time, PARK_TZ);

const morning = (status: string, date: string = TODAY) => ({
  waveId: 'w1',
  name: 'morning',
  openAt: at(date, '09:45'),
  closedAt: at(date, '13:30'),
  status,
});

const afternoon = (status: string, date: string = TODAY) => ({
  waveId: 'w2',
  name: 'afternoon',
  openAt: at(date, '14:00'),
  closedAt: at(date, '17:35'),
  status,
});

const MORNING_WINDOW = {
  state: 'AVAILABLE',
  returnStart: at(TODAY, '09:45'),
  returnEnd: at(TODAY, '13:30'),
};

const AFTERNOON_WINDOW = {
  state: 'AVAILABLE',
  returnStart: at(TODAY, '14:00'),
  returnEnd: at(TODAY, '17:35'),
};

async function liveRowOf(park: DisneylandParis): Promise<any> {
  const live = await park.getLiveData();
  return live.find((l) => l.id === 'P1M115');
}

describe('DLP virtual queue', () => {
  afterEach(() => vi.restoreAllMocks());

  it('publishes the window of an OPEN wave and reports the experience operating', async () => {
    const row = await liveRowOf(stubbedPark([morning('OPEN'), afternoon('CLOSED')]));
    expect(row).toBeDefined();
    expect(row.queue?.RETURN_TIME).toEqual(MORNING_WINDOW);
    expect(row.status).toBe('OPERATING');
  });

  it('follows nextWaveId rather than the wave order', async () => {
    const row = await liveRowOf(
      stubbedPark([morning('FULL'), afternoon('OPEN')], {nextWaveId: 'w2'}),
    );
    expect(row.queue?.RETURN_TIME).toEqual(AFTERNOON_WINDOW);
    expect(row.status).toBe('OPERATING');
  });

  // `nextWaveId` can lag a wave transition; an OPEN wave must win over it.
  it.each([
    ['FINISHED', 'OPEN', 'w1', AFTERNOON_WINDOW],
    ['FULL', 'OPEN', 'w1', AFTERNOON_WINDOW],
    ['OPEN', 'FULL', 'w2', MORNING_WINDOW],
    ['OPEN', 'CLOSED', 'w2', MORNING_WINDOW],
  ])('trusts a live OPEN wave over a stale nextWaveId ([%s,%s] next=%s)',
    async (w1Status, w2Status, nextWaveId, expected) => {
      const row = await liveRowOf(
        stubbedPark([morning(w1Status), afternoon(w2Status)], {nextWaveId}),
      );
      expect(row.queue?.RETURN_TIME).toEqual(expected);
      expect(row.status).toBe('OPERATING');
    });

  it('reports temporarily full when a full wave has a later one scheduled', async () => {
    const row = await liveRowOf(
      stubbedPark([morning('FULL'), afternoon('CLOSED')], {nextWaveId: 'w1'}),
    );
    expect(row.queue?.RETURN_TIME).toEqual({state: 'TEMP_FULL', returnStart: null, returnEnd: null});
    // "Come back later" says the experience is running, so the seeded CLOSED
    // would contradict the queue it is published next to.
    expect(row.status).toBe('OPERATING');
  });

  it('publishes no return time before the first wave of the day has opened', async () => {
    const row = await liveRowOf(stubbedPark([morning('CLOSED'), afternoon('CLOSED')]));
    expect(row).toBeDefined();
    expect(row.status).toBe('CLOSED');
    expect(row.queue?.RETURN_TIME).toBeUndefined();
  });

  // A dormant configuration row: Disney leaves these in the wave list with
  // both dates nulled, so they carry no evidence of having run.
  const dormant = {waveId: 'w0', name: 'EMT', openAt: null, closedAt: null, status: 'FINISHED'};

  it('does not read a dateless FINISHED wave as the day having started', async () => {
    const row = await liveRowOf(
      stubbedPark([morning('CLOSED'), afternoon('CLOSED'), dormant]),
    );
    expect(row).toBeDefined();
    expect(row.status).toBe('CLOSED');
    expect(row.queue?.RETURN_TIME).toBeUndefined();
  });

  // Yesterday's wave, still dated, as the feed would hold it past midnight.
  const stale = {
    waveId: 'wY',
    name: 'yesterday',
    openAt: at(YESTERDAY, '09:45'),
    closedAt: at(YESTERDAY, '13:30'),
    status: 'FINISHED',
  };

  it('does not read yesterday\'s dated FINISHED wave as the day having started', async () => {
    const row = await liveRowOf(
      stubbedPark([stale, morning('CLOSED'), afternoon('CLOSED')]),
    );
    expect(row).toBeDefined();
    expect(row.status).toBe('CLOSED');
    expect(row.queue?.RETURN_TIME).toBeUndefined();
  });

  it('still counts a FINISHED wave that kept its dates', async () => {
    const row = await liveRowOf(
      stubbedPark([morning('FINISHED'), afternoon('CLOSED'), dormant]),
    );
    expect(row.queue?.RETURN_TIME).toEqual({state: 'TEMP_FULL', returnStart: null, returnEnd: null});
    expect(row.status).toBe('OPERATING');
  });

  it('finishes once the last wave is full', async () => {
    const row = await liveRowOf(
      stubbedPark([morning('FINISHED'), afternoon('FULL')], {nextWaveId: 'w2'}),
    );
    expect(row.queue?.RETURN_TIME).toEqual({state: 'FINISHED', returnStart: null, returnEnd: null});
    // Nothing left to open, so the seeded CLOSED is the honest answer.
    expect(row.status).toBe('CLOSED');
  });

  it('finishes when every wave is done', async () => {
    const row = await liveRowOf(stubbedPark([morning('FINISHED'), afternoon('FINISHED')]));
    expect(row.queue?.RETURN_TIME).toEqual({state: 'FINISHED', returnStart: null, returnEnd: null});
    expect(row.status).toBe('CLOSED');
  });

  it('never claims availability for a status it does not recognise', async () => {
    const row = await liveRowOf(stubbedPark([morning('SOMETHING_NEW'), afternoon('CLOSED')]));
    expect(row).toBeDefined();
    expect(row.queue?.RETURN_TIME).toBeUndefined();
  });

  it('accepts a status the feed reports in lower case', async () => {
    const row = await liveRowOf(stubbedPark([morning('open'), afternoon('closed')]));
    expect(row.queue?.RETURN_TIME).toEqual(MORNING_WINDOW);
    expect(row.status).toBe('OPERATING');
  });

  it.each([
    ['the waves are missing', undefined],
    ['the waves are not an array', 'nope'],
  ])('publishes no live row when %s', async (_label, waves) => {
    const row = await liveRowOf(stubbedPark(waves));
    expect(row).toBeUndefined();
  });

  it.each([
    ['a wave is null', [null]],
    ['a status is not a string', [{waveId: 'w1', status: 7}]],
  ])('publishes a closed row without a return time when %s', async (_label, waves) => {
    const row = await liveRowOf(stubbedPark(waves as any));
    expect(row).toBeDefined();
    expect(row.status).toBe('CLOSED');
    expect(row.queue?.RETURN_TIME).toBeUndefined();
  });

  it('falls back to FINISHED when an open wave has an unusable window', async () => {
    const row = await liveRowOf(stubbedPark([{...morning('OPEN'), openAt: 'banana'}]));
    expect(row).toBeDefined();
    expect(row.queue?.RETURN_TIME).toEqual({state: 'FINISHED', returnStart: null, returnEnd: null});
    expect(row.status).toBe('CLOSED');
  });

  it('publishes no live row at all while the queue is disabled', async () => {
    const row = await liveRowOf(
      stubbedPark([morning('OPEN'), afternoon('CLOSED')], {enabled: false}),
    );
    expect(row).toBeUndefined();
  });
});
