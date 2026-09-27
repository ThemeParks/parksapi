import {describe, test, expect, beforeEach} from 'vitest';
import {UniversalStudiosJapan} from '../universalstudiosjapan.js';
import {CacheLib} from '../../../cache.js';

/**
 * Shrek's 4-D Adventure and Sesame Street 4-D Movie Magic closed permanently
 * in 2025, but every upstream feed still publishes them: places (as Rides),
 * wait times (BRIEF_DELAY) and the show list (OUT_OF_SERVICE). The official
 * app hides both. They must not reach the entity list or live data.
 */
const SHREK = 'usj.usj.show.shrek_4d_adventure';
const SESAME = 'usj.usj.show.sesame_street_4D_movie_magic';
const LIVE_SHOW = 'usj.usj.show.sing_on_tour';

const place = (place_id: string, name: string, channel_types: unknown) => ({
  place_id,
  name,
  place_type: {type: 'Ride'},
  channel_types,
  tags: ['Attraction', 'hollywood'],
  geometry: {locations: [{location_type: 'map', lat_lng: {lat: 34.66, lng: 135.43}}]},
});

// Verbatim shapes from 2026-09-27: the retired pair are Web-only.
const PLACES = [
  place(SHREK, 'Shrek’s 4-D Adventure', 'Web'),
  place(SESAME, 'Sesame Street 4-D Movie Magic™', 'Web'),
  place(LIVE_SHOW, 'SING on Tour', ['Mobile', 'Web']),
  // Web-only but NOT retired: the channel alone must not drop a place.
  place('usj.usj.rides.jurassic_park_the_ride', 'Jurassic Park - The Ride', 'Web'),
];

const waitRow = (id: string, status: string) => ({
  wait_time_attraction_id: id,
  show_externally: true,
  category: 'general',
  queues: [{queue_id: id, queue_type: 'STANDBY', status}],
});

class Probe extends UniversalStudiosJapan {
  async getPlaces(): Promise<any[]> { return PLACES; }
  async getWaitTimeData(): Promise<any[]> {
    return [waitRow(SHREK, 'BRIEF_DELAY'), waitRow(SESAME, 'BRIEF_DELAY'), waitRow(LIVE_SHOW, 'CLOSED')];
  }
  async getShowListData(): Promise<any[]> {
    return [
      {show_id: SHREK, name: 'Shrek', status: 'OUT_OF_SERVICE', show_times: []},
      {show_id: SESAME, name: 'Sesame', status: 'OUT_OF_SERVICE', show_times: []},
      {show_id: LIVE_SHOW, name: 'SING on Tour', status: 'CLOSED', show_times: []},
    ];
  }
  async _init(): Promise<void> {}
  entities() { return this.buildEntityList(); }
  live() { return this.buildLiveData(); }
}

beforeEach(() => {
  CacheLib.clearByClassName('Probe');
});

describe('USJ retired 4-D shows', () => {
  test('are not in the entity list', async () => {
    const ids = (await new Probe().entities()).map((e) => e.id);
    expect(ids).not.toContain(SHREK);
    expect(ids).not.toContain(SESAME);
    expect(ids).toContain(LIVE_SHOW);
  });

  test('a Web-only place that is not retired is kept', async () => {
    const ids = (await new Probe().entities()).map((e) => e.id);
    expect(ids).toContain('usj.usj.rides.jurassic_park_the_ride');
  });

  test('get no live row from either feed', async () => {
    const ids = (await new Probe().live()).map((r) => r.id);
    expect(ids).toEqual([LIVE_SHOW]);
  });
});
