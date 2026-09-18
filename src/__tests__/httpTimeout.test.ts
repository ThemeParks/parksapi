/**
 * How long a request may take before it is aborted.
 *
 * `makeHttpRequest` aborts after 30 seconds unless the caller passes
 * `timeoutMs`. `HTTP_TIMEOUT_MS` moves that default for the whole process,
 * for a consumer that polls every minute and cannot afford 30 seconds per
 * hung request. The value is read once directly, then through
 * `makeHttpRequest` and through the `@http` queue against a loopback server
 * whose `/hang` route never answers, see helpers/localHttpServer.ts.
 */
import {httpTimeoutMs, makeHttpRequest} from '../httpProxy';
import {http, HTTPObj, stopHttpQueue} from '../http';
import {startLocalServer, LocalServer} from './helpers/localHttpServer';

const ENV = 'HTTP_TIMEOUT_MS';

function saveEnv(): () => void {
  const saved = process.env[ENV];
  delete process.env[ENV];
  return () => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  };
}

describe('httpTimeoutMs', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = saveEnv();
  });

  afterEach(() => {
    restore();
  });

  it('defaults to 30 seconds', () => {
    expect(httpTimeoutMs()).toBe(30000);
  });

  it('reads a positive whole number of milliseconds', () => {
    process.env[ENV] = '10000';
    expect(httpTimeoutMs()).toBe(10000);
  });

  it('falls back to the default on anything else', () => {
    for (const value of ['', '0', '-1', 'abc', '1.5', 'Infinity']) {
      process.env[ENV] = value;
      expect(httpTimeoutMs(), `value "${value}"`).toBe(30000);
    }
  });
});

describe('the timeout on a request', () => {
  let server: LocalServer;
  let restore: () => void;

  class HangingClient {
    constructor(private readonly baseURL: string) {}

    @http({cacheSeconds: 0})
    async fetchHang(): Promise<HTTPObj> {
      return {method: 'GET', url: `${this.baseURL}/hang`} as HTTPObj;
    }
  }

  beforeAll(async () => {
    server = await startLocalServer();
  });

  afterAll(async () => {
    stopHttpQueue();
    await server.close();
  });

  beforeEach(() => {
    restore = saveEnv();
  });

  afterEach(() => {
    restore();
  });

  it('aborts after HTTP_TIMEOUT_MS', async () => {
    process.env[ENV] = '200';
    const started = Date.now();
    await expect(makeHttpRequest({method: 'GET', url: `${server.baseURL}/hang`}))
      .rejects.toThrow(`HTTP request timed out after 200ms: GET ${server.baseURL}/hang`);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('lets an explicit timeoutMs win over the environment', async () => {
    process.env[ENV] = '60000';
    await expect(makeHttpRequest({method: 'GET', url: `${server.baseURL}/hang`, timeoutMs: 200}))
      .rejects.toThrow('HTTP request timed out after 200ms');
  });

  it('still answers a request that finishes inside the limit', async () => {
    process.env[ENV] = '5000';
    const response = await makeHttpRequest({method: 'GET', url: `${server.baseURL}/users`});
    expect(response.status).toBe(200);
  });

  it('reaches a request made through @http', async () => {
    process.env[ENV] = '200';
    const client = new HangingClient(server.baseURL);
    await expect(client.fetchHang()).rejects.toThrow('HTTP request timed out after 200ms');
  });
});
