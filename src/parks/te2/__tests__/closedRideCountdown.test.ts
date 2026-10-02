import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {WarnerBrosMovieWorld, SeaWorldGoldCoast} from '../te2.js';
import {CacheLib} from '../../../cache.js';
import type {HTTPObj} from '../../../http.js';

/**
 * The POI status feed carries both `isOpen` and `operationalStatus`. The
 * park's own app reads only `operationalStatus`: it shows a wait when that is
 * "OPEN", shows the ride as down for "DOWN" and closed for "CLOSED", and
 * ignores `isOpen`.
 *
 * While a ride is closed its `waitTime` holds a countdown to opening (342,
 * then 341, then 298 over the night), and a ride that goes down keeps its
 * last wait. Neither is a queue, and the app shows neither, so a standby wait
 * is published only for an OPEN ride.
 */

const RIDE = 'ride-superman-escape';
const OTHER = 'ride-scooby-doo';
const THIRD = 'ride-doomsday-destroyer';

function stubbed<T extends WarnerBrosMovieWorld | SeaWorldGoldCoast>(park: T, opts: {poiStatus: any[]}): T {
  const p: any = park;
  p.getEntities = async () => [
    {id: RIDE, name: 'Superman Escape', entityType: 'ATTRACTION'},
    {id: OTHER, name: 'Scooby-Doo Spooky Coaster', entityType: 'ATTRACTION'},
    {id: THIRD, name: 'Doomsday Destroyer', entityType: 'ATTRACTION'},
  ];
  p.getEventCalendar = async () => ({events: [], schedules: []});
  p.fetchPOIStatus = async () => ({json: async () => opts.poiStatus} as any as HTTPObj);
  return park;
}

/** A row shaped like GET /rest/venue/{venueId}/poi/all/status. */
function poiStatus(id: string, operationalStatus: string | undefined, waitTime: number, isOpen: boolean) {
  return {id, status: {isOpen, waitTime, operationalStatus}};
}

async function liveFor(rows: any[]) {
  return stubbed(new WarnerBrosMovieWorld(), {poiStatus: rows}).getLiveData();
}

describe('TE2 live status follows operationalStatus', () => {
  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test.each([342, 341, 298])('a CLOSED ride counting down (%i) publishes CLOSED with no standby queue', async (value) => {
    const live = await liveFor([poiStatus(RIDE, 'CLOSED', value, false)]);
    const ride = live.find(l => l.id === RIDE)!;

    expect(ride.status).toBe('CLOSED');
    expect(ride.queue?.STANDBY).toBeUndefined();
  });

  test('a CLOSED ride is closed even when isOpen says true', async () => {
    const live = await liveFor([poiStatus(RIDE, 'CLOSED', 342, true)]);
    const ride = live.find(l => l.id === RIDE)!;

    expect(ride.status).toBe('CLOSED');
    expect(ride.queue?.STANDBY).toBeUndefined();
  });

  test('a DOWN ride carrying a stale wait publishes DOWN with no standby queue', async () => {
    const live = await liveFor([poiStatus(RIDE, 'DOWN', 25, false)]);
    const ride = live.find(l => l.id === RIDE)!;

    expect(ride.status).toBe('DOWN');
    expect(ride.queue?.STANDBY).toBeUndefined();
  });

  test('an OPEN ride publishes its wait, whatever isOpen says and in any case', async () => {
    const live = await liveFor([
      poiStatus(RIDE, 'OPEN', 15, true),
      poiStatus(OTHER, 'Open', 0, false),
      poiStatus(THIRD, 'open', 40, true),
    ]);

    for (const [id, wait] of [[RIDE, 15], [OTHER, 0], [THIRD, 40]] as const) {
      const ride = live.find(l => l.id === id)!;
      expect(ride.status).toBe('OPERATING');
      expect(ride.queue?.STANDBY?.waitTime).toBe(wait);
    }
  });

  test('a row with no operationalStatus is not shown as open', async () => {
    const live = await liveFor([poiStatus(RIDE, undefined, 10, true)]);
    const ride = live.find(l => l.id === RIDE)!;

    expect(ride.status).toBe('CLOSED');
    expect(ride.queue?.STANDBY).toBeUndefined();
  });
});

/**
 * Rows captured from Movie World's two live feeds in the same poll, trimmed to
 * a few rides (see fixtures/movieworld-live-status.json).
 *
 * The virtual queue ("fastpass") ride feed's `state` and queue `isOpen`
 * describe whether that virtual queue has places left, not whether the ride
 * is running. BATWING was running with a 25 minute wait (POI "OPEN") while its
 * virtual queue was sold out (`state: "full"`, `isOpen: false`), and reading
 * that feed published it as CLOSED. Status now always comes from the POI feed.
 */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/movieworld-live-status.json', import.meta.url), 'utf8'));
