import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {UniversalStudiosJapan} from '../universalstudiosjapan.js';
import {CacheLib} from '../../../cache.js';

/**
 * Some USJ shows are listed in both the wait-times feed and the show list,
 * under the same id. buildLiveData used to emit a row from each, so every
 * build carried two contradictory rows per entity and the wiki alternated
 * between them from one write cycle to the next.
 *
 * Payloads are the four overlapping entries as served on 2026-09-27 at
 * 18:47 JST: the 4-D films disagree on status (BRIEF_DELAY vs
 * OUT_OF_SERVICE), and SING on Tour / Curious George agree on status but only
 * the show-list copy carries the day's performance.
 */
const WAIT_TIMES = [
  {
    wait_time_attraction_id: 'usj.usj.show.shrek_4d_adventure',
    show_externally: true,
    category: 'general',
    queues: [{queue_id: 'q1', queue_type: 'STANDBY', status: 'BRIEF_DELAY'}],
  },
  {
    wait_time_attraction_id: 'usj.usj.show.sesame_street_4D_movie_magic',
    show_externally: true,
    category: 'general',
    queues: [{queue_id: 'q2', queue_type: 'STANDBY', status: 'BRIEF_DELAY'}],
  },
  {
    wait_time_attraction_id: 'usj.usj.show.sing_on_tour',
    show_externally: true,
    category: 'general',
    queues: [{queue_id: 'q3', queue_type: 'STANDBY', status: 'CLOSED'}],
  },
  {
    wait_time_attraction_id: 'usj.usj.shows.playing_with_curious_george',
    show_externally: true,
    category: 'general',
    queues: [{queue_id: 'q4', queue_type: 'STANDBY', status: 'CLOSED'}],
  },
  // Only in the wait-times feed: must come through untouched.
  {
    wait_time_attraction_id: 'usj.usj.ride.flying_dinosaur',
    show_externally: true,
    category: 'general',
    queues: [{queue_id: 'q5', queue_type: 'STANDBY', status: 'OPEN', display_wait_time: 45}],
  },
];

const SHOW_LIST = [
  {show_id: 'usj.usj.show.shrek_4d_adventure', name: 'Shrek', status: 'OUT_OF_SERVICE', show_times: []},
  {show_id: 'usj.usj.show.sesame_street_4D_movie_magic', name: 'Sesame', status: 'OUT_OF_SERVICE', show_times: []},
  {
    show_id: 'usj.usj.show.sing_on_tour',
    name: 'SING on Tour',
    status: 'CLOSED',
    show_times: [{show_time_id: 's1', status: 'ENABLED', start_time: '2026-09-27T02:40:00.000Z'}],
  },
  {
    show_id: 'usj.usj.shows.playing_with_curious_george',
    name: 'Curious George',
    status: 'CLOSED',
    show_times: [{show_time_id: 'g1', status: 'ENABLED', start_time: '2026-09-27T02:40:00.000Z'}],
  },
  // Only in the show list.
  {
    show_id: 'usj.usj.shows.waterworld',
    name: 'WaterWorld',
    status: 'OPEN',
    show_times: [{show_time_id: 'w1', status: 'ENABLED', start_time: '2026-09-27T10:30:00.000Z'}],
  },
];

class Probe extends UniversalStudiosJapan {
  waits: any[] = WAIT_TIMES;
  shows: any[] = SHOW_LIST;
  async getWaitTimeData(): Promise<any[]> { return this.waits; }
  async getShowListData(): Promise<any[]> { return this.shows; }
  async getPlaces(): Promise<any[]> { return []; }
  async _init(): Promise<void> {}
  live() { return this.buildLiveData(); }
}

beforeEach(() => {
  CacheLib.clearByClassName('Probe');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('USJ live data: one row per entity across both feeds', () => {
  test('no id is emitted twice', async () => {
    const rows = await new Probe().live();
    const ids = rows.map((r) => r.id);
    expect(ids.length).toBe(new Set(ids).size);
    expect(ids).toHaveLength(6);
  });

  test('status conflict: the show list wins (OUT_OF_SERVICE over BRIEF_DELAY)', async () => {
    const rows = await new Probe().live();
    for (const id of ['usj.usj.show.shrek_4d_adventure', 'usj.usj.show.sesame_street_4D_movie_magic']) {
      const row = rows.find((r) => r.id === id)!;
      expect(row.status).toBe('CLOSED');
      expect(row.queue).toBeUndefined();
    }
  });

  test('the merged row keeps the show list performance', async () => {
    const rows = await new Probe().live();
    for (const id of ['usj.usj.show.sing_on_tour', 'usj.usj.shows.playing_with_curious_george']) {
      const row = rows.find((r) => r.id === id)!;
      expect(row.status).toBe('CLOSED');
      expect(row.showtimes).toEqual([
        {type: 'PERFORMANCE_TIME', startTime: '2026-09-27T11:40:00+09:00', endTime: null},
      ]);
    }
  });

  test('a show operating in both feeds keeps the wait-time queue', async () => {
    const p = new Probe();
    p.waits = [{
      wait_time_attraction_id: 'usj.usj.show.shrek_4d_adventure',
      show_externally: true,
      category: 'general',
      queues: [{queue_id: 'q1', queue_type: 'STANDBY', status: 'OPEN', display_wait_time: 20}],
    }];
    p.shows = [{show_id: 'usj.usj.show.shrek_4d_adventure', name: 'Shrek', status: 'OPEN', show_times: []}];
    const [row] = await p.live();
    expect(row).toEqual({
      id: 'usj.usj.show.shrek_4d_adventure',
      status: 'OPERATING',
      queue: {STANDBY: {waitTime: 20}},
    });
  });

  test('rows in only one feed are unchanged', async () => {
    const rows = await new Probe().live();
    expect(rows.find((r) => r.id === 'usj.usj.ride.flying_dinosaur')).toEqual({
      id: 'usj.usj.ride.flying_dinosaur',
      status: 'OPERATING',
      queue: {STANDBY: {waitTime: 45}},
    });
    expect(rows.find((r) => r.id === 'usj.usj.shows.waterworld')).toMatchObject({
      status: 'OPERATING',
      showtimes: [{type: 'PERFORMANCE_TIME', startTime: '2026-09-27T19:30:00+09:00', endTime: null}],
    });
  });
});

describe('USJ OUT_OF_SERVICE status', () => {
  // createStatusMap warns once per unknown status for the life of the module,
  // and the tests above already fed OUT_OF_SERVICE through the shared
  // mapQueueStatus. A fresh module instance is the only way this assertion
  // can see the warning an unmapped status would produce.
  test('maps to CLOSED without the unknown-status warning', async () => {
    vi.resetModules();
    const {mapQueueStatus: fresh} = await import('../universalstudiosjapan.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(fresh('OUT_OF_SERVICE')).toBe('CLOSED');
    expect(warn).not.toHaveBeenCalled();
  });
});
