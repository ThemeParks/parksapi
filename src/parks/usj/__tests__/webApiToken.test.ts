import {describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi} from 'vitest';
import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import crypto from 'node:crypto';
import {
  UniversalStudiosJapan,
  signWebApiRequest,
  webApiTokenTtlSeconds,
} from '../universalstudiosjapan.js';
import {CacheLib} from '../../../cache.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// The venue-hours endpoint needs an X-UNIWebService-Token. That token is a
// session token minted by POST {webApiBase}?city=USJ and it expires within
// hours. It used to be configured as a static value, so schedules went stale
// the day it expired, and buildSchedules() swallowed the 401s and returned an
// empty calendar. These tests pin the minting, the 401 recovery, and the loud
// failure.

describe('signWebApiRequest', () => {
  // Fixed vector with a dummy secret. The expected value is a literal computed
  // once, not recomputed here, so a change to the message layout or encoding
  // fails this test.
  test('HMAC-SHA256 over "key\\ndate\\n", base64', () => {
    expect(signWebApiRequest(
      'test-secret-not-real',
      'test-api-key',
      'Wed, 13 May 2026 07:40:39 GMT',
    )).toBe('IJEYbFu4SHbtKlfLNL0Vobh8mgdvkVyMUDAg4YLGS/8=');
  });

  // Real vector from an observed app request. Needs the real key and secret,
  // which stay out of the repo, so this only runs where they are configured:
  //   node --env-file=.env ./node_modules/.bin/vitest run src/parks/usj
  const realKey = process.env.UNIVERSALSTUDIOSJAPAN_WEBAPIKEY;
  const realSecret = process.env.UNIVERSALSTUDIOSJAPAN_WEBAPISECRET;
  test.skipIf(!realKey || !realSecret)('matches a signature observed from the app', () => {
    expect(signWebApiRequest(
      realSecret!,
      realKey!,
      'Wed, 13 May 2026 07:40:39 GMT',
    )).toBe('j2dDTRe+tPx03B6Lc6s6fH996teVDlbHu8N3ziVTTp8=');
  });
});

describe('webApiTokenTtlSeconds', () => {
  const now = Date.UTC(2026, 8, 27, 12, 0, 0);
  const nowS = now / 1000;

  test('expires 5 minutes before the server expiry', () => {
    expect(webApiTokenTtlSeconds(nowS + 10 * 3600, now)).toBe(10 * 3600 - 300);
  });

  test('accepts the expiry as a numeric string', () => {
    expect(webApiTokenTtlSeconds(String(nowS + 3600), now)).toBe(3600 - 300);
  });

  test('never shorter than 5 minutes, even for an already-expired token', () => {
    expect(webApiTokenTtlSeconds(nowS + 60, now)).toBe(300);
    expect(webApiTokenTtlSeconds(nowS - 3600, now)).toBe(300);
  });

  test('missing or junk expiry falls back to 1 hour', () => {
    expect(webApiTokenTtlSeconds(undefined, now)).toBe(3600);
    expect(webApiTokenTtlSeconds('', now)).toBe(3600);
    expect(webApiTokenTtlSeconds('soon', now)).toBe(3600);
  });
});

// ─── End to end against a loopback stand-in for the mobile-service API ──────

const SECRET = 'test-secret-not-real';
const API_KEY = 'test-api-key';

type MockState = {
  issued: string[];
  valid: Set<string>;
  hoursTokens: string[];
  tokenRequests: Array<{date?: string; apiKeyHeader?: string; body: any}>;
  /** How the token endpoint answers a correctly signed request */
  mintMode: 'ok' | 'error' | 'noToken';
  /** How the Hours endpoint answers a request with a valid token */
  hoursMode: 'ok' | 'error';
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

function send(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(payload));
}

