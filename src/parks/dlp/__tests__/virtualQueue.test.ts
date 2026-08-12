import {describe, it, expect, vi, beforeEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';

/**
 * A virtual queue's waves are the day's booking windows. Only an OPEN wave
 * takes bookings, so it alone publishes a return window; once a wave's
 * allocation is gone the queue is temporarily full for as long as a later
 * wave is still scheduled, and finished once none is.
 */
function stubbedPark(
  waves: Array<Record<string, unknown>>,
  queue: Record<string, unknown> = {},
): DisneylandParis {
  const park = new DisneylandParis();

  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({
    ThemePark: [{id: 'P1', name: 'Disneyland Park', type: 'ThemePark'}],
    Entertainment: [
      {
        id: 'P1M115',
        name: 'Meet Mickey Mouse',
        type: 'Entertainment',
        subType: 'Character Experience - Meet & Greet',
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

async function returnTimeOf(park: DisneylandParis): Promise<any> {
  const live = await park.getLiveData();
  return live.find((l) => l.id === 'P1M115')?.queue?.RETURN_TIME;
}

describe('DLP virtual queue', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('publishes the window of an OPEN wave', async () => {
    const queue = await returnTimeOf(stubbedPark([morning('OPEN'), afternoon('CLOSED')]));
    expect(queue).toEqual({
      state: 'AVAILABLE',
      returnStart: '2026-08-12T09:45:00+02:00',
      returnEnd: '2026-08-12T13:30:00+02:00',
    });
  });

  it('follows nextWaveId rather than the wave order', async () => {
    const queue = await returnTimeOf(
      stubbedPark([morning('FULL'), afternoon('OPEN')], {nextWaveId: 'w2'}),
    );
    expect(queue).toEqual({
      state: 'AVAILABLE',
      returnStart: '2026-08-12T14:00:00+02:00',
      returnEnd: '2026-08-12T17:35:00+02:00',
    });
  });

  it('reports temporarily full when a full wave has a later one scheduled', async () => {
    const queue = await returnTimeOf(
      stubbedPark([morning('FULL'), afternoon('CLOSED')], {nextWaveId: 'w1'}),
    );
    expect(queue).toEqual({state: 'TEMP_FULL', returnStart: null, returnEnd: null});
  });

  it('reports temporarily full before the first wave opens', async () => {
    const queue = await returnTimeOf(stubbedPark([morning('CLOSED'), afternoon('CLOSED')]));
    expect(queue).toEqual({state: 'TEMP_FULL', returnStart: null, returnEnd: null});
  });

  it('finishes once the last wave is full', async () => {
    const queue = await returnTimeOf(
      stubbedPark([morning('FINISHED'), afternoon('FULL')], {nextWaveId: 'w2'}),
    );
    expect(queue).toEqual({state: 'FINISHED', returnStart: null, returnEnd: null});
  });

  it('finishes when every wave is done', async () => {
    const queue = await returnTimeOf(stubbedPark([morning('FINISHED'), afternoon('FINISHED')]));
    expect(queue).toEqual({state: 'FINISHED', returnStart: null, returnEnd: null});
  });

  it('never claims availability for a status it does not recognise', async () => {
    const queue = await returnTimeOf(stubbedPark([morning('SOMETHING_NEW'), afternoon('CLOSED')]));
    expect(queue).toEqual({state: 'TEMP_FULL', returnStart: null, returnEnd: null});
  });

  it('accepts a status the feed reports in lower case', async () => {
    const queue = await returnTimeOf(stubbedPark([morning('open'), afternoon('closed')]));
    expect(queue?.state).toBe('AVAILABLE');
  });

  it.each([
    ['the waves are missing', undefined],
    ['the waves are not an array', 'nope'],
    ['a wave is null', [null]],
    ['a status is not a string', [{waveId: 'w1', status: 7}]],
    ['an open wave has an unusable window', [{...morning('OPEN'), openAt: 'banana'}]],
  ])('never publishes a bookable window when %s', async (_label, waves) => {
    const queue = await returnTimeOf(stubbedPark(waves as any));
    expect(queue?.state).not.toBe('AVAILABLE');
  });

  it('publishes no queue at all while the queue is disabled', async () => {
    const queue = await returnTimeOf(
      stubbedPark([morning('OPEN'), afternoon('CLOSED')], {enabled: false}),
    );
    expect(queue).toBeUndefined();
  });
});
