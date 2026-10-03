/**
 * When a response body is read for the trace.
 *
 * Three places attach a body to a trace event: the live response, the cache
 * hit and the error. The live response and the error clone the `Response`
 * and parse the clone, the cache hit parses its cached text. The event is
 * dropped without a trace context, so that work is skipped there. The reads
 * are counted on the clones of the `Response` a transport hands back, which
 * leaves out the caller's own read, and the parse of a cache hit is counted
 * as a `JSON.parse` call that receives the cached text. All of it runs
 * against a loopback server, see helpers/localHttpServer.ts.
 */
import {setHttpTransport} from '../httpProxy.js';
import {http, HTTPObj, stopHttpQueue} from '../http.js';
import {tracing} from '../tracing.js';
import {startLocalServer, LocalServer} from './helpers/localHttpServer.js';

const POSTS = [
  {id: 1, userId: 1, title: 'first'},
  {id: 2, userId: 2, title: 'second'},
];

class BodyClient {
  constructor(private readonly baseURL: string) {}

  @http({cacheSeconds: 0})
  async fetchPosts(): Promise<HTTPObj> {
    return {method: 'GET', url: `${this.baseURL}/posts`, tags: ['posts']} as HTTPObj;
  }

  @http({cacheSeconds: 60})
  async fetchCachedPosts(): Promise<HTTPObj> {
    return {method: 'GET', url: `${this.baseURL}/posts`, queryParams: {cached: '1'}, tags: ['posts']} as any as HTTPObj;
  }

  @http({cacheSeconds: 0})
  async fetchError(): Promise<HTTPObj> {
    return {method: 'GET', url: `${this.baseURL}/text/error`, tags: ['text']} as HTTPObj;
  }
}

/** Record every body read of a clone of `response` in `reads`. */
function countCloneReads(response: Response, reads: string[]): Response {
  const clone = response.clone.bind(response);
  response.clone = () => {
    const copy = clone();
    for (const method of ['json', 'text', 'blob', 'arrayBuffer'] as const) {
      const read = copy[method].bind(copy);
      copy[method] = () => {
        reads.push(method);
        return read();
      };
    }
    return copy;
  };
  return response;
}

describe('trace event bodies', () => {
  let server: LocalServer;
  let reads: string[];

  beforeAll(async () => {
    server = await startLocalServer();
  });

  afterAll(async () => {
    stopHttpQueue();
    await server.close();
  });

  beforeEach(() => {
    reads = [];
    setHttpTransport(async (request, _caller, send) => countCloneReads(await send(request), reads));
  });

  afterEach(() => {
    setHttpTransport(null);
  });

  it('reads no body for a live response without a trace context', async () => {
    const client = new BodyClient(server.baseURL);
    const result = await (await client.fetchPosts()).json();

    expect(result).toEqual(POSTS);
    expect(reads).toEqual([]);
  });

  it('reads the body of a live response once inside a trace context', async () => {
    const client = new BodyClient(server.baseURL);
    const {events} = await tracing.trace(async () => (await client.fetchPosts()).json());

    expect(reads).toEqual(['json']);
    const complete = events.filter(e => e.eventType === 'http.request.complete');
    expect(complete).toHaveLength(1);
    expect(complete[0].body).toEqual(POSTS);
  });

  it('reads a failed response only for its error message without a trace context', async () => {
    const client = new BodyClient(server.baseURL);
    await expect(client.fetchError()).rejects.toThrow('HTTP request not OK: 500');

    // The one read is the snippet in the error message, not the trace body.
    expect(reads).toEqual(['text']);
  });

  it('reads a failed response a second time for the trace inside a trace context', async () => {
    const client = new BodyClient(server.baseURL);
    const {events} = await tracing.trace(async () => {
      await expect(client.fetchError()).rejects.toThrow('HTTP request not OK: 500');
    });

    expect(reads).toEqual(['text', 'text']);
    const errors = events.filter(e => e.eventType === 'http.request.error');
    expect(errors).toHaveLength(1);
    expect(errors[0].status).toBe(500);
    expect(typeof errors[0].body).toBe('string');
  });

  it('parses a cached body only inside a trace context', async () => {
    const client = new BodyClient(server.baseURL);
    const body = await (await client.fetchCachedPosts()).text();
    expect(JSON.parse(body)).toEqual(POSTS);

    const parse = vi.spyOn(JSON, 'parse');
    try {
      const bodyParses = () => parse.mock.calls.filter(([text]) => text === body).length;

      expect(await (await client.fetchCachedPosts()).text()).toBe(body);
      expect(bodyParses()).toBe(0);

      const {events} = await tracing.trace(async () => (await client.fetchCachedPosts()).text());
      expect(bodyParses()).toBe(1);
      const hits = events.filter(e => e.eventType === 'http.request.complete' && e.cacheHit);
      expect(hits).toHaveLength(1);
      expect(hits[0].body).toEqual(POSTS);
    } finally {
      parse.mockRestore();
    }
    // The one read filled the cache on the first call, nothing was read for the trace.
    expect(reads).toEqual(['text']);
  });
});
