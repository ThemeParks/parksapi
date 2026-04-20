// Tests for proxy injection system
import {loadProxyConfig, hasProxyConfig, type ProxyConfig} from '../proxy';
import {Destination} from '../destination';
import {HTTPObj} from '../http';
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

    expect(req.url).toBe('https://api.scrapfly.io/scrape?url=https%3A%2F%2Fexample.com%2Fapi%2Fdata&key=test-key');
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
