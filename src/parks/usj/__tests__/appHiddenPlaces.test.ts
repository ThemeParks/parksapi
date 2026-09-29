import {describe, test, expect} from 'vitest';
import {
  UniversalStudiosJapan,
  isShownInApp,
  isClosedWhileHiddenFromApp,
} from '../universalstudiosjapan.js';

/**
 * Space Fantasy - The Ride runs as themed overlays under their own place ids.
 * While one runs, the base listing is Web-only (the official app hides it) and
 * its wait row sits at BRIEF_DELAY through open hours. The entity is kept and
 * reported CLOSED while the app hides it; once it returns to the app its live
 * status follows the feed again.
 */
const SPACE_FANTASY = 'usj.usj.rides.space_fantasy_the_ride';
const OTHER_RIDE = 'usj.usj.rides.jurassic_park_the_ride';
const RETIRED = 'usj.usj.show.shrek_4d_adventure';

// channel_types values as the live places feed sends them on 2026-09-29:
// always a string, several channels as JSON text.
const WEB = 'Web';
const MOBILE = 'Mobile';
const MOBILE_AND_WEB = '["Mobile","Web"]';

const place = (place_id: string, name: string, channel_types: unknown) => ({
  place_id,
  name,
  place_type: {type: 'Ride'},
  channel_types,
  tags: ['Attraction', 'hollywood'],
  geometry: {locations: [{location_type: 'map', lat_lng: {lat: 34.66, lng: 135.43}}]},
});

const waitRow = (id: string, status: string, display_wait_time?: number) => ({
  wait_time_attraction_id: id,
  show_externally: true,
  category: 'general',
  queues: [{queue_id: `${id}_standby`, queue_type: 'STANDBY', status, display_wait_time}],
});

// Named apart from the other USJ test probes so cache keys (built from the
// class name) can never be shared between files.
class AppGatedProbe extends UniversalStudiosJapan {
  constructor(
    private places: any[] | Error,
    private sfStatus = 'BRIEF_DELAY',
    private sfWait?: number,
  ) {
    super();
  }
  async getPlaces(): Promise<any[]> {
    if (this.places instanceof Error) throw this.places;
    return this.places;
  }
  async getWaitTimeData(): Promise<any[]> {
    return [waitRow(SPACE_FANTASY, this.sfStatus, this.sfWait), waitRow(OTHER_RIDE, 'OPEN', 15)];
  }
  async getShowListData(): Promise<any[]> { return []; }
  async _init(): Promise<void> {}
  entities() { return this.buildEntityList(); }
  live() { return this.buildLiveData(); }
}

const places = (sfChannels: unknown) => [
  place(SPACE_FANTASY, 'Space Fantasy - The Ride', sfChannels),
  // Web-only but not app-gated: its live row must follow the feed.
  place(OTHER_RIDE, 'Jurassic Park - The Ride', WEB),
];

const liveRow = async (probe: AppGatedProbe, id: string) =>
  (await probe.live()).find((r) => r.id === id);

describe('isShownInApp', () => {
  test.each([
    [WEB, false],
    [MOBILE, true],
    [MOBILE_AND_WEB, true],
    ['["Web"]', false],
    ['MOBILE', true],
    ['web, mobile', true],
    [['Mobile', 'Web'], true],
    ['', false],
    ['[]', false],
    [undefined, true],
    [null, true],
  ])('channel_types %j -> shown %s', (channel_types, shown) => {
    expect(isShownInApp({channel_types} as any)).toBe(shown);
  });
});

describe('isClosedWhileHiddenFromApp', () => {
  test('Space Fantasy only while the app hides it', () => {
    expect(isClosedWhileHiddenFromApp({place_id: SPACE_FANTASY, channel_types: WEB})).toBe(true);
    expect(isClosedWhileHiddenFromApp({place_id: SPACE_FANTASY, channel_types: MOBILE_AND_WEB})).toBe(false);
  });
  test('Web-only alone does not gate other places', () => {
    expect(isClosedWhileHiddenFromApp({place_id: OTHER_RIDE, channel_types: WEB})).toBe(false);
  });
});

describe('USJ Space Fantasy base listing', () => {
  test('the entity is kept whatever the channel', async () => {
    for (const channels of [WEB, MOBILE, MOBILE_AND_WEB]) {
      const entity = (await new AppGatedProbe(places(channels)).entities())
        .find((e) => e.id === SPACE_FANTASY);
      expect(entity).toMatchObject({
        name: 'Space Fantasy - The Ride',
        entityType: 'ATTRACTION',
        location: {latitude: 34.66, longitude: 135.43},
      });
    }
  });

  test('while Web-only, a placeholder BRIEF_DELAY goes out as CLOSED, not DOWN', async () => {
    const row = await liveRow(new AppGatedProbe(places(WEB)), SPACE_FANTASY);
    expect(row).toEqual({id: SPACE_FANTASY, status: 'CLOSED'});
  });

  test('while Web-only, even an OPEN row goes out as CLOSED', async () => {
    const row = await liveRow(new AppGatedProbe(places(WEB), 'OPEN', 20), SPACE_FANTASY);
    expect(row).toEqual({id: SPACE_FANTASY, status: 'CLOSED'});
  });

  test.each([[MOBILE], [MOBILE_AND_WEB]])(
    'back in the app (%j): live status and wait follow the feed',
    async (channels) => {
      const row = await liveRow(new AppGatedProbe(places(channels), 'OPEN', 25), SPACE_FANTASY);
      expect(row?.status).toBe('OPERATING');
      expect(row?.queue?.STANDBY?.waitTime).toBe(25);
    },
  );

  test('back in the app, a real BRIEF_DELAY is published as DOWN', async () => {
    const row = await liveRow(new AppGatedProbe(places(MOBILE_AND_WEB), 'BRIEF_DELAY'), SPACE_FANTASY);
    expect(row?.status).toBe('DOWN');
  });

  test('places feed down: reported CLOSED, other rows follow the feed', async () => {
    const probe = new AppGatedProbe(new Error('places unavailable'));
    const live = await probe.live();
    expect(live.find((r) => r.id === SPACE_FANTASY)).toEqual({id: SPACE_FANTASY, status: 'CLOSED'});
    const other = live.find((r) => r.id === OTHER_RIDE);
    expect(other?.status).toBe('OPERATING');
    expect(other?.queue?.STANDBY?.waitTime).toBe(15);
  });

  test('missing from the places feed: no entity and no live row', async () => {
    const probe = new AppGatedProbe([place(OTHER_RIDE, 'Jurassic Park - The Ride', WEB)]);
    expect((await probe.entities()).map((e) => e.id)).not.toContain(SPACE_FANTASY);
    expect(await liveRow(probe, SPACE_FANTASY)).toBeUndefined();
  });

  test('retired places stay out of both lists whatever the channel', async () => {
    const probe = new AppGatedProbe([...places(WEB), place(RETIRED, 'Shrek’s 4-D Adventure', MOBILE)]);
    expect((await probe.entities()).map((e) => e.id)).not.toContain(RETIRED);
    expect((await probe.live()).map((r) => r.id)).not.toContain(RETIRED);
  });
});
