import {describe, it, expect, vi, afterEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';

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

const morning = (status: string) => ({
  waveId: 'w1',
  name: 'morning',
  openAt: '2026-08-12T09:45:00.000+0200',
  closedAt: '2026-08-12T13:30:00.000+0200',
  status,
});

const afternoon = (status: string) => ({
  waveId: 'w2',
  name: 'afternoon',
  openAt: '2026-08-12T14:00:00.000+0200',
  closedAt: '2026-08-12T17:35:00.000+0200',
  status,
});

const MORNING_WINDOW = {
  state: 'AVAILABLE',
  returnStart: '2026-08-12T09:45:00+02:00',
  returnEnd: '2026-08-12T13:30:00+02:00',
};

const AFTERNOON_WINDOW = {
  state: 'AVAILABLE',
  returnStart: '2026-08-12T14:00:00+02:00',
  returnEnd: '2026-08-12T17:35:00+02:00',
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
  });

  it('publishes no return time before the first wave of the day has opened', async () => {
    const row = await liveRowOf(stubbedPark([morning('CLOSED'), afternoon('CLOSED')]));
    expect(row).toBeDefined();
    expect(row.status).toBe('CLOSED');
    expect(row.queue?.RETURN_TIME).toBeUndefined();
  });

  it('finishes once the last wave is full', async () => {
    const row = await liveRowOf(
      stubbedPark([morning('FINISHED'), afternoon('FULL')], {nextWaveId: 'w2'}),
    );
    expect(row.queue?.RETURN_TIME).toEqual({state: 'FINISHED', returnStart: null, returnEnd: null});
  });

  it('finishes when every wave is done', async () => {
    const row = await liveRowOf(stubbedPark([morning('FINISHED'), afternoon('FINISHED')]));
    expect(row.queue?.RETURN_TIME).toEqual({state: 'FINISHED', returnStart: null, returnEnd: null});
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