function startMockWebApi(state: MockState): Promise<{server: Server; base: string}> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'POST' && url.pathname === '/api' && url.searchParams.get('city') === 'USJ') {
      const body = JSON.parse(await readBody(req) || '{}');
      const date = req.headers['date'] as string | undefined;
      state.tokenRequests.push({date, apiKeyHeader: req.headers['x-uniwebservice-apikey'] as string, body});
      // Server-side check, as upstream does it: the signature must be over the Date header actually sent
      const expected = date
        ? crypto.createHmac('sha256', SECRET).update(`${body.apiKey}\n${date}\n`).digest('base64')
        : '';
      if (body.apiKey !== API_KEY || body.signature !== expected) {
        return send(res, 401, {Message: 'bad signature'});
      }
      if (state.mintMode === 'error') return send(res, 503, {Message: 'unavailable'});
      if (state.mintMode === 'noToken') return send(res, 200, {});
      const token = `tok-${state.issued.length + 1}`;
      state.issued.push(token);
      state.valid.add(token);
      return send(res, 200, {Token: token, TokenExpirationUnix: Math.floor(Date.now() / 1000) + 10 * 3600});
    }

    const hours = url.pathname.match(/^\/api\/Venues\/10251\/Hours$/);
    if (req.method === 'GET' && hours) {
      const token = req.headers['x-uniwebservice-token'] as string | undefined;
      state.hoursTokens.push(token ?? '');
      if (!token || !state.valid.has(token) || req.headers['x-uniwebservice-apikey'] !== API_KEY) {
        return send(res, 401, {Message: 'Authorization has been denied for this request.'});
      }
      if (state.hoursMode === 'error') return send(res, 404, {Message: 'not found'});
      // One day per month requested, keyed on the endDate so each month is distinct
      const [mm, , yyyy] = (url.searchParams.get('endDate') || '').split('/');
      return send(res, 200, [{
        Date: `${yyyy}-${mm}-01T00:00:00`,
        OpenTimeString: `${yyyy}-${mm}-01T09:00:00+09:00`,
        CloseTimeString: `${yyyy}-${mm}-01T21:00:00+09:00`,
      }]);
    }

    send(res, 404, {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address() as AddressInfo;
      resolve({server, base: `http://127.0.0.1:${port}/api`});
    });
  });
}

class ScheduleProbe extends UniversalStudiosJapan {
  schedules() {
    return this.buildSchedules();
  }
}

describe('USJ schedules mint their own session token', () => {
  let server: Server;
  let base: string;
  let state: MockState;

  beforeAll(async () => {
    state = {issued: [], valid: new Set(), hoursTokens: [], tokenRequests: [], mintMode: 'ok', hoursMode: 'ok'};
    ({server, base} = await startMockWebApi(state));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(async () => {
    state.issued.length = 0;
    state.valid.clear();
    state.hoursTokens.length = 0;
    state.tokenRequests.length = 0;
    state.mintMode = 'ok';
    state.hoursMode = 'ok';
    await CacheLib.clearAll();
  });

  // Mirrors the @cache key on getWebApiToken (universalstudiosjapan.ts)
  const tokenKey = (park: UniversalStudiosJapan) => `${park.constructor.name}:webApiToken`;

  const probe = () => new ScheduleProbe({config: {
    webApiBase: base,
    webApiKey: API_KEY,
    webApiSecret: SECRET,
  }});

  test('mints a signed token, sends it on every Hours request, and reuses it', async () => {
    const park = probe();
    const [entry] = await park.schedules();

    expect(state.tokenRequests).toHaveLength(1);
    const tr = state.tokenRequests[0];
    expect(tr.apiKeyHeader).toBe(API_KEY);
    expect(tr.date).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);

    expect(state.hoursTokens).toEqual(['tok-1', 'tok-1', 'tok-1']);
    expect(entry.schedule).toHaveLength(3);
    expect(entry.schedule.every((s) => s.type === 'OPERATING')).toBe(true);
  });

  test('a token revoked early is dropped on its first 401 and the run recovers', async () => {
    const park = probe();
    // First run caches tok-1
    await park.schedules();
    // Upstream revokes it before its advertised expiry. Clear the Hours response
    // cache (keeping the token) so the next run re-fetches every month.
    state.valid.clear();
    await CacheLib.clearAll();
    await CacheLib.set(tokenKey(park), {token: 'tok-1', expiresIn: 36000}, 36000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const [entry] = await park.schedules();

    // Month 1 401s with the revoked token; the httpError handler runs before the
    // request rejects (http.ts awaits it), so month 2 already mints tok-2.
    expect(state.hoursTokens.slice(-3)).toEqual(['tok-1', 'tok-2', 'tok-2']);
    expect(state.issued).toEqual(['tok-1', 'tok-2']);
    expect(entry.schedule).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/some venue-hours months failed.*401/));
    expect(await CacheLib.get(tokenKey(park))).toMatchObject({token: 'tok-2'});
  });

  test('the token is cached until 5 minutes before the server expiry', async () => {
    const park = probe();
    const before = Date.now();
    await park.schedules();
    const entry = CacheLib.getAllEntries().find((e) => e.key === tokenKey(park));
    expect(entry).toBeDefined();
    // Mock issues TokenExpirationUnix = now + 10h; cached for 10h - 5min
    const expected = before + (10 * 3600 - 300) * 1000;
    expect(Math.abs(entry!.expiresAt - expected)).toBeLessThan(5_000);
  });

  test('cached Hours responses are served without minting, so a token outage cannot fail them', async () => {
    const park = probe();
    await park.schedules();
    expect(state.tokenRequests).toHaveLength(1);

    // Token gone and the mint endpoint down; Hours bodies are still cached
    CacheLib.delete(tokenKey(park));
    state.mintMode = 'error';

    const [entry] = await park.schedules();
    expect(entry.schedule).toHaveLength(3);
    expect(state.tokenRequests).toHaveLength(1);
    expect(state.hoursTokens).toHaveLength(3);
  });

  test('a token response without a Token is an error', async () => {
    state.mintMode = 'noToken';
    await expect(probe().schedules()).rejects.toThrow(/has no Token/);
  });

  test('a non-401 Hours error keeps the cached token', async () => {
    state.hoursMode = 'error';
    const park = probe();
    await expect(park.schedules()).rejects.toThrow(/every venue-hours request failed.*404/);
    expect(CacheLib.get(tokenKey(park))).toMatchObject({token: 'tok-1'});
    expect(state.issued).toEqual(['tok-1']);
  });

  test('a rejected signature surfaces as an error, not an empty schedule', async () => {
    const park = new ScheduleProbe({config: {
      webApiBase: base,
      webApiKey: API_KEY,
      webApiSecret: 'wrong-secret',
    }});
    await expect(park.schedules()).rejects.toThrow(/every venue-hours request failed.*city=USJ.*401/);
    expect(state.hoursTokens).toEqual([]);
  });
});

