// Tests for proxy injection system
import {loadProxyConfig, hasProxyConfig, type ProxyConfig} from '../proxy';
import {Destination} from '../destination';
import {HTTPObj, redactProxyUrlSecrets} from '../http';
import {broadcast} from '../injector';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import config from '../config';

// Mock destination for testing proxy injection
@config
class ProxyTestDestination extends Destination {
  protected async buildEntityList(): Promise<Entity[]> { return []; }
  protected async buildLiveData(): Promise<LiveData[]> { return []; }
  protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
}

// Create a mock HTTPObj for testing
function createMockRequest(url: string = 'https://example.com/api/data'): HTTPObj {
  const obj: HTTPObj = {
    method: 'GET',
    url,
    headers: {},
    options: {},
    body: undefined,
    tags: [],
    json: async () => ({}),
    text: async () => '',
    blob: async () => new Blob(),
    arrayBuffer: async () => new ArrayBuffer(0),
    status: 200,
    ok: true,
    clone: () => obj,
    onJson: null,
    onText: null,
    onBlob: null,
    onArrayBuffer: null,
  };
  return obj;
}

describe('Proxy Configuration Loading', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = {...process.env};
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load CrawlBase config from environment variable', () => {
    process.env.TEST_CRAWLBASE = JSON.stringify({apikey: 'test-crawlbase-key'});

    const config = loadProxyConfig(['TEST']);
    expect(config.crawlbase).toEqual({apikey: 'test-crawlbase-key'});
  });

  it('should load Scrapfly config from environment variable', () => {
    process.env.TEST_SCRAPFLY = JSON.stringify({apikey: 'test-scrapfly-key'});

    const config = loadProxyConfig(['TEST']);
    expect(config.scrapfly).toEqual({apikey: 'test-scrapfly-key'});
  });

  it('should load basic proxy config from environment variable', () => {
    process.env.TEST_BASICPROXY = JSON.stringify({proxy: 'http://proxy.example.com:8080'});

    const config = loadProxyConfig(['TEST']);
    expect(config.basicProxy).toEqual({proxy: 'http://proxy.example.com:8080'});
  });

  it('should check multiple prefixes in order', () => {
    process.env.PREFIX1_CRAWLBASE = JSON.stringify({apikey: 'key1'});
    process.env.PREFIX2_SCRAPFLY = JSON.stringify({apikey: 'key2'});

    const config = loadProxyConfig(['PREFIX1', 'PREFIX2']);
    expect(config.crawlbase).toEqual({apikey: 'key1'});
    expect(config.scrapfly).toEqual({apikey: 'key2'});
  });

  it('should handle invalid JSON gracefully', () => {
    process.env.TEST_CRAWLBASE = 'invalid-json';

    const config = loadProxyConfig(['TEST']);
    expect(config.crawlbase).toBeUndefined();
  });

  it('should return empty config when no environment variables set', () => {
    const config = loadProxyConfig(['NONEXISTENT']);
    expect(config).toEqual({});
    expect(hasProxyConfig(config)).toBe(false);
  });

  it('should detect when config has proxy settings', () => {
    process.env.TEST_CRAWLBASE = JSON.stringify({apikey: 'key'});
    const config = loadProxyConfig(['TEST']);
    expect(hasProxyConfig(config)).toBe(true);
  });
});

