/**
 * A request that fails at the network layer (no response at all) rejects with
 * the underlying error kept as `cause`. Node's fetch reports every such failure
 * as `TypeError: fetch failed`; the reason (refused, reset, DNS, connect
 * timeout) is only on its `cause`. Callers that classify failures need it, so
 * the final rejection must not drop it. The message is unchanged.
 */
import {createServer} from 'node:net';
import {http, HTTPObj, stopHttpQueue} from '../http.js';

/** A loopback port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as {port: number}).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

class RefusedClient {
  constructor(private readonly baseURL: string) {}

  @http({cacheSeconds: 0, retries: 0})
  async fetchOnce(): Promise<HTTPObj> {
    return {method: 'GET', url: `${this.baseURL}/x`, tags: ['refused']} as HTTPObj;
  }

  @http({cacheSeconds: 0, retries: 1})
  async fetchRetried(): Promise<HTTPObj> {
    return {method: 'GET', url: `${this.baseURL}/x`, tags: ['refused']} as HTTPObj;
  }
}

/** Walks `cause` and collects every `code` on the way. */
function codes(err: unknown): string[] {
  const out: string[] = [];
  for (let e: any = err, i = 0; e && i < 6; e = e.cause, i++) {
    if (typeof e.code === 'string') out.push(e.code);
  }
  return out;
}

afterAll(() => stopHttpQueue());

describe('network failure keeps its cause', () => {
  it('a refused connection rejects with the fetch error as cause, message unchanged', async () => {
    const port = await closedPort();
    const client = new RefusedClient(`http://127.0.0.1:${port}`);
    const err: any = await client.fetchOnce().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(`GET http://127.0.0.1:${port}/x: fetch failed`);
    expect(err.cause).toBeInstanceOf(TypeError);
    expect(codes(err)).toContain('ECONNREFUSED');
  });

  it('keeps the last attempt\'s cause after retries run out', async () => {
    const port = await closedPort();
    const client = new RefusedClient(`http://127.0.0.1:${port}`);
    const err: any = await client.fetchRetried().then(() => null, (e) => e);
    expect(codes(err)).toContain('ECONNREFUSED');
  }, 15000);
});
