/**
 * What a trace event carries of a text response body.
 *
 * JSON bodies are attached whole. A text body (an HTML calendar, XML, CSV) is
 * cut at HTTP_TRACE_TEXT_LIMIT characters, 1000 by default, and `0` lifts the
 * cut for a consumer that archives raw responses. Three places attach a body,
 * the live response, the cache hit and the error, and all go through
 * `truncateTraceText`. The limit is exercised once directly and once through
 * each of the three paths against a loopback server, see
 * helpers/localHttpServer.ts.
 */
import {http, HTTPObj, stopHttpQueue, truncateTraceText} from '../http';
import {tracing, HttpTraceEvent} from '../tracing';
import {startLocalServer, LocalServer, LONG_TEXT} from './helpers/localHttpServer';

const ENV = 'HTTP_TRACE_TEXT_LIMIT';
const CUT = LONG_TEXT.substring(0, 1000) + '...';

describe('truncateTraceText', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV];
    delete process.env[ENV];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it('keeps a body at the default limit whole', () => {
    const text = 'a'.repeat(1000);
    expect(truncateTraceText(text)).toBe(text);
  });

  it('cuts a longer body at 1000 characters and marks the cut', () => {
    expect(truncateTraceText('a'.repeat(1001))).toBe('a'.repeat(1000) + '...');
  });

  it('keeps every body whole at 0', () => {
    process.env[ENV] = '0';
    expect(LONG_TEXT.length).toBeGreaterThan(1000);
    expect(truncateTraceText(LONG_TEXT)).toBe(LONG_TEXT);
  });

  it('cuts at a custom limit', () => {
    process.env[ENV] = '50';
    expect(truncateTraceText('b'.repeat(80))).toBe('b'.repeat(50) + '...');
    expect(truncateTraceText('b'.repeat(50))).toBe('b'.repeat(50));
  });

  it('falls back to the default on a value that is not a whole number', () => {
    for (const value of ['', 'abc', '-1', '1.5', 'Infinity']) {
      process.env[ENV] = value;
      expect(truncateTraceText('c'.repeat(1001)), `value "${value}"`).toBe('c'.repeat(1000) + '...');
    }
  });
});

describe('text bodies on trace events', () => {
  let server: LocalServer;
  let saved: string | undefined;

  class TextClient {
    constructor(private readonly baseURL: string) {}

    @http({cacheSeconds: 0})
    async fetchText(): Promise<HTTPObj> {
      return {method: 'GET', url: `${this.baseURL}/text`, tags: ['text']} as HTTPObj;
    }

    @http({cacheSeconds: 60})
    async fetchCachedText(): Promise<HTTPObj> {
      return {method: 'GET', url: `${this.baseURL}/text`, queryParams: {cached: '1'}, tags: ['text']} as HTTPObj;
    }

    @http({cacheSeconds: 0})
    async fetchError(): Promise<HTTPObj> {
      return {method: 'GET', url: `${this.baseURL}/text/error`, tags: ['text']} as HTTPObj;
    }
  }

  /** The one body-carrying event of a traced call. */
  async function bodyEvent(call: () => Promise<unknown>, eventType: HttpTraceEvent['eventType']): Promise<HttpTraceEvent> {
    const {events} = await tracing.trace(async () => {
      await call().catch(() => undefined);
    });
    const matching = events.filter(e => e.eventType === eventType);
    expect(matching).toHaveLength(1);
    return matching[0];
  }

  beforeAll(async () => {
    server = await startLocalServer();
  });

  afterAll(async () => {
    stopHttpQueue();
    await server.close();
  });

  beforeEach(() => {
    saved = process.env[ENV];
    delete process.env[ENV];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it('cuts a live text response at the default limit', async () => {
    const client = new TextClient(server.baseURL);
    const event = await bodyEvent(() => client.fetchText(), 'http.request.complete');
    expect(event.cacheHit).toBe(false);
    expect(event.status).toBe(200);
    expect(event.body).toBe(CUT);
  });

  it('carries a live text response whole at 0', async () => {
    process.env[ENV] = '0';
    const client = new TextClient(server.baseURL);
    const event = await bodyEvent(() => client.fetchText(), 'http.request.complete');
    expect(event.cacheHit).toBe(false);
    expect(event.body).toBe(LONG_TEXT);
  });

  it('applies the limit in force at the time of a cache hit', async () => {
    const client = new TextClient(server.baseURL);

    // Fill the cache. The cache stores the whole text regardless of the limit.
    const miss = await bodyEvent(() => client.fetchCachedText(), 'http.request.complete');
    expect(miss.cacheHit).toBe(false);
    expect(miss.body).toBe(CUT);

    const hit = await bodyEvent(() => client.fetchCachedText(), 'http.request.complete');
    expect(hit.cacheHit).toBe(true);
    expect(hit.body).toBe(CUT);

    process.env[ENV] = '0';
    const wholeHit = await bodyEvent(() => client.fetchCachedText(), 'http.request.complete');
    expect(wholeHit.cacheHit).toBe(true);
    expect(wholeHit.body).toBe(LONG_TEXT);
  });

  it('cuts the body of a failed request at the default limit', async () => {
    const client = new TextClient(server.baseURL);
    const event = await bodyEvent(() => client.fetchError(), 'http.request.error');
    expect(event.status).toBe(500);
    expect(event.body).toBe(CUT);
  });

  it('carries the body of a failed request whole at 0', async () => {
    process.env[ENV] = '0';
    const client = new TextClient(server.baseURL);
    const event = await bodyEvent(() => client.fetchError(), 'http.request.error');
    expect(event.status).toBe(500);
    expect(event.body).toBe(LONG_TEXT);
  });
});
