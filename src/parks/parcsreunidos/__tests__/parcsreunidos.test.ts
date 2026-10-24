import {describe, test, expect, vi, beforeEach, afterEach, beforeAll, afterAll} from 'vitest';
import {createServer, IncomingMessage, ServerResponse} from 'http';
import {MovieParkGermany, Mirabilandia, mapStayAppAttractionStatus, codeattrFeedShowsTrading, scheduledStateAt} from '../parcsreunidos.js';
import {CacheLib} from '../../../cache.js';
import type {HTTPObj} from '../../../http.js';

/**
 * The Stay-App bearer is a static, long-lived service-account token baked
 * into the Weex JS bundle's build-time config (`i.bearerPWA={bearer:"..."}`)
 * — shared across every Parcs Reunidos park, not obtained via any login
 * call. getAccessToken() fetches that bundle and regex-extracts the
 * constant. These tests stub fetchBearerBundle() (the @http-decorated
 * fetch) rather than global fetch, matching this repo's established
 * pattern for testing @http methods.
 */
describe('ParcsReunidosDestination — Weex bundle bearer extraction', () => {
  const ENV_KEYS = ['MOVIEPARKGERMANY_BEARERBUNDLEURL'];
  const BUNDLE_URL = 'https://token.example/bundle.js';

  beforeEach(() => {
    CacheLib.clear();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    CacheLib.clear();
  });

  function bundleWith(bearer: string): string {
    return `!function(e){...}([function(e,t,o){var i={};i.environment="production";i.elastic="OS1.2";i.bearerPWA={bearer:"${bearer}"};i.baseCmsApiHost={production:"https://api.example/manager"}}]);`;
  }

  test('extracts the bearer from a realistic bundle and injects it as Authorization', async () => {
    process.env.MOVIEPARKGERMANY_BEARERBUNDLEURL = BUNDLE_URL;
    const park = new MovieParkGermany();
    park.stayEstablishment = 'mBv6';
    park.fetchBearerBundle = async () => ({text: async () => bundleWith('TOK123')} as any as HTTPObj);

    const req = {headers: {}} as HTTPObj;
    await park.injectHeaders(req);

    expect(req.headers!['Authorization']).toBe('Bearer TOK123');
    expect(req.headers!['Stay-Establishment']).toBe('mBv6');
  });

  test('omits Authorization entirely when bearerBundleUrl is unset, rather than sending a malformed empty Bearer', async () => {
    const park = new MovieParkGermany();
    const fetchSpy = vi.spyOn(park, 'fetchBearerBundle');

    const req = {headers: {}} as HTTPObj;
    await park.injectHeaders(req);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(req.headers).not.toHaveProperty('Authorization');
    expect(req.headers!['Stay-Establishment']).toBe('');
  });

  test('omits Authorization and logs a warning when the bearerPWA constant is not found in the bundle', async () => {
    process.env.MOVIEPARKGERMANY_BEARERBUNDLEURL = BUNDLE_URL;
    const park = new MovieParkGermany();
    park.fetchBearerBundle = async () => ({text: async () => 'some unrelated bundle content'} as any as HTTPObj);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const req = {headers: {}} as HTTPObj;
    await park.injectHeaders(req);

    expect(req.headers).not.toHaveProperty('Authorization');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bearerPWA constant not found'));
    warnSpy.mockRestore();
  });

  test('caches the extracted bearer — a second call does not re-fetch the bundle', async () => {
    process.env.MOVIEPARKGERMANY_BEARERBUNDLEURL = BUNDLE_URL;
    const park = new MovieParkGermany();
    const fetchMock = vi.fn(async () => ({text: async () => bundleWith('TOK123')} as any as HTTPObj));
    park.fetchBearerBundle = fetchMock;

    await park.getAccessToken();
    await park.getAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('cached under a class-scoped key, reachable via CacheLib.clearByClassName', async () => {
    process.env.MOVIEPARKGERMANY_BEARERBUNDLEURL = BUNDLE_URL;
    const park = new MovieParkGermany();
    const fetchMock = vi.fn(async () => ({text: async () => bundleWith('TOK123')} as any as HTTPObj));
    park.fetchBearerBundle = fetchMock;

    await park.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cleared = CacheLib.clearByClassName('MovieParkGermany');
    expect(cleared).toBeGreaterThan(0);

    await park.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('parses a real-shaped bundle fragment matching the production config module structure', async () => {
    process.env.MOVIEPARKGERMANY_BEARERBUNDLEURL = BUNDLE_URL;
    const park = new MovieParkGermany();
    const realShape = 'Object.defineProperty(t,"__esModule",{value:!0});var i={};i.environment="production";'
      + 'i.elastic="OS1.2";i.development=!1,i.loggerEnabled=!0;i.bearerPWA={bearer:"eyJhbGc.eyJpYXQ.SIG"},'
      + 'i.baseCmsApiHost={production:"https://api.example/manager",preproduction:"https://api-p';
    park.fetchBearerBundle = async () => ({text: async () => realShape} as any as HTTPObj);

    const token = await park.getAccessToken();

    expect(token).toBe('eyJhbGc.eyJpYXQ.SIG');
  });

  test('extracts the bearer even when it is not the first key in the bearerPWA object', async () => {
    process.env.MOVIEPARKGERMANY_BEARERBUNDLEURL = BUNDLE_URL;
    const park = new MovieParkGermany();
    const reordered = 'i.environment="production";i.bearerPWA={someOtherField:"Y",bearer:"TOK123",another:"Z"};';
    park.fetchBearerBundle = async () => ({text: async () => reordered} as any as HTTPObj);

    expect(await park.getAccessToken()).toBe('TOK123');
  });

  test('extracts the bearer when bearerPWA is emitted as an object-literal property (`:`) instead of an assignment (`=`)', async () => {
    process.env.MOVIEPARKGERMANY_BEARERBUNDLEURL = BUNDLE_URL;
    const park = new MovieParkGermany();
    const objectLiteralShape = 'return{environment:"production",bearerPWA:{bearer:"TOK123"},baseCmsApiHost:{}}';
    park.fetchBearerBundle = async () => ({text: async () => objectLiteralShape} as any as HTTPObj);

    expect(await park.getAccessToken()).toBe('TOK123');
  });

  test('throws (rather than returning empty string) when bearerBundleUrl is unset, so the failure is never cached as a success', async () => {
    const park = new MovieParkGermany();
    await expect(park.getAccessToken()).rejects.toThrow('bearerBundleUrl not configured');
  });

  test('backs off for 5 minutes after a failed fetch instead of re-fetching the bundle on every call', async () => {
    process.env.MOVIEPARKGERMANY_BEARERBUNDLEURL = BUNDLE_URL;
    const park = new MovieParkGermany();
    const fetchMock = vi.fn(async () => ({text: async () => 'no bearerPWA here'} as any as HTTPObj));
    park.fetchBearerBundle = fetchMock;

    await expect(park.getAccessToken()).rejects.toThrow();
    await expect(park.getAccessToken()).rejects.toThrow('backing off');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('recovers after a failure once the backoff window is cleared', async () => {
    process.env.MOVIEPARKGERMANY_BEARERBUNDLEURL = BUNDLE_URL;
    const park = new MovieParkGermany();
    const fetchMock = vi.fn(async () => ({text: async () => 'no bearerPWA here'} as any as HTTPObj));
    park.fetchBearerBundle = fetchMock;

    await expect(park.getAccessToken()).rejects.toThrow();
    CacheLib.clear();
    fetchMock.mockImplementation(async () => ({text: async () => bundleWith('TOK123')} as any as HTTPObj));

    expect(await park.getAccessToken()).toBe('TOK123');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * fetchBearerBundle() itself — real HTTP call against a local server,
 * unstubbed, matching the pattern in src/__tests__/httpIntegration.test.ts.
 * Every other bearer-extraction test stubs this method directly, so none
 * of them would catch a regression that drops or typos the isBundleRequest
 * header or user-agent — per Stay-App's own bundle server, those are what
 * select the bundle variant carrying the bearerPWA constant at all.
 */
describe('ParcsReunidosDestination.fetchBearerBundle — real HTTP request shape', () => {
  const TEST_PORT = 9993;
  const TEST_URL = `http://localhost:${TEST_PORT}`;
  let server: ReturnType<typeof createServer>;
  let lastRequestHeaders: Record<string, string | string[] | undefined> = {};

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      lastRequestHeaders = req.headers;
      res.writeHead(200, {'Content-Type': 'text/javascript'});
      res.end('i.bearerPWA={bearer:"TOK123"};');
    });
    await new Promise<void>(resolve => server.listen(TEST_PORT, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });

  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test('sends isBundleRequest and a WeexStayApp user-agent, and the real response round-trips through getAccessToken', async () => {
    const park = new MovieParkGermany();
    park.bearerBundleUrl = TEST_URL;

    const token = await park.getAccessToken();

    expect(token).toBe('TOK123');
    expect(lastRequestHeaders['isbundlerequest']).toBe('true');
    expect(String(lastRequestHeaders['user-agent'])).toMatch(/WeexStayApp/);
  });
});

/**
 * Status mapping for buildLiveData(), mirroring the parks' shared app:
 *   temporaryClosed true  -> "temporarily closed", no wait shown
 *   waitingTime >= 0      -> "<n> min"
 *   waitingTime -2        -> "closed"
 *   waitingTime -1 / -3   -> "waiting time not available"
 * The flag wins over any wait time: a ride the app shows as temporarily
 * closed must never be published OPERATING with a wait.
 */
describe('mapStayAppAttractionStatus', () => {
  test('a non-negative waitingTime is OPERATING with that standby wait', () => {
    expect(mapStayAppAttractionStatus({waitingTime: 12}, true)).toEqual({status: 'OPERATING', waitTime: 12});
  });

  test('waitingTime 0 is a 0-minute walk-on, not CLOSED', () => {
    expect(mapStayAppAttractionStatus({waitingTime: 0}, true)).toEqual({status: 'OPERATING', waitTime: 0});
  });

  test('temporaryClosed with a posted wait is DOWN with no wait while the park operates', () => {
    expect(mapStayAppAttractionStatus({waitingTime: 25, temporaryClosed: true}, true)).toEqual({status: 'DOWN'});
  });

  test('temporaryClosed is CLOSED, not DOWN, when the park is not operating', () => {
    expect(mapStayAppAttractionStatus({waitingTime: 25, temporaryClosed: true}, false)).toEqual({status: 'CLOSED'});
  });

  test.each([-1, -2, -3])('temporaryClosed overrides the %i sentinel', (waitingTime) => {
    expect(mapStayAppAttractionStatus({waitingTime, temporaryClosed: true}, true)).toEqual({status: 'DOWN'});
  });

  test('temporaryClosed with no waitingTime is still published', () => {
    expect(mapStayAppAttractionStatus({temporaryClosed: true}, true)).toEqual({status: 'DOWN'});
  });

  test('temporaryClosed false behaves as if absent', () => {
    expect(mapStayAppAttractionStatus({waitingTime: 8, temporaryClosed: false}, true)).toEqual({status: 'OPERATING', waitTime: 8});
  });

  test('waitingTime -2 ("closed") is CLOSED with no wait', () => {
    expect(mapStayAppAttractionStatus({waitingTime: -2}, true)).toEqual({status: 'CLOSED'});
  });

  test.each([-1, -3])('waitingTime %i ("waiting time not available") is CLOSED with no wait', (waitingTime) => {
    expect(mapStayAppAttractionStatus({waitingTime}, true)).toEqual({status: 'CLOSED'});
  });

  test('a missing waitingTime publishes nothing', () => {
    expect(mapStayAppAttractionStatus({}, true)).toBeNull();
    expect(mapStayAppAttractionStatus({waitingTime: null as any}, true)).toBeNull();
    expect(mapStayAppAttractionStatus({waitingTime: '' as any}, true)).toBeNull();
  });

  test('numeric strings are coerced, both waits and sentinels', () => {
    expect(mapStayAppAttractionStatus({waitingTime: '5' as any}, true)).toEqual({status: 'OPERATING', waitTime: 5});
    expect(mapStayAppAttractionStatus({waitingTime: '-2' as any}, true)).toEqual({status: 'CLOSED'});
  });
});

describe('ParcsReunidosDestination.buildLiveData', () => {
  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  async function liveFor(attractions: any[]) {
    const park = new MovieParkGermany();
    park.getAttractions = async () => attractions;
    const live = await park.getLiveData();
    return Object.fromEntries(live.map(l => [l.id, {status: l.status, waitTime: l.queue?.STANDBY?.waitTime}]));
  }

  test('a temporarily closed ride with a wait is DOWN with no queue while other rides post waits', async () => {
    const live = await liveFor([
      {id: 1, waitingTime: 15},
      {id: 2, waitingTime: 30, temporaryClosed: true},
    ]);
    expect(live['1']).toEqual({status: 'OPERATING', waitTime: 15});
    expect(live['2']).toEqual({status: 'DOWN', waitTime: undefined});
  });

  test('a temporarily closed ride is CLOSED when no other ride posts a wait', async () => {
    const live = await liveFor([
      {id: 1, waitingTime: -2},
      {id: 2, waitingTime: 30, temporaryClosed: true},
      {id: 3, waitingTime: -1, temporaryClosed: true},
    ]);
    expect(live['2']).toEqual({status: 'CLOSED', waitTime: undefined});
    expect(live['3']).toEqual({status: 'CLOSED', waitTime: undefined});
  });

  test('maps every sentinel and never attaches a wait to a non-operating ride', async () => {
    const live = await liveFor([
      {id: 1, waitingTime: 7},
      {id: 2, waitingTime: -1},
      {id: 3, waitingTime: -2},
      {id: 4, waitingTime: -3},
      {id: 5},
      {id: 6, temporaryClosed: true},
    ]);
    expect(live).toEqual({
      '1': {status: 'OPERATING', waitTime: 7},
      '2': {status: 'CLOSED', waitTime: undefined},
      '3': {status: 'CLOSED', waitTime: undefined},
      '4': {status: 'CLOSED', waitTime: undefined},
      '6': {status: 'DOWN', waitTime: undefined},
    });
  });

  test('negative sentinels alone never produce DOWN', async () => {
    const live = await liveFor([
      {id: 1, waitingTime: -1},
      {id: 2, waitingTime: -2},
      {id: 3, waitingTime: -3},
      {id: 4, waitingTime: 7},
    ]);
    expect(Object.values(live).some(l => l.status === 'DOWN')).toBe(false);
  });
});

/**
 * Mirabilandia's wait times do not come from Stay-App at all — its Stay-App
 * establishment publishes no `waitingTime` field, so the inherited
 * buildLiveData() emits nothing. The park runs its own wait-time microsite,
 * which the official app opens in a webview.
 *
 * The feed's defining quirk, and the reason these tests exist: `wait_time` and
 * the `note_*` pair are MUTUALLY EXCLUSIVE. A ride that isn't taking guests
 * carries a note and no `wait_time` key at all — it is absent, not zero. Read
 * off a closed park (where every ride reports `wait_time: 0` and no notes) the
 * feed looks like "everything is a walk-on", and mapping it that way would
 * publish a fake 0-minute wait for every ride in the park.
 */
describe('Mirabilandia — wait-time microsite live data', () => {
  const FEED_URL = 'https://feed.example/codeattr';

  /** Katun's Stay-App entity id — the join target for the `katun` feed key. */
  const KATUN = '126283';
  /** Oil Tower 1 + 2: two entities behind the single `oil_tower` feed key. */
  const OIL_TOWER_1 = '126289';
  const OIL_TOWER_2 = '126287';

  function parkWithFeed(
    attrazioni: Record<string, unknown>,
    info: Record<string, unknown> = {isopen: true},
  ): Mirabilandia {
    const park = new Mirabilandia();
    park.waitTimesUrl = FEED_URL;
    park.fetchWaitTimesInfo = async () => ({json: async () => info} as any as HTTPObj);
    park.fetchWaitTimes = async () => ({
      json: async () => ({timestamp: '2026-08-09 10:54:14', attrazioni}),
    } as any as HTTPObj);
    return park;
  }

  async function statusFor(item: Record<string, unknown>, info?: Record<string, unknown>) {
    const live = await parkWithFeed({katun: item}, info).getLiveData();
    const ld = live.find((l) => l.id === KATUN);
    return {status: ld?.status, waitTime: (ld as any)?.queue?.STANDBY?.waitTime, emitted: live.length};
  }

  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test('a note replaces wait_time entirely and must never be reported as a 0-minute wait', async () => {
    // THE regression this park exists to prevent. `wait_time` is absent, not 0.
    expect(await statusFor({closed: 0, note_it: 'Attualmente chiuso', note_en: 'Currently closed'}))
      .toEqual({status: 'CLOSED', waitTime: undefined, emitted: 1});
  });

  test('wait_time 0 is a genuine walk-on, not a closed ride', async () => {
    expect(await statusFor({closed: 0, wait_time: 0}))
      .toEqual({status: 'OPERATING', waitTime: 0, emitted: 1});
  });

  test('a real wait time is published as STANDBY minutes', async () => {
    expect(await statusFor({closed: 0, wait_time: 10}))
      .toEqual({status: 'OPERATING', waitTime: 10, emitted: 1});
  });

  test("the park's own 'not available' wording maps to DOWN", async () => {
    expect((await statusFor({closed: 0, note_it: 'Non disponibile', note_en: 'Not available'})).status)
      .toBe('DOWN');
  });

  test('a delayed opening is CLOSED, not DOWN — the ride is scheduled, not broken', async () => {
    for (const note of ['dalle 11.30', 'opening at 11.30', 'dalle 11:00', 'opening at 14']) {
      expect((await statusFor({closed: 0, note_en: note})).status).toBe('CLOSED');
    }
  });

  test('an unrecognised note falls back to CLOSED rather than inventing a breakdown', async () => {
    expect((await statusFor({closed: 0, note_en: 'Something nobody has seen before'})).status)
      .toBe('CLOSED');
  });

  test('closed:1 (hidden from the microsite UI) is CLOSED, not skipped', async () => {
    // Skipping would strand the entity's last live value instead of stating
    // its real current state.
    expect((await statusFor({closed: 1, wait_time: 0})).status).toBe('CLOSED');
  });

  test('isopen:false with a stale ride feed closes every listed ride regardless of wait_time', async () => {
    // The feed is stamped 2026-08-09 10:54:14; pin the clock a day later so
    // the stamp is stale on purpose, not by accident of when the suite runs.
    vi.useFakeTimers({toFake: ['Date']});
    try {
      vi.setSystemTime(Date.parse('2026-08-10T09:00:00Z'));
      expect(await statusFor({closed: 0, wait_time: 25}, {isopen: false}))
        .toEqual({status: 'CLOSED', waitTime: undefined, emitted: 1});
    } finally {
      vi.useRealTimers();
    }
  });

  describe('a stale isopen:false against a fresh ride feed', () => {
    // 14:54:18 Rome (CEST, UTC+2) on a Saturday the park traded until 23:00
    // while info.json still said isopen:false from the afternoon before.
    const FEED_AT = '2026-10-24 14:54:18';
    const FEED_AT_MS = Date.parse('2026-10-24T12:54:18Z');
    const TRADING = {
      katun: {closed: 0, wait_time: 30},
      desmo_race: {closed: 0, note_en: 'opening at 16', note_it: 'dalle 16'},
      // DOWN only when the park counts as trading; a shut park reads CLOSED.
      diavel_ring: {closed: 0, note_en: 'Not available', note_it: 'Non disponibile'},
    };
    const DIAVEL_RING = '125994';

    beforeEach(() => vi.useFakeTimers({toFake: ['Date']}));
    afterEach(() => vi.useRealTimers());

    // `timestamp` is passed through as given: a default here would turn the
    // `undefined` case back into a fresh feed.
    async function liveAt(nowMs: number, attrazioni: Record<string, unknown>, ...timestamp: [unknown?]) {
      vi.setSystemTime(nowMs);
      const park = parkWithFeed(attrazioni, {isopen: false, halloween_open: false});
      const ts = timestamp.length ? timestamp[0] : FEED_AT;
      park.fetchWaitTimes = async () => ({json: async () => ({timestamp: ts, attrazioni})} as any as HTTPObj);
      return park.getLiveData();
    }
    const katun = (live: any[]) => live.find((l) => l.id === KATUN);

    test('a feed regenerated minutes ago with real waits overrules the flag', async () => {
      const live = await liveAt(FEED_AT_MS + 8 * 60_000, TRADING);
      expect(katun(live)).toMatchObject({status: 'OPERATING', queue: {STANDBY: {waitTime: 30}}});
      // Rides with a note keep their note's meaning, not a blanket CLOSED.
      expect(live.find((l) => l.id === DIAVEL_RING)?.status).toBe('DOWN');
      expect(live.find((l) => l.id === '126292')?.status).toBe('CLOSED');
    });

    test('a feed older than 20 minutes does not: its waits are not a live observation', async () => {
      const live = await liveAt(FEED_AT_MS + 21 * 60_000, TRADING);
      expect(katun(live)?.status).toBe('CLOSED');
      expect(katun(live)?.queue).toBeUndefined();
    });

    test('the 20-minute limit is inclusive and exact', async () => {
      expect(katun(await liveAt(FEED_AT_MS + 20 * 60_000, TRADING))?.status).toBe('OPERATING');
      expect(katun(await liveAt(FEED_AT_MS + 20 * 60_000 + 1, TRADING))?.status).toBe('CLOSED');
      expect(katun(await liveAt(FEED_AT_MS + 19 * 60_000 + 59_000, TRADING))?.status).toBe('OPERATING');
    });

    test('the 5-minute future skew limit is inclusive and exact', async () => {
      expect(katun(await liveAt(FEED_AT_MS - 5 * 60_000, TRADING))?.status).toBe('OPERATING');
      expect(katun(await liveAt(FEED_AT_MS - 5 * 60_000 - 1, TRADING))?.status).toBe('CLOSED');
    });

    // Katun carries "Not available" in these: DOWN if the park counted as
    // trading, CLOSED if the flag still won.
    const SHUT_PROBE = {katun: {closed: 0, note_en: 'Not available'}};
    const flagWon = async (extra: Record<string, unknown>) =>
      katun(await liveAt(FEED_AT_MS + 60_000, {...SHUT_PROBE, ...extra}))?.status === 'CLOSED';

    test('only rides we publish count: a trading seasonal maze does not', async () => {
      expect(await flagWon({mini_zombie: {closed: 0, wait_time: 30}})).toBe(true);
      expect(await flagWon({aquila: {closed: 0, wait_time: 30}})).toBe(false);
    });

    test('a wait must be a valid non-negative number to count', async () => {
      for (const wait_time of [-1, ' ', 'abc', true, [], {}, Infinity]) {
        expect(await flagWon({aquila: {closed: 0, wait_time}})).toBe(true);
      }
      expect(await flagWon({aquila: {closed: 0, wait_time: '15'}})).toBe(false);
      expect(await flagWon({aquila: {closed: 0, wait_time: 0}})).toBe(false);
    });

    test('a note in either language, but not a blank or non-string one, disqualifies a ride', async () => {
      expect(await flagWon({aquila: {closed: 0, wait_time: 10, note_it: 'Attualmente chiuso'}})).toBe(true);
      expect(await flagWon({aquila: {closed: 0, wait_time: 10, note_en: '   '}})).toBe(false);
      expect(await flagWon({aquila: {closed: 0, wait_time: 10, note_en: 5}})).toBe(false);
    });

    test('null or non-object feed entries are ignored, not thrown on', async () => {
      expect(await flagWon({aquila: null, autosplash: 'x', balloons: 7})).toBe(true);
    });

    test('a well-shaped but impossible timestamp never overrules the flag', async () => {
      // Each clock is pinned one minute after the instant the impossible stamp
      // would roll over to, so only the validation, not freshness, refuses it.
      const cases: Array<[string, string]> = [
        ['2026-09-31 14:54:18', '2026-10-01T12:55:18Z'], // 31 Sep -> 1 Oct
        ['2026-10-23 24:54:18', '2026-10-23T22:55:18Z'], // 24:54 -> 00:54 next day
        ['2026-10-24 14:60:18', '2026-10-24T13:01:18Z'], // 14:60 -> 15:00
        ['2026-13-45 10:00:00', '2026-10-24T13:00:00Z'],
      ];
      for (const [ts, now] of cases) {
        expect(katun(await liveAt(Date.parse(now), TRADING, ts))?.status, ts).toBe('CLOSED');
      }
    });

    // In the next two, Katun's note would read DOWN if the park counted as
    // trading, so CLOSED proves the flag still won.
    test('a fresh feed whose rides all carry notes agrees with the flag', async () => {
      const live = await liveAt(FEED_AT_MS + 60_000, {
        katun: {closed: 0, wait_time: 0, note_en: 'Not available'},
        desmo_race: {closed: 0, note_en: 'Currently closed'},
      });
      expect(katun(live)?.status).toBe('CLOSED');
    });

    test('closed:1 rides with a leftover wait_time are not evidence of trading', async () => {
      const live = await liveAt(FEED_AT_MS + 60_000, {
        aquila: {closed: 1, wait_time: 15},
        katun: {closed: 0, note_en: 'Not available'},
      });
      expect(katun(live)?.status).toBe('CLOSED');
    });

    test('an empty or null wait_time is not evidence of trading', async () => {
      for (const wait_time of ['', null]) {
        const live = await liveAt(FEED_AT_MS + 60_000, {
          aquila: {closed: 0, wait_time},
          katun: {closed: 0, note_en: 'Not available'},
        });
        expect(katun(live)?.status).toBe('CLOSED');
      }
    });

    test('a missing or unparseable timestamp never overrules the flag', async () => {
      for (const ts of [undefined, '', '24/10/2026 14:54', 'garbage', 12345]) {
        expect(katun(await liveAt(FEED_AT_MS + 60_000, TRADING, ts))?.status).toBe('CLOSED');
      }
    });

    test('a timestamp far in the future is not trusted; small clock skew is', async () => {
      expect(katun(await liveAt(FEED_AT_MS - 10 * 60_000, TRADING))?.status).toBe('CLOSED');
      expect(katun(await liveAt(FEED_AT_MS - 2 * 60_000, TRADING))?.status).toBe('OPERATING');
    });

    test('the timestamp is read in park time, not UTC', async () => {
      // Read as UTC, 14:54:18 would be two hours in the future and refused.
      expect(katun(await liveAt(FEED_AT_MS + 60_000, TRADING))?.status).toBe('OPERATING');
    });
  });

  describe('the override judged against the park\'s published hours', () => {
    // 24 Oct 2026: open 10:30-23:00 Rome (08:30-21:00Z).
    const DAY = [{
      date: '2026-10-24', type: 'OPERATING',
      openingTime: '2026-10-24T10:30:00+02:00', closingTime: '2026-10-24T23:00:00+02:00',
    }] as any;
    const at = (iso: string) => Date.parse(iso);
    const romeStamp = (ms: number) => {
      // Feed timestamps are park local time; CEST is UTC+2 on this date.
      const d = new Date(ms + 2 * 3600_000).toISOString();
      return `${d.slice(0, 10)} ${d.slice(11, 19)}`;
    };
    const RIDES = {
      katun: {closed: 0, wait_time: 30},
      diavel_ring: {closed: 0, note_en: 'Not available'},
    };

    beforeEach(() => vi.useFakeTimers({toFake: ['Date']}));
    afterEach(() => vi.useRealTimers());

    async function liveWith(opts: {nowIso: string; feedAgeMin: number; calendar?: () => Promise<any>}) {
      const nowMs = at(opts.nowIso);
      vi.setSystemTime(nowMs);
      const park = parkWithFeed(RIDES, {isopen: false});
      const ts = romeStamp(nowMs - opts.feedAgeMin * 60_000);
      park.fetchWaitTimes = async () => ({json: async () => ({timestamp: ts, attrazioni: RIDES})} as any as HTTPObj);
      if (opts.calendar) {
        park.calendarUrl = 'https://calendar.example/';
        park.parseCalendar = opts.calendar as any;
      } else {
        park.calendarUrl = '';
      }
      const live = await park.getLiveData();
      return live.find((l) => l.id === KATUN)?.status;
    }

    test('inside hours, a feed 45 minutes old still overrules the flag (no flapping between rebuilds)', async () => {
      expect(await liveWith({nowIso: '2026-10-24T17:07:00Z', feedAgeMin: 45, calendar: async () => DAY})).toBe('OPERATING');
    });

    test('inside hours, a feed older than an hour no longer does', async () => {
      expect(await liveWith({nowIso: '2026-10-24T17:07:00Z', feedAgeMin: 60, calendar: async () => DAY})).toBe('OPERATING');
      expect(await liveWith({nowIso: '2026-10-24T17:07:00Z', feedAgeMin: 61, calendar: async () => DAY})).toBe('CLOSED');
    });

    test('after the published close, even a fresh feed full of waits cannot reopen the park', async () => {
      expect(await liveWith({nowIso: '2026-10-24T21:00:00Z', feedAgeMin: 1, calendar: async () => DAY})).toBe('CLOSED');
      expect(await liveWith({nowIso: '2026-10-24T20:59:00Z', feedAgeMin: 1, calendar: async () => DAY})).toBe('OPERATING');
    });

    test('before the published open, likewise', async () => {
      expect(await liveWith({nowIso: '2026-10-24T08:29:00Z', feedAgeMin: 1, calendar: async () => DAY})).toBe('CLOSED');
    });

    test('a calendar failure falls back to the 20-minute rule rather than costing the live data', async () => {
      const boom = async () => { throw new Error('calendar down'); };
      expect(await liveWith({nowIso: '2026-10-24T17:07:00Z', feedAgeMin: 8, calendar: boom})).toBe('OPERATING');
      expect(await liveWith({nowIso: '2026-10-24T17:07:00Z', feedAgeMin: 25, calendar: boom})).toBe('CLOSED');
    });

    test('an empty calendar is unknown, not "closed all day"', async () => {
      expect(await liveWith({nowIso: '2026-10-24T17:07:00Z', feedAgeMin: 8, calendar: async () => []})).toBe('OPERATING');
      expect(await liveWith({nowIso: '2026-10-24T17:07:00Z', feedAgeMin: 25, calendar: async () => []})).toBe('CLOSED');
    });

    test('no calendar configured keeps the 20-minute rule', async () => {
      expect(await liveWith({nowIso: '2026-10-24T17:07:00Z', feedAgeMin: 8})).toBe('OPERATING');
      expect(await liveWith({nowIso: '2026-10-24T17:07:00Z', feedAgeMin: 25})).toBe('CLOSED');
    });

    test('with no calendar configured the calendar is never fetched from the live path', async () => {
      vi.setSystemTime(at('2026-10-24T17:07:00Z'));
      const park = parkWithFeed(RIDES, {isopen: false});
      park.calendarUrl = '';
      const spy = vi.fn(async () => DAY);
      park.parseCalendar = spy as any;
      await park.getLiveData();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('scheduledStateAt', () => {
    const W = (open: string, close: string, type = 'OPERATING') => ({date: open.slice(0, 10), type, openingTime: open, closingTime: close}) as any;
    const day = [W('2026-10-24T10:30:00+02:00', '2026-10-24T18:00:00+02:00'), W('2026-10-24T19:00:00+02:00', '2026-10-24T23:00:00+02:00', 'INFO')];

    test('open inside either window, including an INFO evening session', () => {
      expect(scheduledStateAt(day, Date.parse('2026-10-24T12:00:00Z'))).toBe('open');
      expect(scheduledStateAt(day, Date.parse('2026-10-24T18:00:00Z'))).toBe('open');
    });

    test('closed between and outside windows; the close instant itself is closed', () => {
      expect(scheduledStateAt(day, Date.parse('2026-10-24T16:30:00Z'))).toBe('closed');
      expect(scheduledStateAt(day, Date.parse('2026-10-24T21:00:00Z'))).toBe('closed');
      expect(scheduledStateAt(day, Date.parse('2026-10-24T08:30:00Z'))).toBe('open');
      expect(scheduledStateAt(day, Date.parse('2026-10-24T08:29:59Z'))).toBe('closed');
    });

    test('unknown when there is no usable entry; unusable ones are skipped', () => {
      expect(scheduledStateAt(undefined, 0)).toBe('unknown');
      expect(scheduledStateAt([], 0)).toBe('unknown');
      const junk = [W('nonsense', '2026-10-24T23:00:00+02:00'), W('2026-10-24T23:00:00+02:00', '2026-10-24T10:30:00+02:00'), {date: '2026-10-24', type: 'OPERATING'} as any];
      expect(scheduledStateAt(junk, Date.parse('2026-10-24T12:00:00Z'))).toBe('unknown');
      expect(scheduledStateAt([...junk, day[0]], Date.parse('2026-10-24T12:00:00Z'))).toBe('open');
    });
  });

  test('codeattrFeedShowsTrading is false for an absent payload', () => {
    expect(codeattrFeedShowsTrading(undefined, Date.now(), 'Europe/Rome')).toBe(false);
  });

  test('the single oil_tower queue is published to both Oil Tower entities', async () => {
    const live = await parkWithFeed({oil_tower: {closed: 0, wait_time: 15}}).getLiveData();
    expect(live.map((l) => l.id).sort()).toEqual([OIL_TOWER_2, OIL_TOWER_1].sort());
    for (const ld of live) {
      expect(ld.status).toBe('OPERATING');
      expect((ld as any).queue.STANDBY.waitTime).toBe(15);
    }
  });

  test('feed keys with no Stay-App entity are ignored, so no orphan ids are emitted', async () => {
    // The Halloween mazes exist only in the feed.
    const live = await parkWithFeed({
      llorona: {closed: 0, wait_time: 5},
      mini_zombie: {closed: 0, wait_time: 5},
      katun: {closed: 0, wait_time: 5},
    }).getLiveData();
    expect(live.map((l) => l.id)).toEqual([KATUN]);
  });

  test('emits nothing when no feed URL is configured, rather than throwing', async () => {
    const park = new Mirabilandia();
    park.waitTimesUrl = '';
    await expect(park.getLiveData()).resolves.toEqual([]);
  });

  test('a feed failure emits nothing rather than fabricating a status', async () => {
    // Publishing a guessed status here would overwrite good data written by a
    // healthy poll elsewhere.
    const park = new Mirabilandia();
    park.waitTimesUrl = FEED_URL;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    park.fetchWaitTimesInfo = async () => { throw new Error('feed down'); };
    park.fetchWaitTimes = async () => { throw new Error('feed down'); };

    await expect(park.getLiveData()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('a blank, boolean or negative wait_time is skipped, never published as a wait', async () => {
    for (const wait_time of [' ', true, -3]) {
      expect((await statusFor({closed: 0, wait_time: wait_time as any})).emitted).toBe(0);
    }
  });

  test('a note wins over a stray wait_time if the feed ever emits both', async () => {
    expect((await statusFor({closed: 0, wait_time: 0, note_en: 'Not available'})).status).toBe('DOWN');
  });

  test('a numeric-string wait_time is coerced rather than dropped', async () => {
    expect(await statusFor({closed: 0, wait_time: '20' as any}))
      .toEqual({status: 'OPERATING', waitTime: 20, emitted: 1});
  });

  test('an empty-string wait_time is skipped, never coerced to a 0-minute wait', async () => {
    // Number('') is 0 — the exact coercion trap this repo bans isNaN() over.
    expect((await statusFor({closed: 0, wait_time: '' as any})).emitted).toBe(0);
  });
});
