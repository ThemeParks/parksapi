/**
 * The web admin server runs destination code and shows request traces, so it
 * must only answer the machine it runs on and the pages that machine opened.
 *
 * The pure helpers are exercised directly, then the guard middleware is run
 * against a real express app on the loopback interface, sending hand-written
 * Host and Origin headers (a browser will not let a page choose its own Host).
 */
import express from 'express';
import http from 'node:http';
import net from 'node:net';
import type {AddressInfo} from 'node:net';
import {
  allowedHostnames,
  hostnameOf,
  resolveBindHost,
  webAdminGuard,
} from '../webServerSecurity.js';

describe('resolveBindHost', () => {
  test('defaults to the IPv4 loopback address', () => {
    expect(resolveBindHost({})).toBe('127.0.0.1');
  });

  test('ignores an empty or blank WEB_ADMIN_HOST', () => {
    expect(resolveBindHost({WEB_ADMIN_HOST: ''})).toBe('127.0.0.1');
    expect(resolveBindHost({WEB_ADMIN_HOST: '   '})).toBe('127.0.0.1');
  });

  test('WEB_ADMIN_HOST opts in to another interface', () => {
    expect(resolveBindHost({WEB_ADMIN_HOST: ' 0.0.0.0 '})).toBe('0.0.0.0');
  });
});

describe('hostnameOf', () => {
  test.each([
    ['localhost:8888', 'localhost'],
    ['LOCALHOST', 'localhost'],
    ['127.0.0.1:3000', '127.0.0.1'],
    ['[::1]:8888', '::1'],
    ['[::1]', '::1'],
    ['dev-box.lan:8888', 'dev-box.lan'],
  ])('%s -> %s', (header, expected) => {
    expect(hostnameOf(header)).toBe(expected);
  });

  test('a full origin is reduced to its hostname', () => {
    expect(hostnameOf('http://localhost:3000')).toBe('localhost');
    expect(hostnameOf('https://Example.com')).toBe('example.com');
  });

  test.each([undefined, '', 'null', 'http://', '::::'])('%j is not a hostname', (value) => {
    expect(hostnameOf(value)).toBeUndefined();
  });
});

describe('allowedHostnames', () => {
  test('loopback names are always allowed', () => {
    const allowed = allowedHostnames({});
    expect([...allowed].sort()).toEqual(['127.0.0.1', '::1', 'localhost']);
  });

  test('WEB_ADMIN_ALLOWED_HOSTS adds names, trimmed and lowercased', () => {
    const allowed = allowedHostnames({WEB_ADMIN_ALLOWED_HOSTS: ' Dev-Box.lan, ,10.0.0.5 '});
    expect(allowed.has('dev-box.lan')).toBe(true);
    expect(allowed.has('10.0.0.5')).toBe(true);
    expect(allowed.has('')).toBe(false);
  });
});

describe('webAdminGuard', () => {
  let server: http.Server;
  let port: number;

  function start(env: NodeJS.ProcessEnv): Promise<void> {
    const app = express();
    app.use(webAdminGuard(env));
    app.get('/api', (_req, res) => {
      res.json({ok: true});
    });
    app.post('/api/destinations/x/execute/getEntities', (_req, res) => {
      res.json({ran: true});
    });
    return new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  function request(
    method: string,
    path: string,
    headers: Record<string, string>,
  ): Promise<{status: number; headers: http.IncomingHttpHeaders; body: string}> {
    return new Promise((resolve, reject) => {
      const req = http.request({host: '127.0.0.1', port, method, path, headers}, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({status: res.statusCode ?? 0, headers: res.headers, body}));
      });
      req.on('error', reject);
      req.end();
    });
  }

  test('a loopback Host with no Origin is served (curl, same-origin pages)', async () => {
    await start({});
    const res = await request('GET', '/api', {Host: `localhost:${port}`});
    expect(res.status).toBe(200);
  });

  test('a foreign Host is refused, which stops DNS rebinding', async () => {
    await start({});
    const res = await request('GET', '/api', {Host: 'attacker.example:8888'});
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('ok');
  });

  test('a missing Host header is refused', async () => {
    await start({});
    // http.request fills in a default Host, so write an HTTP/1.0 request by hand.
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write('GET /api HTTP/1.0\r\n\r\n'));
      let data = '';
      socket.on('data', (chunk) => (data += chunk));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    expect(raw.split('\r\n')[0]).toContain('403');
    expect(raw).not.toContain('"ok"');
  });

  test('a cross-site POST is refused and the handler never runs', async () => {
    await start({});
    const res = await request('POST', '/api/destinations/x/execute/getEntities', {
      Host: `localhost:${port}`,
      Origin: 'https://attacker.example',
      'Content-Type': 'text/plain',
    });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('ran');
  });

  test('an opaque Origin ("null") is refused', async () => {
    await start({});
    const res = await request('GET', '/api', {Host: `localhost:${port}`, Origin: 'null'});
    expect(res.status).toBe(403);
  });

  test('the dev UI on a loopback origin is served and gets CORS headers', async () => {
    await start({});
    const res = await request('GET', '/api', {
      Host: `localhost:${port}`,
      Origin: 'http://localhost:3000',
    });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  test('a listed LAN name is allowed as Host and as Origin', async () => {
    await start({WEB_ADMIN_ALLOWED_HOSTS: 'dev-box.lan'});
    const res = await request('GET', '/api', {
      Host: 'dev-box.lan:8888',
      Origin: 'http://dev-box.lan:3000',
    });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://dev-box.lan:3000');
  });

  test('an unlisted origin gets no CORS header even from a loopback Host', async () => {
    await start({});
    const res = await request('GET', '/api', {
      Host: `localhost:${port}`,
      Origin: 'https://attacker.example',
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('a preflight from a foreign origin is refused', async () => {
    await start({});
    const res = await request('OPTIONS', '/api/destinations/x/execute/getEntities', {
      Host: `localhost:${port}`,
      Origin: 'https://attacker.example',
      'Access-Control-Request-Method': 'POST',
    });
    expect(res.status).toBe(403);
  });
});
