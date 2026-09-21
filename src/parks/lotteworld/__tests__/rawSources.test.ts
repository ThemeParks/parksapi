import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {LotteWorld} from '../lotteworld.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every entity and live row carries the allList
 * attraction row it was built from, and today's schedule entry carries the
 * closed-list response for that day. Off, nothing carries anything.
 */
const NOW = new Date('2026-09-21T10:00:00Z');

const attrOperating = {shopSysCd: 'A1', atrctNm: 'Atlantis', atrctSttsCd: null, atrctSttsNm: '정상운영', waitTm: '15', useYn: 'Y'};
const attrDown = {shopSysCd: 'A2', atrctNm: 'French Revolution', atrctSttsCd: null, atrctSttsNm: '일시중단', waitTm: null, useYn: 'Y'};
const attrClosed = {shopSysCd: 'A3', atrctNm: 'Ghost House', atrctSttsCd: null, atrctSttsNm: '운영종료', waitTm: null, useYn: 'Y'};

const operTimeToday = {bgntm: '0930', bgnTmFmt: '09:30', endTm: '2200', endTmFmt: '22:00', operYn: 'Y'};
const operTimeClosed = {bgntm: '', bgnTmFmt: '', endTm: '', endTmFmt: '', operYn: 'N'};

function stubbedPark(includeRaw: boolean): LotteWorld {
  const park = new LotteWorld();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, 'getAllAttractions').mockResolvedValue([attrOperating, attrDown, attrClosed]);
  let call = 0;
  vi.spyOn(park as any, 'fetchClosedList').mockImplementation(async () => ({
    json: async () => ({operTime: call++ === 0 ? operTimeToday : operTimeClosed}),
  }));
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('LotteWorld raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('attaches the allList row to each live row', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual(['A1', 'A2', 'A3']);

    expect(rawOf(live[0])).toEqual({allList: attrOperating});
    expect(rawOf(live[0])!.allList).toBe(attrOperating);
    expect(live[0].queue).toEqual({STANDBY: {waitTime: 15}});

    expect(rawOf(live[1])).toEqual({allList: attrDown});
    expect(live[1].status).toBe('DOWN');
    expect(live[1].queue).toBeUndefined();

    expect(rawOf(live[2])).toEqual({allList: attrClosed});
    expect(live[2].status).toBe('CLOSED');
  });

  it('attaches the allList row to each attraction, nothing to destination or park', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual(['lotteworld', 'lotteworldpark', 'A1', 'A2', 'A3']);

    expect(rawOf(entities[0])).toBeUndefined();
    expect(rawOf(entities[1])).toBeUndefined();

    expect(rawOf(entities[2])).toEqual({allList: attrOperating});
    expect(rawOf(entities[2])!.allList).toBe(attrOperating);
    expect(entities[2].name).toBe('Atlantis');

    expect(rawOf(entities[3])!.allList).toBe(attrDown);
    expect(rawOf(entities[4])!.allList).toBe(attrClosed);
  });

  it('attaches the closed-list response to the operating day, skips closed days', async () => {
    const [schedule] = await stubbedPark(true).getSchedules();
    expect(schedule.schedule).toHaveLength(1);

    const [today] = schedule.schedule;
    expect(today.date).toBe('2026-09-21');
    expect(rawOf(today)).toEqual({closedList: operTimeToday});
    expect(rawOf(today)!.closedList).toBe(operTimeToday);
    expect(today.openingTime).toBe('2026-09-21T09:30:00+09:00');
    expect(today.closingTime).toBe('2026-09-21T22:00:00+09:00');
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const element of (await park.getSchedules())[0].schedule) expect(rawOf(element)).toBeUndefined();
  });
});
