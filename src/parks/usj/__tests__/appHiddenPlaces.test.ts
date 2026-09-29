import {describe, test, expect, beforeEach} from 'vitest';
import {UniversalStudiosJapan, isShownInApp, isSuppressedPlace} from '../universalstudiosjapan.js';
import {CacheLib} from '../../../cache.js';

/**
 * Space Fantasy - The Ride runs as themed overlays under their own place ids.
 * While one runs, the base listing is Web-only (the official app hides it) and
 * its wait row sits at BRIEF_DELAY through open hours. It is published only
 * while the app shows it, so if the base ride returns to the Mobile channel it
 * comes back as a full entity.
 */
const SPACE_FANTASY = 'usj.usj.rides.space_fantasy_the_ride';
const OTHER_RIDE = 'usj.usj.rides.jurassic_park_the_ride';

const place = (place_id: string, name: string, channel_types: unknown) => ({
  place_id,
  name,
  place_type: {type: 'Ride'},
  channel_types,
  tags: ['Attraction', 'hollywood'],
  geometry: {locations: [{location_type: 'map', lat_lng: {lat: 34.66, lng: 135.43}}]},
});

const waitRow = (id: string, status: string) => ({
  wait_time_attraction_id: id,
  show_externally: true,
  category: 'general',
  queues: [{queue_id: `${id}_standby`, queue_type: 'STANDBY', status}],
});

class Probe extends UniversalStudiosJapan {
  constructor(private places: any[] | Error, private sfStatus = 'BRIEF_DELAY') {
    super();
  }
  async getPlaces(): Promise<any[]> {
    if (this.places instanceof Error) throw this.places;
    return this.places;
  }
  async getWaitTimeData(): Promise<any[]> {
    return [waitRow(SPACE_FANTASY, this.sfStatus), waitRow(OTHER_RIDE, 'OPEN')];
  }
  async getShowListData(): Promise<any[]> { return []; }
  async _init(): Promise<void> {}
  entities() { return this.buildEntityList(); }
  live() { return this.buildLiveData(); }
}

// Verbatim channel shape from 2026-09-29: the base listing is Web-only.
const webOnly = () => [
  place(SPACE_FANTASY, 'Space Fantasy - The Ride', 'Web'),
  // Web-only but not app-hidden-listed: must stay.
  place(OTHER_RIDE, 'Jurassic Park - The Ride', 'Web'),
];
const backInApp = (channels: unknown) => [
  place(SPACE_FANTASY, 'Space Fantasy - The Ride', channels),
  place(OTHER_RIDE, 'Jurassic Park - The Ride', 'Web'),
];

beforeEach(() => {
  CacheLib.clearByClassName('Probe');
});

describe('isShownInApp', () => {
  test('Web-only string is hidden', () => {
    expect(isShownInApp({channel_types: 'Web'})).toBe(false);
  });
  test('Mobile string is shown', () => {
    expect(isShownInApp({channel_types: 'Mobile'})).toBe(true);
  });
  test('array including Mobile is shown', () => {
    expect(isShownInApp({channel_types: ['Mobile', 'Web']})).toBe(true);
  });
  test('array without Mobile is hidden', () => {
    expect(isShownInApp({channel_types: ['Web']})).toBe(false);
  });
  test('missing channel data counts as shown', () => {
    expect(isShownInApp({})).toBe(true);
  });
});

describe('isSuppressedPlace', () => {
  test('Space Fantasy is suppressed only while Web-only', () => {
    expect(isSuppressedPlace({place_id: SPACE_FANTASY, channel_types: 'Web'})).toBe(true);
    expect(isSuppressedPlace({place_id: SPACE_FANTASY, channel_types: ['Mobile', 'Web']})).toBe(false);
  });
  test('Web-only alone does not suppress other places', () => {
    expect(isSuppressedPlace({place_id: OTHER_RIDE, channel_types: 'Web'})).toBe(false);
  });
  test('retired places stay suppressed whatever the channel', () => {
    expect(isSuppressedPlace({place_id: 'usj.usj.show.shrek_4d_adventure', channel_types: 'Mobile'})).toBe(true);
  });
});

describe('USJ Space Fantasy base listing', () => {
  test('while Web-only: no entity and no live row', async () => {
    const probe = new Probe(webOnly());
    const entityIds = (await probe.entities()).map((e) => e.id);
    expect(entityIds).not.toContain(SPACE_FANTASY);
    expect(entityIds).toContain(OTHER_RIDE);

    const liveIds = (await probe.live()).map((r) => r.id);
    expect(liveIds).not.toContain(SPACE_FANTASY);
    expect(liveIds).toContain(OTHER_RIDE);
  });

  test.each([
    ['Mobile'],
    [['Mobile', 'Web']],
  ])('back on the app channel (%j): full entity and live row again', async (channels) => {
    const probe = new Probe(backInApp(channels), 'OPEN');
    const entityIds = (await probe.entities()).map((e) => e.id);
    expect(entityIds).toContain(SPACE_FANTASY);

    const liveIds = (await probe.live()).map((r) => r.id);
    expect(liveIds).toContain(SPACE_FANTASY);
  });

  test('places feed down: live data drops it, other rows unaffected', async () => {
    const probe = new Probe(new Error('places unavailable'));
    const liveIds = (await probe.live()).map((r) => r.id);
    expect(liveIds).not.toContain(SPACE_FANTASY);
    expect(liveIds).toContain(OTHER_RIDE);
  });

  test('missing from the places feed: live data drops it', async () => {
    const probe = new Probe([place(OTHER_RIDE, 'Jurassic Park - The Ride', 'Web')]);
    const liveIds = (await probe.live()).map((r) => r.id);
    expect(liveIds).not.toContain(SPACE_FANTASY);
  });
});