const BATWING = 'b97d582c-f145-44f1-b30c-1108d162a471';
const GREEN_LANTERN = '911615ad-d090-476b-8989-d7955276d3b6';
const WILD_WEST_FALLS = 'aadb584a-5a3f-43b8-a847-b1d801697db2';
const DC_RIVALS = '0dff7787-ee7b-4e40-9bf0-0e874772de53';
const SUPERMAN = 'a8738743-2b09-44ad-895a-c89ff947d2f0';

function capturedPark(poiStatus: any[], park: WarnerBrosMovieWorld = new WarnerBrosMovieWorld()) {
  const p: any = park;
  p.getEntities = async () => poiStatus.map((row: any) => ({id: row.id, name: row.label, entityType: 'ATTRACTION'}));
  p.getEventCalendar = async () => ({events: [], schedules: []});
  p.fetchPOIStatus = async () => ({json: async () => poiStatus} as any as HTTPObj);
  return park;
}

describe('TE2 live status from captured feeds', () => {
  beforeEach(() => CacheLib.clear());
  afterEach(() => {
    CacheLib.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test('the fixture pairs a sold out virtual queue with a running ride', () => {
    const fp = fixture.rideStatusDay.find((r: any) => r.tags.includes(`te2_rideId:${BATWING}`));
    const poi = fixture.poiStatusDay.find((r: any) => r.id === BATWING);
    expect(fp).toMatchObject({state: 'full', hideUnavailableWaitTime: false, queues: [{isPrimary: true, isOpen: false, waitTimeMins: 25}]});
    expect(poi.status).toMatchObject({operationalStatus: 'OPEN', waitTime: 25});
  });

  test('virtual queue full, POI OPEN: OPERATING with its wait', async () => {
    const live = await capturedPark(fixture.poiStatusDay).getLiveData();
    expect(live.find(l => l.id === BATWING)).toEqual({id: BATWING, status: 'OPERATING', queue: {STANDBY: {waitTime: 25}}});
    expect(live.find(l => l.id === GREEN_LANTERN)).toEqual({id: GREEN_LANTERN, status: 'OPERATING', queue: {STANDBY: {waitTime: 30}}});
  });

  test.each([
    ['virtual queue full_and_closed', WILD_WEST_FALLS],
    ['virtual queue closed but isOpen true', DC_RIVALS],
  ])('%s, POI DOWN: DOWN with no standby queue', async (_label, id) => {
    const live = await capturedPark(fixture.poiStatusDay).getLiveData();
    expect(live.find(l => l.id === id)).toEqual({id, status: 'DOWN'});
  });

  test('overnight POI DOWN with a wait of 5: DOWN with no standby queue', async () => {
    const live = await capturedPark(fixture.poiStatusNight).getLiveData();
    for (const id of [BATWING, SUPERMAN]) {
      const row = fixture.poiStatusNight.find((r: any) => r.id === id);
      expect(row.status).toMatchObject({operationalStatus: 'DOWN', waitTime: 5});
      expect(live.find(l => l.id === id)).toEqual({id, status: 'DOWN'});
    }
  });

  test('a ride status URL in config or env is ignored: status still comes from the POI feed', async () => {
    const url = 'https://ride-status.example/api/guest/rides';
    vi.stubEnv('WARNERBROSMOVIEWORLD_RIDESTATUSURL', url);
    vi.stubEnv('TE2_RIDESTATUSURL', url);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const configured = await capturedPark(fixture.poiStatusDay, new WarnerBrosMovieWorld({config: {rideStatusUrl: url}})).getLiveData();
    CacheLib.clear();
    vi.unstubAllEnvs();
    const plain = await capturedPark(fixture.poiStatusDay).getLiveData();

    expect(configured).toEqual(plain);
    expect(configured.find(l => l.id === BATWING)?.status).toBe('OPERATING');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('the live data path never attaches STANDBY to a ride that is not OPERATING', async () => {
    const park: any = capturedPark([]);
    park.getLiveStatus = async () => [
      {id: BATWING, status: 'DOWN', waitTime: 5},
      {id: SUPERMAN, status: 'CLOSED', waitTime: 342},
    ];
    park.getEntities = async () => [
      {id: BATWING, name: 'BATWING Spaceshot', entityType: 'ATTRACTION'},
      {id: SUPERMAN, name: 'SUPERMAN Escape', entityType: 'ATTRACTION'},
    ];
    const live = await (park as WarnerBrosMovieWorld).getLiveData();
    expect(live).toEqual(expect.arrayContaining([{id: BATWING, status: 'DOWN'}, {id: SUPERMAN, status: 'CLOSED'}]));
    expect(live.every(l => !l.queue)).toBe(true);
  });
});
