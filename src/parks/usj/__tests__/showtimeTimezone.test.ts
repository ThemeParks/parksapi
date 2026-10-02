import {describe, test, expect, beforeEach} from 'vitest';
import {UniversalStudiosJapan} from '../universalstudiosjapan.js';
import {CacheLib} from '../../../cache.js';

/**
 * USJ's show list gives each performance's start_time as a real UTC instant.
 * These strings are verbatim from the feed on 2026-09-26: WaterWorld's
 * 02:30Z performance is 11:30 in Tokyo.
 *
 * The show path used to read start_time as "fake UTC" (park-local time with
 * a Z), which relabelled 02:30Z as 02:30 JST and published every performance
 * nine hours early.
 */
const SHOW_LIST = [
  {
    show_id: 'usj.usj.shows.waterworld',
    name: 'WaterWorld',
    status: 'OPEN',
    show_times: [
      {show_time_id: 'a', status: 'ENABLED', start_time: '2026-09-27T02:30:00.000Z'},
      {show_time_id: 'b', status: 'ENABLED', start_time: '2026-09-27T04:30:00.000Z'},
      // Late show crossing the UTC date line: 15:00Z on the 27th is 00:00
      // JST on the 28th.
      {show_time_id: 'c', status: 'ENABLED', start_time: '2026-09-27T15:00:00.000Z'},
      {show_time_id: 'd', status: 'DISABLED', start_time: '2026-09-27T06:30:00.000Z'},
    ],
  },
  {
    show_id: 'usj.usj.shows.frog_choir',
    name: 'Frog Choir',
    status: 'OPEN',
    show_times: [
      {show_time_id: 'e', status: 'ENABLED', start_time: '2026-09-27T01:35:00.000Z'},
      // An unparseable time is dropped, not emitted as "Invalid Date".
      {show_time_id: 'f', status: 'ENABLED', start_time: 'not a time'},
    ],
  },
];

class Probe extends UniversalStudiosJapan {
  async getWaitTimeData(): Promise<any[]> { return []; }
  async getShowListData(): Promise<any[]> { return SHOW_LIST; }
  async getPlaces(): Promise<any[]> { return []; }
  async _init(): Promise<void> {}
}

beforeEach(() => {
  CacheLib.clearByClassName('Probe');
});

async function showtimes(id: string): Promise<string[]> {
  const live = await new Probe().getLiveData();
  const row = live.find((l) => l.id === id);
  return (row?.showtimes ?? []).map((s) => s.startTime as string);
}

describe('USJ showtimes are real UTC, rendered in Asia/Tokyo', () => {
  test('a 02:30Z performance publishes at 11:30 JST', async () => {
    const times = await showtimes('usj.usj.shows.waterworld');
    expect(times[0]).toBe('2026-09-27T11:30:00+09:00');
    expect(times[1]).toBe('2026-09-27T13:30:00+09:00');
  });

  test('each published time is the same instant the feed gave', async () => {
    const times = await showtimes('usj.usj.shows.frog_choir');
    expect(times).toEqual(['2026-09-27T10:35:00+09:00']);
    expect(new Date(times[0]).toISOString()).toBe('2026-09-27T01:35:00.000Z');
  });

  test('a performance past midnight JST lands on the next local date', async () => {
    const times = await showtimes('usj.usj.shows.waterworld');
    expect(times[2]).toBe('2026-09-28T00:00:00+09:00');
  });

  test('disabled and unparseable times are not published', async () => {
    expect(await showtimes('usj.usj.shows.waterworld')).toHaveLength(3);
    expect(await showtimes('usj.usj.shows.frog_choir')).toHaveLength(1);
  });
});