describe('Per-Destination Proxy Injection', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = {...process.env};
    Destination.resetGlobalProxyState();
  });

  afterEach(() => {
    process.env = originalEnv;
    Destination.resetGlobalProxyState();
  });

  it('should rewrite URL to use CrawlBase for destinations that enable it', async () => {
    process.env.PROXYTESTDESTINATION_CRAWLBASE = JSON.stringify({apikey: 'test-key'});

    const dest = new ProxyTestDestination();
    dest.addConfigPrefix('PROXYTESTDESTINATION');

    const req = createMockRequest();
    await broadcast(dest, {eventName: 'httpRequest', hostname: 'example.com', url: req.url, method: req.method, tags: req.tags}, req);

    expect(req.url).toBe('https://api.crawlbase.com/?url=https%3A%2F%2Fexample.com%2Fapi%2Fdata&token=test-key');
  });

  it('should rewrite URL to use Scrapfly for destinations that enable it', async () => {
    process.env.PROXYTESTDESTINATION_SCRAPFLY = JSON.stringify({apikey: 'test-key'});

    const dest = new ProxyTestDestination();
    dest.addConfigPrefix('PROXYTESTDESTINATION');

    const req = createMockRequest();
    await broadcast(dest, {eventName: 'httpRequest', hostname: 'example.com', url: req.url, method: req.method, tags: req.tags}, req);

    // Scrapfly params live in queryParams (merged into the URL only at
    // buildUrl() time) — req.url stays the bare endpoint so logs don't leak.
    expect(req.url).toBe('https://api.scrapfly.io/scrape');
    expect(req.queryParams).toMatchObject({url: 'https://example.com/api/data', key: 'test-key'});
  });

  it('should forward request headers to Scrapfly as headers[] params', async () => {
    process.env.PROXYTESTDESTINATION_SCRAPFLY = JSON.stringify({apikey: 'test-key'});

    const dest = new ProxyTestDestination();
    dest.addConfigPrefix('PROXYTESTDESTINATION');

    const req = createMockRequest();
    // Custom auth headers (fake values) — these must reach the target, or
    // header-authenticated APIs (e.g. x-api-key) 401 through Scrapfly.
    req.headers = {'x-api-key': 'fake-key-123', 'X-Custom-Auth': 'fake-token'};
    await broadcast(dest, {eventName: 'httpRequest', hostname: 'example.com', url: req.url, method: req.method, tags: req.tags}, req);

    expect(req.queryParams!['headers[x-api-key]']).toBe('fake-key-123');
    expect(req.queryParams!['headers[X-Custom-Auth]']).toBe('fake-token');
    // Secrets must NOT be baked into req.url (logged verbatim on retry/trace),
    // and the original request headers are cleared after forwarding.
    expect(req.url).toBe('https://api.scrapfly.io/scrape');
    expect(req.headers).toEqual({});
  });

  it('should not forward hop-by-hop headers to Scrapfly', async () => {
    process.env.PROXYTESTDESTINATION_SCRAPFLY = JSON.stringify({apikey: 'test-key'});

    const dest = new ProxyTestDestination();
    dest.addConfigPrefix('PROXYTESTDESTINATION');

    const req = createMockRequest();
    req.headers = {
      host: 'example.com',
      'content-length': '5',
      connection: 'keep-alive',
      'accept-encoding': 'gzip',
      'x-api-key': 'keep-me',
    };
    await broadcast(dest, {eventName: 'httpRequest', hostname: 'example.com', url: req.url, method: req.method, tags: req.tags}, req);

    expect(req.queryParams).not.toHaveProperty('headers[host]');
    expect(req.queryParams).not.toHaveProperty('headers[content-length]');
    expect(req.queryParams).not.toHaveProperty('headers[connection]');
    expect(req.queryParams).not.toHaveProperty('headers[accept-encoding]');
    // Non-hop-by-hop headers still forwarded
    expect(req.queryParams!['headers[x-api-key]']).toBe('keep-me');
  });

  it('should forward method and body for non-GET requests and call Scrapfly via GET', async () => {
    process.env.PROXYTESTDESTINATION_SCRAPFLY = JSON.stringify({apikey: 'test-key'});

    const dest = new ProxyTestDestination();
    dest.addConfigPrefix('PROXYTESTDESTINATION');

    const req = createMockRequest();
    req.method = 'POST';
    req.body = '{"foo":"bar"}';
    await broadcast(dest, {eventName: 'httpRequest', hostname: 'example.com', url: req.url, method: req.method, tags: req.tags}, req);

    expect(req.queryParams!.method).toBe('POST');
    expect(req.queryParams!.body).toBe('{"foo":"bar"}');
    // The request TO Scrapfly is itself a GET (Scrapfly performs the POST to the target)
    expect(req.method).toBe('GET');
    expect(req.body).toBeUndefined();
  });

  it('should JSON-encode object bodies when forwarding to Scrapfly', async () => {
    process.env.PROXYTESTDESTINATION_SCRAPFLY = JSON.stringify({apikey: 'test-key'});

    const dest = new ProxyTestDestination();
    dest.addConfigPrefix('PROXYTESTDESTINATION');

    const req = createMockRequest();
    req.method = 'POST';
    req.body = {foo: 'bar'};
    await broadcast(dest, {eventName: 'httpRequest', hostname: 'example.com', url: req.url, method: req.method, tags: req.tags}, req);

    expect(req.queryParams!.body).toBe('{"foo":"bar"}');
  });

  it('should leave GET requests without a method/body param', async () => {
    process.env.PROXYTESTDESTINATION_SCRAPFLY = JSON.stringify({apikey: 'test-key'});

    const dest = new ProxyTestDestination();
    dest.addConfigPrefix('PROXYTESTDESTINATION');

    const req = createMockRequest();
    await broadcast(dest, {eventName: 'httpRequest', hostname: 'example.com', url: req.url, method: req.method, tags: req.tags}, req);

    expect(req.queryParams).not.toHaveProperty('method');
    expect(req.queryParams).not.toHaveProperty('body');
  });

  it('should fold the request queryParams into the Scrapfly target url param', async () => {
    process.env.PROXYTESTDESTINATION_SCRAPFLY = JSON.stringify({apikey: 'test-key'});

    const dest = new ProxyTestDestination();
    dest.addConfigPrefix('PROXYTESTDESTINATION');

    const req = createMockRequest('https://example.com/api/data');
    // Target's own query params must survive proxying (Scrapfly fetches `url` verbatim).
    req.queryParams = {region: 'jp', limit: '10'};
    await broadcast(dest, {eventName: 'httpRequest', hostname: 'example.com', url: req.url, method: req.method, tags: req.tags}, req);

    expect(req.queryParams!.url).toBe('https://example.com/api/data?region=jp&limit=10');
    // The target params are NOT left as top-level params on the Scrapfly call.
    expect(req.queryParams).not.toHaveProperty('region');
    expect(req.queryParams).not.toHaveProperty('limit');
    expect(req.url).toBe('https://api.scrapfly.io/scrape');
  });

  it('should forward Content-Type/Accept for options.json requests', async () => {
    process.env.PROXYTESTDESTINATION_SCRAPFLY = JSON.stringify({apikey: 'test-key'});

    const dest = new ProxyTestDestination();
    dest.addConfigPrefix('PROXYTESTDESTINATION');

    const req = createMockRequest();
    req.method = 'POST';
    req.options = {json: true};
    await broadcast(dest, {eventName: 'httpRequest', hostname: 'example.com', url: req.url, method: req.method, tags: req.tags}, req);

    expect(req.queryParams!['headers[Content-Type]']).toBe('application/json');
    expect(req.queryParams!['headers[Accept]']).toBe('application/json');
  });

  it('should not duplicate Content-Type already set in request headers', async () => {
    process.env.PROXYTESTDESTINATION_SCRAPFLY = JSON.stringify({apikey: 'test-key'});

    const dest = new ProxyTestDestination();
    dest.addConfigPrefix('PROXYTESTDESTINATION');

    const req = createMockRequest();
    req.method = 'POST';
    req.options = {json: true};
    req.headers = {'content-type': 'application/json'}; // lowercase, explicitly set
    await broadcast(dest, {eventName: 'httpRequest', hostname: 'example.com', url: req.url, method: req.method, tags: req.tags}, req);

    // The explicit lowercase header is forwarded; the capitalized json default is NOT added on top.
    expect(req.queryParams!['headers[content-type]']).toBe('application/json');
    expect(req.queryParams).not.toHaveProperty('headers[Content-Type]');
  });

  it('should set proxyUrl for basic proxy', async () => {
    process.env.PROXYTESTDESTINATION_BASICPROXY = JSON.stringify({proxy: 'http://myproxy.com:8080'});

    const dest = new ProxyTestDestination();
    dest.addConfigPrefix('PROXYTESTDESTINATION');

    const req = createMockRequest();
    const originalUrl = req.url;
    await broadcast(dest, {eventName: 'httpRequest', hostname: 'example.com', url: req.url, method: req.method, tags: req.tags}, req);

    // URL should remain unchanged (proxy handled at HTTP client level)
    expect(req.url).toBe(originalUrl);
    expect((req as any).proxyUrl).toBe('http://myproxy.com:8080');
  });

  it('should NOT proxy requests when no matching config prefix is registered', async () => {
    process.env.PROXYTESTDESTINATION_CRAWLBASE = JSON.stringify({apikey: 'test-key'});

    // Create destination but DON'T register the PROXYTESTDESTINATION prefix,
    // so env vars under that prefix are never loaded.
    const dest = new ProxyTestDestination();

    const req = createMockRequest();
    const originalUrl = req.url;
    await broadcast(dest, {eventName: 'httpRequest', hostname: 'example.com', url: req.url, method: req.method, tags: req.tags}, req);

    // URL should remain unchanged
    expect(req.url).toBe(originalUrl);
  });

  it('should prefer CrawlBase over Scrapfly when both configured', async () => {
    process.env.PROXYTESTDESTINATION_CRAWLBASE = JSON.stringify({apikey: 'crawlbase-key'});
    process.env.PROXYTESTDESTINATION_SCRAPFLY = JSON.stringify({apikey: 'scrapfly-key'});

    const dest = new ProxyTestDestination();
    dest.addConfigPrefix('PROXYTESTDESTINATION');

    const req = createMockRequest();
    await broadcast(dest, {eventName: 'httpRequest', hostname: 'example.com', url: req.url, method: req.method, tags: req.tags}, req);

    expect(req.url).toContain('api.crawlbase.com');
  });

  it('should unwrap Scrapfly response', async () => {
    process.env.PROXYTESTDESTINATION_SCRAPFLY = JSON.stringify({apikey: 'test-key'});

    const dest = new ProxyTestDestination();
    dest.addConfigPrefix('PROXYTESTDESTINATION');

    const scrapflyResponse = {
      result: {
        content: '{"data": "unwrapped"}',
        status_code: 200,
        response_headers: {'content-type': 'application/json'},
      },
    };

    const mockResponse = new Response(JSON.stringify(scrapflyResponse), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });

    const req = createMockRequest();
    req.response = mockResponse;
    await broadcast(dest, {eventName: 'httpResponse', hostname: 'example.com', url: req.url, method: req.method, tags: req.tags}, req);

    expect(req.response).toBeDefined();
    const text = await req.response!.text();
    expect(text).toBe('{"data": "unwrapped"}');
    expect(req.response!.status).toBe(200);
  });

  it('should not unwrap non-Scrapfly responses', async () => {
    process.env.PROXYTESTDESTINATION_SCRAPFLY = JSON.stringify({apikey: 'test-key'});

    const dest = new ProxyTestDestination();
    dest.addConfigPrefix('PROXYTESTDESTINATION');

    const normalResponse = new Response('{"data": "normal"}', {
      status: 200,
      headers: {'content-type': 'application/json'},
    });

    const req = createMockRequest();
    req.response = normalResponse;
    const originalResponse = req.response;
    await broadcast(dest, {eventName: 'httpResponse', hostname: 'example.com', url: req.url, method: req.method, tags: req.tags}, req);

    // Response should remain unchanged
    expect(req.response).toBe(originalResponse);
  });
});

