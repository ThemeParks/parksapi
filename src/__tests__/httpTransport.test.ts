/**
 * The HTTP transport, set with `setHttpTransport()`.
 *
 * It sits between the `@http` queue and the network and sees every attempt
 * the queue makes: the request as it is about to go out (after the
 * injectors, with the default headers), who makes it (class, method,
 * arguments, retry count) and `send`, the network. It may call `send` or
 * answer on its own, and whatever `send` throws passes through it. A request
 * served from the HTTP cache never reaches it. Every case runs against a
 * loopback server, see helpers/localHttpServer.ts.
 */
import {makeHttpRequest, setHttpTransport, HttpCaller, HttpRequestOptions} from '../httpProxy.js';
import {http, HTTPObj, stopHttpQueue} from '../http.js';
import {inject} from '../injector.js';
import {startLocalServer, LocalServer} from './helpers/localHttpServer.js';

const POSTS = [
  {id: 1, userId: 1, title: 'first'},
  {id: 2, userId: 2, title: 'second'},
];

class TransportClient {
  constructor(private readonly baseURL: string) {}

  @http({cacheSeconds: 0})
  async fetchPosts(language: string): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.baseURL}/posts`,
      queryParams: {lang: language},
      body: {page: 1},
      options: {json: true},
      tags: ['posts'],
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 60})
  async fetchCachedUsers(): Promise<HTTPObj> {
    return {method: 'GET', url: `${this.baseURL}/users`, tags: ['users']} as HTTPObj;
  }

  @http({cacheSeconds: 0, retries: 2})
  async fetchFailing(): Promise<HTTPObj> {
    return {method: 'GET', url: `${this.baseURL}/status/500`, tags: ['failing']} as HTTPObj;
  }

  @http({cacheSeconds: 0})
  async fetchHang(): Promise<HTTPObj> {
    return {method: 'GET', url: `${this.baseURL}/hang`, tags: ['hang']} as HTTPObj;
  }
}

class InjectedClient {
  constructor(private readonly baseURL: string) {}

  @inject({eventName: 'httpRequest'})
  async addHeader(request: HTTPObj): Promise<void> {
    request.headers = {...request.headers, 'x-injected': 'yes'};
  }

  @http({cacheSeconds: 0})
  async fetchUsers(): Promise<HTTPObj> {
    return {method: 'GET', url: `${this.baseURL}/users`, tags: ['users']} as HTTPObj;
  }
}

describe('the HTTP transport', () => {
  let server: LocalServer;
  let savedUserAgent: string | undefined;

  beforeAll(async () => {
    savedUserAgent = process.env.DEFAULT_USER_AGENT;
    delete process.env.DEFAULT_USER_AGENT;
    server = await startLocalServer();
  });

  afterAll(async () => {
    if (savedUserAgent === undefined) delete process.env.DEFAULT_USER_AGENT;
    else process.env.DEFAULT_USER_AGENT = savedUserAgent;
    stopHttpQueue();
    await server.close();
  });

  afterEach(() => {
    setHttpTransport(null);
  });

  it('sees the request with query and body, and the response with status, headers and body', async () => {
    const requests: HttpRequestOptions[] = [];
    let answer: {status: number; contentType: string | null; body: unknown} | undefined;
    setHttpTransport(async (request, _caller, send) => {
      requests.push(request);
      const response = await send(request);
      answer = {
        status: response.status,
        contentType: response.headers.get('content-type'),
        body: await response.clone().json(),
      };
      return response;
    });

    const client = new TransportClient(server.baseURL);
    const result = await (await client.fetchPosts('de')).json();

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].url).toBe(`${server.baseURL}/posts?lang=de`);
    expect(requests[0].headers).toEqual({
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'user-agent': 'parksapi/2.0',
      'accept-encoding': 'gzip, deflate, br',
    });
    expect(requests[0].body).toBe('{"page":1}');
    expect(answer).toEqual({status: 200, contentType: 'application/json', body: POSTS});
    expect(result).toEqual(POSTS);
    expect(server.requests).toContain('/posts');
  });

  it('sees the headers the injectors set', async () => {
    const headers: Array<Record<string, string> | undefined> = [];
    setHttpTransport(async (request, _caller, send) => {
      headers.push(request.headers);
      return send(request);
    });

    const client = new InjectedClient(server.baseURL);
    await client.fetchUsers();

    expect(headers).toEqual([{'x-injected': 'yes', 'user-agent': 'parksapi/2.0', 'accept-encoding': 'gzip, deflate, br'}]);
  });

  it('rejects a Response whose body the transport has already read', async () => {
    setHttpTransport(async (request, _caller, send) => {
      const response = await send(request);
      await response.text();
      return response;
    });

    const client = new TransportClient(server.baseURL);
    await expect(client.fetchPosts('it')).rejects.toThrow('HTTP transport returned a Response whose body was already read');
  });

  it('answers on its own without the network', async () => {
    const before = server.requests.length;
    setHttpTransport(async () =>
      new Response('{"replayed":true}', {status: 200, headers: {'content-type': 'application/json'}}),
    );

    const client = new TransportClient(server.baseURL);
    const result = await (await client.fetchPosts('en')).json();

    expect(result).toEqual({replayed: true});
    expect(server.requests).toHaveLength(before);
  });

  it('is not called for a request served from the HTTP cache', async () => {
    let calls = 0;
    setHttpTransport(async (request, _caller, send) => {
      calls++;
      return send(request);
    });

    const client = new TransportClient(server.baseURL);
    const first = await (await client.fetchCachedUsers()).json();
    expect(calls).toBe(1);

    const second = await (await client.fetchCachedUsers()).json();
    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  it('sees every attempt of a retried request, with a rising retryCount', async () => {
    const retryCounts: number[] = [];
    setHttpTransport(async (request, caller, send) => {
      retryCounts.push(caller.retryCount ?? -1);
      return send(request);
    });

    const client = new TransportClient(server.baseURL);
    await expect(client.fetchFailing()).rejects.toThrow('HTTP request not OK: 500');

    expect(retryCounts).toEqual([0, 1, 2]);
  }, 15000);

  it('lets an error thrown by send pass through', async () => {
    const errors: string[] = [];
    setHttpTransport(async (request, _caller, send) => {
      try {
        return await send({...request, timeoutMs: 200});
      } catch (error) {
        errors.push((error as Error).message);
        throw error;
      }
    });

    const client = new TransportClient(server.baseURL);
    await expect(client.fetchHang()).rejects.toThrow('HTTP request timed out after 200ms');

    expect(errors).toEqual([`HTTP request timed out after 200ms: GET ${server.baseURL}/hang`]);
  });

  it('carries class, method and arguments in the caller', async () => {
    const callers: HttpCaller[] = [];
    setHttpTransport(async (request, caller, send) => {
      callers.push(caller);
      return send(request);
    });

    const client = new TransportClient(server.baseURL);
    await client.fetchPosts('fr');

    expect(callers).toEqual([
      {className: 'TransportClient', methodName: 'fetchPosts', args: ['fr'], retryCount: 0},
    ]);
  });

  it('passes on the caller of a direct makeHttpRequest() call, or an empty one', async () => {
    const callers: HttpCaller[] = [];
    setHttpTransport(async (request, caller, send) => {
      callers.push(caller);
      return send(request);
    });

    await makeHttpRequest(
      {method: 'GET', url: `${server.baseURL}/users`},
      {className: 'AssetClient', methodName: 'downloadAssetPack', retryCount: 0},
    );
    await makeHttpRequest({method: 'GET', url: `${server.baseURL}/users`});

    expect(callers).toEqual([
      {className: 'AssetClient', methodName: 'downloadAssetPack', retryCount: 0},
      {},
    ]);
  });

  it('is out of the way again once set to null', async () => {
    let calls = 0;
    setHttpTransport(async (request, _caller, send) => {
      calls++;
      return send(request);
    });
    setHttpTransport(null);

    const before = server.requests.length;
    const client = new TransportClient(server.baseURL);
    const result = await (await client.fetchPosts('nl')).json();

    expect(calls).toBe(0);
    expect(result).toEqual(POSTS);
    expect(server.requests).toHaveLength(before + 1);
  });
});
