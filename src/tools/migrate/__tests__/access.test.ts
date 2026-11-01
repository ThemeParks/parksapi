/**
 * The migration review server can rewrite entity ids with the operator's wiki
 * credential, and it listens on every interface so it can be reviewed from
 * another machine. Three things keep strangers out:
 *
 *  - a Host and Origin check (DNS rebinding and cross-site posts),
 *  - a per-run token, handed over once in the printed URL and kept in a
 *    SameSite=Strict cookie (a direct client on the network),
 *  - nothing reaches a handler before both.
 *
 * The helpers are exercised directly, then the real app is run on loopback
 * with hand-written Host, Origin and Cookie headers.
 */
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {accessUrl, migrateHostnames, newAccessToken} from '../access.js';
import {createMigrationApp} from '../server.js';
import type {Mapping} from '../matcher.js';

describe('newAccessToken', () => {
  test('is long, hex, and different every run', () => {
    const a = newAccessToken();
    const b = newAccessToken();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });
});

describe('migrateHostnames', () => {
  test('loopback, the machine name and MIGRATE_HOST are allowed', () => {
    const allowed = migrateHostnames({MIGRATE_HOST: 'Review-Box.lan'}, 'My-Machine');
    for (const name of ['localhost', '127.0.0.1', '::1', 'my-machine', 'review-box.lan']) {
      expect(allowed.has(name)).toBe(true);
    }
  });

  test('a bracketed IPv6 MIGRATE_HOST is stored without brackets', () => {
    expect(migrateHostnames({MIGRATE_HOST: '[fe80::1]'}, 'box').has('fe80::1')).toBe(true);
  });

  test('MIGRATE_ALLOWED_HOSTS adds names, trimmed and lowercased', () => {
    const allowed = migrateHostnames({MIGRATE_ALLOWED_HOSTS: ' 10.0.0.5, Coder.LAN ,'}, 'box');
    expect(allowed.has('10.0.0.5')).toBe(true);
    expect(allowed.has('coder.lan')).toBe(true);
    expect(allowed.has('')).toBe(false);
  });

  test('an unrelated name is not allowed', () => {
    expect(migrateHostnames({}, 'box').has('attacker.example')).toBe(false);
  });
});

describe('accessUrl', () => {
  test('carries the token', () => {
    expect(accessUrl('review-box', 9900, 'abc')).toBe('http://review-box:9900/?token=abc');
  });

  test('brackets a bare IPv6 host', () => {
    expect(accessUrl('fe80::1', 9900, 'abc')).toBe('http://[fe80::1]:9900/?token=abc');
  });

  test('leaves an already bracketed IPv6 host alone', () => {
    expect(accessUrl('[::1]', 9900, 'abc')).toBe('http://[::1]:9900/?token=abc');
  });
});

const MAPPING: Mapping = {
  wikiId: 'wiki-1',
  oldExternalId: 'old-1',
  oldName: 'Old Ride',
  entityType: 'ATTRACTION',
  newExternalId: null,
  newName: null,
  confidence: 'unmatched',
  confidenceScore: 0,
  distance: null,
  status: 'skip',
};