describe('redactProxyUrlSecrets', () => {
  it('masks the Scrapfly key, forwarded headers and body', () => {
    const url =
      'https://api.scrapfly.io/scrape?url=https%3A%2F%2Fexample.com&key=fake-key&headers%5Bx-api-key%5D=fake-auth&body=secret-payload';
    const redacted = redactProxyUrlSecrets(url);
    expect(redacted).not.toContain('fake-key');
    expect(redacted).not.toContain('fake-auth');
    expect(redacted).not.toContain('secret-payload');
    // The target url stays visible (not a secret, useful for debugging)
    expect(redacted).toContain('url=https%3A%2F%2Fexample.com');
    expect(redacted).toContain('key=***');
  });

  it('masks the CrawlBase token', () => {
    const url = 'https://api.crawlbase.com/?url=https%3A%2F%2Fexample.com&token=fake-token';
    const redacted = redactProxyUrlSecrets(url);
    expect(redacted).not.toContain('fake-token');
    expect(redacted).toContain('token=***');
  });

  it('leaves non-proxy URLs unchanged', () => {
    const url = 'https://example.com/api/data?key=should-stay&foo=bar';
    expect(redactProxyUrlSecrets(url)).toBe(url);
  });

  it('returns the input unchanged when not a valid URL', () => {
    expect(redactProxyUrlSecrets('not a url')).toBe('not a url');
  });
});
