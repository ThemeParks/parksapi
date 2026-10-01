import {describe, test, expect, vi, beforeEach, afterEach, beforeAll, afterAll} from 'vitest';
import {createServer, IncomingMessage, ServerResponse} from 'http';
import {MovieParkGermany, Mirabilandia, mapStayAppAttractionStatus} from '../parcsreunidos.js';
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

  test('when the park is shut every listed ride is CLOSED regardless of wait_time', async () => {
    expect(await statusFor({closed: 0, wait_time: 25}, {isopen: false}))
      .toEqual({status: 'CLOSED', waitTime: undefined, emitted: 1});
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
    // healthy collector on another host.
    const park = new Mirabilandia();
    park.waitTimesUrl = FEED_URL;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    park.fetchWaitTimesInfo = async () => { throw new Error('feed down'); };
    park.fetchWaitTimes = async () => { throw new Error('feed down'); };

    await expect(park.getLiveData()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
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