describe('USJ buildSchedules failure handling', () => {
  class StubbedProbe extends UniversalStudiosJapan {
    constructor(private readonly months: Array<'ok' | 'throw' | 'junk'>) {
      super({config: {webApiBase: 'https://example.invalid/api', webApiKey: 'k', webApiSecret: 's'}});
    }
    private call = 0;
    override async fetchVenueHoursForMonth(endDate: string): Promise<any> {
      const mode = this.months[this.call++];
      if (mode === 'throw') throw new Error('HTTP 401');
      const [mm, , yyyy] = endDate.split('/');
      return {json: async () => mode === 'junk'
        ? {Message: 'Authorization has been denied'}
        : [{Date: `${yyyy}-${mm}-01`, OpenTimeString: '09:00', CloseTimeString: '21:00'}]};
    }
    schedules() {
      return this.buildSchedules();
    }
  }

  test('every month failing throws', async () => {
    await expect(new StubbedProbe(['throw', 'throw', 'throw']).schedules())
      .rejects.toThrow(/every venue-hours request failed/);
  });

  test('a non-array body counts as a failed month', async () => {
    await expect(new StubbedProbe(['junk', 'throw', 'junk']).schedules())
      .rejects.toThrow(/response is not an array/);
  });

  test('one bad month keeps the others and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [entry] = await new StubbedProbe(['ok', 'throw', 'ok']).schedules();
    expect(entry.schedule).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/some venue-hours months failed/));
  });

  test('overlapping ranges are deduplicated (each request returns today..endDate)', async () => {
    const day = (d: string, close = '21:00') => ({Date: d, OpenTimeString: '09:00', CloseTimeString: close});
    const responses = [
      [day('2026-09-29'), day('2026-09-30')],
      [day('2026-09-29'), day('2026-09-30'), day('2026-10-01')],
      // A second window on an existing date is a different entry, not a duplicate
      [day('2026-09-29'), day('2026-09-30'), day('2026-10-01'), day('2026-10-01', '23:00')],
    ];
    const park = new (class extends UniversalStudiosJapan {
      private call = 0;
      override async fetchVenueHoursForMonth(): Promise<any> {
        const body = responses[this.call++];
        return {json: async () => body};
      }
      schedules() {
        return this.buildSchedules();
      }
    })({config: {webApiBase: 'https://example.invalid/api', webApiKey: 'k', webApiSecret: 's'}});
    const [entry] = await park.schedules();
    expect(entry.schedule.map((s) => `${s.date} ${s.closingTime}`)).toEqual([
      '2026-09-29 21:00',
      '2026-09-30 21:00',
      '2026-10-01 21:00',
      '2026-10-01 23:00',
    ]);
  });

  test('missing config throws instead of returning an empty calendar', async () => {
    const park = new (class extends UniversalStudiosJapan {
      schedules() {
        return this.buildSchedules();
      }
    })({config: {webApiBase: 'https://example.invalid/api', webApiKey: 'k', webApiSecret: ''}});
    await expect(park.schedules()).rejects.toThrow(/must be configured/);
  });
});
