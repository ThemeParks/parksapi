/**
 * What happens when the API rejects the app version we send.
 *
 * It answers 400 `error.invalidVersion` to every endpoint when the
 * `X-PORTAL-APP-VERSION` header is outside the window it supports. The version
 * comes from a feed that is cached for 12 hours, so a stale value used to keep
 * the park dark for hours. The handler meant to drop the cached value never
 * ran (a rejected request raises `httpError`, not `httpResponse`) and, had it
 * run, its hand-written key could not match the key the `@cache` decorator
 * builds (the decorator appends every argument). These tests drive the real
 * `@http`, `@cache` and `@inject` stack with a fake transport standing in for
 * both the API and the version feed, so they fail if either defect returns.
 */
import {describe, test, expect, beforeEach, afterEach, afterAll, vi} from 'vitest';
import {TokyoDisneyResort} from '../tokyodisneyresort.js';
import {CacheLib} from '../../../cache.js';
import {setHttpTransport} from '../../../httpProxy.js';
import {stopHttpQueue} from '../../../http.js';

const API = 'https://tdr.invalid';
const PACKAGE = 'jp.tokyodisneyresort.portalapp';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

const header = (headers: Record<string, string> | undefined, name: string): string | undefined => {
  const key = Object.keys(headers ?? {}).find(k => k.toLowerCase() === name);
  return key ? headers![key] : undefined;
};

describe('TokyoDisneyResort: the API rejects the app version we send', () => {
  let feedVersion: string;
  let acceptedVersion: string;
  let rejectionCode: string;
  let feedHits: number;
  let versionsSent: Array<string | undefined>;

  const newPark = () => new TokyoDisneyResort({config: {
    apiBase: API, apiKey: 'key', apiAuth: 'auth', apiOS: '11',
    apiVersion: '3.0.16', fallbackDeviceId: 'device-1',
  }});

  beforeEach(() => {
    CacheLib.clear({includePersistent: true});
    feedVersion = '3.12.3';
    acceptedVersion = '3.12.4';
    rejectionCode = 'error.invalidVersion';
    feedHits = 0;
    versionsSent = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    setHttpTransport(async request => {
      if (request.url.startsWith('https://api.themeparks.wiki/appwatch/latest/')) {
        feedHits++;
        return json({version: feedVersion});
      }
      const sent = header(request.headers, 'x-portal-app-version');
      versionsSent.push(sent);
      if (sent === acceptedVersion) return json([]);
      return json({errors: [{code: rejectionCode}]}, 400);
    });
  });

  afterEach(() => {
    setHttpTransport(null);
    CacheLib.clear({includePersistent: true});
    vi.restoreAllMocks();
  });

  // The queue is shared by every test in the file: stop it once, at the end.
  afterAll(() => {
    stopHttpQueue();
  });

  test('drops the cached version so the next call asks the feed again and recovers', async () => {
    const park = newPark();

    await expect(park.fetchCalendar()).rejects.toThrow(/400/);
    expect(feedHits).toBe(1);
    expect(versionsSent.at(-1)).toBe('3.12.3');

    // Nothing about the version is left behind: not the stored result, not the
    // response it was read from.
    expect(CacheLib.keys().filter(k => k.includes(PACKAGE))).toEqual([]);

    // The feed catches up. Without the drop, the cached 3.12.3 would be sent again.
    feedVersion = '3.12.4';
    await expect(park.fetchCalendar()).resolves.toBeDefined();

    expect(feedHits).toBe(2);
    expect(versionsSent.at(-1)).toBe('3.12.4');
  });

  test('a 400 that is not about the version leaves the cached version alone', async () => {
    rejectionCode = 'error.somethingElse';
    const park = newPark();

    await expect(park.fetchCalendar()).rejects.toThrow(/400/);

    expect(CacheLib.keys().filter(k => k.includes(PACKAGE)).length).toBeGreaterThan(0);
    await expect(park.fetchCalendar()).rejects.toThrow(/400/);
    expect(feedHits).toBe(1); // still served from the cache
  });

  test('a maintenance response is logged, does not throw, and keeps the cached version', async () => {
    const park = newPark();
    await expect(park.fetchCalendar()).rejects.toThrow(/400/); // seeds the cache, then drops it
    CacheLib.set(`TokyoDisneyResort:getAppwatchVersion:["${PACKAGE}","3.0.16"]`, '3.12.4', 60);

    const maintenance = {
      response: new Response('{}', {status: 503}),
      clone: () => ({json: async () => ({errors: [{code: 'error.systemMaintenance'}]})}),
    };

    await expect(park.handleAPIError(maintenance as any)).resolves.toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('system maintenance'));
    expect(CacheLib.has(`TokyoDisneyResort:getAppwatchVersion:["${PACKAGE}","3.0.16"]`)).toBe(true);
  });
});
