import {describe, test, expect, vi, beforeEach, afterEach, beforeAll, afterAll} from 'vitest';
import {createServer, IncomingMessage, ServerResponse} from 'http';
import {MovieParkGermany} from '../parcsreunidos.js';
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
 * Status mapping for buildLiveData(). The API expresses status entirely via
 * `waitingTime` sentinels: no separate "is this ride down" field reliably
 * distinguishes a broken ride from a closed one. Verified live across 5
 * parks: -2 and -3 both behave as fresh, actively-updating, park-wide
 * "not open" signals (different establishments use different sentinels for
 * the same state) and the app's own UI shows "Geschlossen"/Closed for them
 * — not "down". `temporaryClosed` correlates with the long-stale -1 bucket
 * instead (removed/under-refurbishment rides), not with -2/-3, so there's
 * no reliable DOWN signal anywhere in this API. Every negative value maps
 * to CLOSED; only a non-negative number means OPERATING.
 */

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

describe('ParcsReunidosDestination.buildLiveData — operating status mapping', () => {
  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  async function liveStatusFor(waitingTime: number | undefined): Promise<{status: string; waitTime?: number | null}> {
    const park = new MovieParkGermany();
    park.getAttractions = async () => [{id: 1, waitingTime} as any];
    const live = await park.getLiveData();
    const entry = live.find(l => l.id === '1')!;
    return {status: entry.status as string, waitTime: entry.queue?.STANDBY?.waitTime};
  }

  test('a non-negative waitingTime maps to OPERATING with that wait time', async () => {
    expect(await liveStatusFor(12)).toEqual({status: 'OPERATING', waitTime: 12});
  });

  test('waitingTime 0 maps to OPERATING with a 0-minute wait, not CLOSED', async () => {
    expect(await liveStatusFor(0)).toEqual({status: 'OPERATING', waitTime: 0});
  });

  test('waitingTime -1 maps to CLOSED', async () => {
    expect((await liveStatusFor(-1)).status).toBe('CLOSED');
  });

  test('waitingTime -2 maps to CLOSED, not DOWN', async () => {
    expect((await liveStatusFor(-2)).status).toBe('CLOSED');
  });

  test('waitingTime -3 maps to CLOSED', async () => {
    expect((await liveStatusFor(-3)).status).toBe('CLOSED');
  });

  test('no live entry is ever emitted with status DOWN', async () => {
    const park = new MovieParkGermany();
    park.getAttractions = async () => [
      {id: 1, waitingTime: -1} as any,
      {id: 2, waitingTime: -2} as any,
      {id: 3, waitingTime: -3} as any,
      {id: 4, waitingTime: 7} as any,
    ];
    const live = await park.getLiveData();
    expect(live.some(l => l.status === 'DOWN')).toBe(false);
  });

  test('a missing waitingTime is skipped entirely, not emitted as any status', async () => {
    const park = new MovieParkGermany();
    park.getAttractions = async () => [{id: 1} as any];
    const live = await park.getLiveData();
    expect(live.find(l => l.id === '1')).toBeUndefined();
  });

  test('a numeric-string waitingTime is coerced, not misclassified as CLOSED', async () => {
    // Number.isFinite('5') is false (unlike global isFinite, it never
    // coerces) — waitingTime is only typed `number` at the TS level over an
    // unvalidated JSON response, so a numeric-string value must still
    // resolve to OPERATING rather than silently falling through to CLOSED.
    expect(await liveStatusFor('5' as any)).toEqual({status: 'OPERATING', waitTime: 5});
  });

  test('a numeric-string negative sentinel is still coerced and correctly maps to CLOSED', async () => {
    expect((await liveStatusFor('-2' as any)).status).toBe('CLOSED');
  });
});
