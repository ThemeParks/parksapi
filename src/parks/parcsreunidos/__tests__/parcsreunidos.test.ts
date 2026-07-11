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