describe('createMigrationApp access control', () => {
  const TOKEN = 'a'.repeat(48);
  const COOKIE = `migrate_token=${TOKEN}`;
  let server: http.Server;
  let port: number;
  let mappings: Mapping[];

  beforeEach(async () => {
    mappings = [{...MAPPING}];
    const app = createMigrationApp(
      {
        mappings,
        unmatchedNew: [],
        allNewEntities: [],
        parkName: 'Test Park',
        // No wiki settings: an authorised POST /api/commit stops at a 400
        // before any network call, which shows the handler was reached.
        wikiApiUrl: '',
        wikiUsername: '',
        wikiApiKey: '',
        wikiToken: '',
        port: 0,
      },
      {token: TOKEN, allowed: migrateHostnames({}, 'review-box')},
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function request(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: string,
  ): Promise<{status: number; headers: http.IncomingHttpHeaders; body: string}> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {host: '127.0.0.1', port, method, path, headers: {Host: `localhost:${port}`, ...headers}},
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({status: res.statusCode ?? 0, headers: res.headers, body: text}));
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  const json = {'Content-Type': 'application/json'};

  test('no token: the page and the API answer 401', async () => {
    expect((await request('GET', '/')).status).toBe(401);
    expect((await request('GET', '/api/mappings')).status).toBe(401);
    expect((await request('GET', '/api/commit/status')).status).toBe(401);
  });

  test('no token: a pairing change is refused and does not apply', async () => {
    const res = await request(
      'POST',
      '/api/mappings/0',
      json,
      JSON.stringify({action: 'pair', newExternalId: 'attacker-id'}),
    );
    expect(res.status).toBe(401);
    expect(mappings[0].newExternalId).toBeNull();
  });

  test('no token: the commit never reaches its handler', async () => {
    const res = await request('POST', '/api/commit');
    expect(res.status).toBe(401);
    expect(res.body).not.toContain('WIKI_API_URL');
  });

  test('a wrong token in the query does not open the door', async () => {
    const res = await request('GET', `/?token=${'b'.repeat(48)}`);
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('a wrong cookie is refused', async () => {
    const res = await request('GET', '/api/mappings', {Cookie: `migrate_token=${'b'.repeat(48)}`});
    expect(res.status).toBe(401);
  });

  test('the 401 explains where to get the token without printing it', async () => {
    const res = await request('GET', '/');
    expect(res.body).toContain('?token=');
    expect(res.body).not.toContain(TOKEN);
  });

  test('the token in the URL sets a strict HttpOnly cookie and redirects to a clean URL', async () => {
    const res = await request('GET', `/?token=${TOKEN}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain(`migrate_token=${TOKEN}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  test('the cookie opens the page and the API', async () => {
    expect((await request('GET', '/', {Cookie: COOKIE})).status).toBe(200);
    const res = await request('GET', '/api/mappings', {Cookie: COOKIE});
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).parkName).toBe('Test Park');
  });

  test('with the cookie, a pairing change applies and the commit handler is reached', async () => {
    const pair = await request(
      'POST',
      '/api/mappings/0',
      {...json, Cookie: COOKIE},
      JSON.stringify({action: 'pair', newExternalId: 'new-1', newName: 'New Ride'}),
    );
    expect(pair.status).toBe(200);
    expect(mappings[0].newExternalId).toBe('new-1');

    const commit = await request('POST', '/api/commit', {Cookie: COOKIE});
    expect(commit.status).toBe(400);
    expect(commit.body).toContain('WIKI_API_URL');
  });

  test('a foreign Host is refused even with the right cookie (DNS rebinding)', async () => {
    const res = await request('GET', '/api/mappings', {Host: 'attacker.example:9900', Cookie: COOKIE});
    expect(res.status).toBe(403);
  });

  test('a foreign Origin is refused even with the right cookie', async () => {
    const res = await request('POST', '/api/commit', {
      Origin: 'https://attacker.example',
      Cookie: COOKIE,
    });
    expect(res.status).toBe(403);
  });

  test('the machine name the tool prints is accepted as Host', async () => {
    const res = await request('GET', '/api/mappings', {Host: 'review-box:9900', Cookie: COOKIE});
    expect(res.status).toBe(200);
  });

  test('the 403 for a foreign Host says how to allow a name', async () => {
    const res = await request('GET', '/', {Host: '192.168.1.50:9900'});
    expect(res.status).toBe(403);
    expect(res.body).toContain('MIGRATE_ALLOWED_HOSTS');
  });

  test('the review server sends no CORS headers: the page is same-origin', async () => {
    const res = await request('GET', '/api/mappings', {
      Cookie: COOKIE,
      Origin: `http://localhost:${port}`,
    });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
