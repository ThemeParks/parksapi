import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
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
});
