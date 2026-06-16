import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {mapAttractionStatus, TokyoDisneyResort} from '../tokyodisneyresort.js';

const NOON_JST_UTC = '2026-06-17T03:00:00.000Z'; // 12:00 JST = parks open

const windowAround = (status: string) => ({
  startAt: '2026-06-17T00:00:00.000Z', // 09:00 JST
  endAt:   '2026-06-17T12:00:00.000Z', // 21:00 JST
  operatingStatus: status,
});

describe('mapAttractionStatus (v7)', () => {
  const now = new Date(NOON_JST_UTC);

  test('top-level CANCEL → CLOSED', () => {
    expect(mapAttractionStatus(
      {facilityCode: '101', facilityStatus: 'CANCEL', operatings: []},
      now,
    )).toBe('CLOSED');
  });

  test('top-level CONFIRM_SCHEDULE → CLOSED', () => {
    expect(mapAttractionStatus(
      {facilityCode: '101', facilityStatus: 'CONFIRM_SCHEDULE'},
      now,
    )).toBe('CLOSED');
  });

  test('top-level CONFIRM_STATUS → DOWN', () => {
    expect(mapAttractionStatus(
      {facilityCode: '101', facilityStatus: 'CONFIRM_STATUS'},
      now,
    )).toBe('DOWN');
  });

  test('top-level CANCEL beats any operatings entry', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      facilityStatus: 'CANCEL',
      operatings: [windowAround('OPEN_NOTICE')],
    }, now)).toBe('CLOSED');
  });

  test('OPEN_NOTICE window covering now → OPERATING', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [windowAround('OPEN_NOTICE')],
    }, now)).toBe('OPERATING');
  });

  test('CLOSE_NOTICE window covering now → DOWN', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [windowAround('CLOSE_NOTICE')],
    }, now)).toBe('DOWN');
  });

  test('PREPARATION window covering now → CLOSED', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [windowAround('PREPARATION')],
    }, now)).toBe('CLOSED');
  });

  test('no operatings and no facilityStatus → CLOSED', () => {
    expect(mapAttractionStatus({facilityCode: '101'}, now)).toBe('CLOSED');
  });

  test('now outside every window → CLOSED', () => {
    const beforeOpening = new Date('2026-06-16T22:00:00.000Z'); // 07:00 JST
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [windowAround('OPEN_NOTICE')],
    }, beforeOpening)).toBe('CLOSED');
  });

  test('malformed window dates are skipped, next valid one wins', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [
        {startAt: 'not-a-date', endAt: '2026-06-17T12:00:00.000Z', operatingStatus: 'OPEN_NOTICE'},
        windowAround('CLOSE_NOTICE'),
      ],
    }, now)).toBe('DOWN');
  });

  test('first matching window wins when multiple overlap', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [
        windowAround('OPEN_NOTICE'),
        windowAround('CLOSE_NOTICE'),
      ],
    }, now)).toBe('OPERATING');
  });

  test('unknown operatingStatus → CLOSED', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [{...windowAround('OPEN_NOTICE'), operatingStatus: 'SOMETHING_NEW'}],
    }, now)).toBe('CLOSED');
  });
});

describe('buildLiveData — standbyTimeDisplayType handling', () => {
  let probe: TokyoDisneyResort;

  beforeEach(() => {
    // Pin "now" to a moment inside the standard test window so the operatings[]
    // entries below all match deterministically.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOON_JST_UTC));
    probe = new TokyoDisneyResort({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const openWindow = () => [{
    startAt: '2026-06-17T00:00:00.000Z',
    endAt:   '2026-06-17T12:00:00.000Z',
    operatingStatus: 'OPEN_NOTICE',
  }];

  test('standbyTimeDisplayType=NORMAL surfaces the wait time', async () => {
    vi.spyOn(probe, 'getConditions').mockResolvedValue({
      attractions: [{
        facilityCode: 'A1',
        standbyTime: 25,
        standbyTimeDisplayType: 'NORMAL',
        operatings: openWindow(),
      }],
    } as any);

    const ld = await (probe as any).buildLiveData();
    expect(ld).toHaveLength(1);
    expect(ld[0].status).toBe('OPERATING');
    expect(ld[0].queue.STANDBY.waitTime).toBe(25);
  });

  test('standbyTimeDisplayType=HIDE suppresses waitTime even when OPERATING', async () => {
    vi.spyOn(probe, 'getConditions').mockResolvedValue({
      attractions: [{
        facilityCode: 'A2',
        standbyTime: 25,
        standbyTimeDisplayType: 'HIDE',
        operatings: openWindow(),
      }],
    } as any);

    const ld = await (probe as any).buildLiveData();
    expect(ld).toHaveLength(1);
    expect(ld[0].status).toBe('OPERATING');
    expect(ld[0].queue.STANDBY.waitTime).toBeUndefined();
  });

  test('standbyTimeDisplayType=FIXED still surfaces the wait time', async () => {
    vi.spyOn(probe, 'getConditions').mockResolvedValue({
      attractions: [{
        facilityCode: 'A3',
        standbyTime: 10,
        standbyTimeDisplayType: 'FIXED',
        operatings: openWindow(),
      }],
    } as any);

    const ld = await (probe as any).buildLiveData();
    expect(ld[0].queue.STANDBY.waitTime).toBe(10);
  });

  test('CLOSED attractions never emit waitTime regardless of displayType', async () => {
    vi.spyOn(probe, 'getConditions').mockResolvedValue({
      attractions: [{
        facilityCode: 'A4',
        facilityStatus: 'CANCEL',
        standbyTime: 25,
        standbyTimeDisplayType: 'NORMAL',
        operatings: [],
      }],
    } as any);

    const ld = await (probe as any).buildLiveData();
    expect(ld[0].status).toBe('CLOSED');
    expect(ld[0].queue.STANDBY.waitTime).toBeUndefined();
  });
});
