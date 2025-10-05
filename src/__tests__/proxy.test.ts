// Tests for proxy injection system
import {enableProxySupport, disableProxySupport, getProxyConfig} from '../proxy';
import {HTTPObj} from '../http';
import {broadcast} from '../injector';

describe('Proxy Injection System', () => {
  // Save original environment before each test
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = {...process.env};
    disableProxySupport(); // Ensure clean state
  });

  afterEach(() => {
    process.env = originalEnv;
    disableProxySupport();
  });

  describe('Configuration Loading', () => {
    it('should load CrawlBase config from environment variable', () => {
      process.env.TEST_CRAWLBASE = JSON.stringify({apikey: 'test-crawlbase-key'});

      enableProxySupport(['TEST']);

      const config = getProxyConfig();
      expect(config.crawlbase).toEqual({apikey: 'test-crawlbase-key'});
    });

    it('should load Scrapfly config from environment variable', () => {
      process.env.TEST_SCRAPFLY = JSON.stringify({apikey: 'test-scrapfly-key'});

      enableProxySupport(['TEST']);

      const config = getProxyConfig();
      expect(config.scrapfly).toEqual({apikey: 'test-scrapfly-key'});
    });

    it('should load basic proxy config from environment variable', () => {
      process.env.TEST_BASICPROXY = JSON.stringify({proxy: 'http://proxy.example.com:8080'});

      enableProxySupport(['TEST']);

      const config = getProxyConfig();
      expect(config.basicProxy).toEqual({proxy: 'http://proxy.example.com:8080'});
    });

    it('should check multiple prefixes in order', () => {
      process.env.PREFIX1_CRAWLBASE = JSON.stringify({apikey: 'key1'});
      process.env.PREFIX2_SCRAPFLY = JSON.stringify({apikey: 'key2'});

      enableProxySupport(['PREFIX1', 'PREFIX2']);

      const config = getProxyConfig();
      expect(config.crawlbase).toEqual({apikey: 'key1'});
      expect(config.scrapfly).toEqual({apikey: 'key2'});
    });

    it('should handle invalid JSON gracefully', () => {
      process.env.TEST_CRAWLBASE = 'invalid-json';

      // Should not throw
      enableProxySupport(['TEST']);

      const config = getProxyConfig();
      expect(config.crawlbase).toBeUndefined();
    });

    it('should return empty config when no environment variables set', () => {
      enableProxySupport(['NONEXISTENT']);

      const config = getProxyConfig();
      expect(config).toEqual({});
    });
  });

  describe('CrawlBase Proxy Injection', () => {
    it('should rewrite URL to use CrawlBase API', async () => {
      process.env.TEST_CRAWLBASE = JSON.stringify({apikey: 'test-key'});
      enableProxySupport(['TEST']);

      const requestObj: HTTPObj = {
        method: 'GET',
        url: 'https://example.com/api/data',
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
        clone: () => requestObj,
        onJson: null,
        onText: null,
        onBlob: null,
        onArrayBuffer: null,
      };

      await broadcast('global', {eventName: 'httpRequest'}, requestObj);

      expect(requestObj.url).toBe(
        'https://api.crawlbase.com/?url=https%3A%2F%2Fexample.com%2Fapi%2Fdata&token=test-key'
      );
    });
  });

  describe('Scrapfly Proxy Injection', () => {
    it('should rewrite URL to use Scrapfly API', async () => {
      process.env.TEST_SCRAPFLY = JSON.stringify({apikey: 'test-key'});
      enableProxySupport(['TEST']);

      const requestObj: HTTPObj = {
        method: 'GET',
        url: 'https://example.com/api/data',
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
        clone: () => requestObj,
        onJson: null,
        onText: null,
        onBlob: null,
        onArrayBuffer: null,
      };

      await broadcast('global', {eventName: 'httpRequest'}, requestObj);

      expect(requestObj.url).toBe(
        'https://api.scrapfly.io/scrape?url=https%3A%2F%2Fexample.com%2Fapi%2Fdata&key=test-key'
      );
    });

    it('should unwrap Scrapfly response', async () => {
      process.env.TEST_SCRAPFLY = JSON.stringify({apikey: 'test-key'});
      enableProxySupport(['TEST']);

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

      const requestObj: HTTPObj = {
        method: 'GET',
        url: 'https://api.scrapfly.io/scrape?url=...',
        headers: {},
        options: {},
        body: undefined,
        tags: [],
        response: mockResponse,
        json: async () => ({}),
        text: async () => '',
        blob: async () => new Blob(),
        arrayBuffer: async () => new ArrayBuffer(0),
        status: 200,
        ok: true,
        clone: () => requestObj,
        onJson: null,
        onText: null,
        onBlob: null,
        onArrayBuffer: null,
      };

      await broadcast('global', {eventName: 'httpResponse'}, requestObj);

      // Response should be unwrapped
      expect(requestObj.response).toBeDefined();
      const text = await requestObj.response!.text();
      expect(text).toBe('{"data": "unwrapped"}');
      expect(requestObj.response!.status).toBe(200);
    });

    it('should handle non-Scrapfly responses gracefully', async () => {
      process.env.TEST_SCRAPFLY = JSON.stringify({apikey: 'test-key'});
      enableProxySupport(['TEST']);

      const normalResponse = new Response('{"data": "normal"}', {
        status: 200,
        headers: {'content-type': 'application/json'},
      });

      const requestObj: HTTPObj = {
        method: 'GET',
        url: 'https://example.com/api/data',
        headers: {},
        options: {},
        body: undefined,
        tags: [],
        response: normalResponse,
        json: async () => ({}),
        text: async () => '',
        blob: async () => new Blob(),
        arrayBuffer: async () => new ArrayBuffer(0),
        status: 200,
        ok: true,
        clone: () => requestObj,
        onJson: null,
        onText: null,
        onBlob: null,
        onArrayBuffer: null,
      };

      const originalResponse = requestObj.response;
      await broadcast('global', {eventName: 'httpResponse'}, requestObj);

      // Response should remain unchanged (not a Scrapfly response)
      expect(requestObj.response).toBe(originalResponse);
    });
  });

  describe('Proxy Priority', () => {
    it('should prefer CrawlBase over Scrapfly when both configured', async () => {
      process.env.TEST_CRAWLBASE = JSON.stringify({apikey: 'crawlbase-key'});
      process.env.TEST_SCRAPFLY = JSON.stringify({apikey: 'scrapfly-key'});
      enableProxySupport(['TEST']);

      const requestObj: HTTPObj = {
        method: 'GET',
        url: 'https://example.com/api/data',
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
        clone: () => requestObj,
        onJson: null,
        onText: null,
        onBlob: null,
        onArrayBuffer: null,
      };

      await broadcast('global', {eventName: 'httpRequest'}, requestObj);

      // Should use CrawlBase (higher priority)
      expect(requestObj.url).toContain('api.crawlbase.com');
    });
  });

  describe('Basic Proxy Support', () => {
    it('should configure basic proxy from environment variable', () => {
      process.env.TEST_BASICPROXY = JSON.stringify({proxy: 'http://myproxy.com:8080'});
      enableProxySupport(['TEST']);

      const config = getProxyConfig();
      expect(config.basicProxy).toEqual({proxy: 'http://myproxy.com:8080'});
    });

    it('should log basic proxy usage on injection', async () => {
      process.env.TEST_BASICPROXY = JSON.stringify({proxy: 'http://myproxy.com:8080'});
      enableProxySupport(['TEST']);

      const consoleLogSpy = jest.spyOn(console, 'log');

      const requestObj: HTTPObj = {
        method: 'GET',
        url: 'https://example.com/api/data',
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
        clone: () => requestObj,
        onJson: null,
        onText: null,
        onBlob: null,
        onArrayBuffer: null,
      };

      await broadcast('global', {eventName: 'httpRequest'}, requestObj);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Using basic HTTP proxy: http://myproxy.com:8080')
      );

      consoleLogSpy.mockRestore();
    });

    it('should not modify URL for basic proxy (handled by HTTP client)', async () => {
      process.env.TEST_BASICPROXY = JSON.stringify({proxy: 'http://myproxy.com:8080'});
      enableProxySupport(['TEST']);

      const requestObj: HTTPObj = {
        method: 'GET',
        url: 'https://example.com/api/data',
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
        clone: () => requestObj,
        onJson: null,
        onText: null,
        onBlob: null,
        onArrayBuffer: null,
      };

      const originalUrl = requestObj.url;
      await broadcast('global', {eventName: 'httpRequest'}, requestObj);

      // URL should remain unchanged (proxy handled at HTTP client level)
      expect(requestObj.url).toBe(originalUrl);
    });
  });

  describe('Enable/Disable', () => {
    it('should not inject when disabled', async () => {
      process.env.TEST_CRAWLBASE = JSON.stringify({apikey: 'test-key'});
      enableProxySupport(['TEST']);
      disableProxySupport();

      const requestObj: HTTPObj = {
        method: 'GET',
        url: 'https://example.com/api/data',
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
        clone: () => requestObj,
        onJson: null,
        onText: null,
        onBlob: null,
        onArrayBuffer: null,
      };

      const originalUrl = requestObj.url;
      await broadcast('global', {eventName: 'httpRequest'}, requestObj);

      // URL should remain unchanged
      expect(requestObj.url).toBe(originalUrl);
    });

    it('should clear config when disabled', () => {
      process.env.TEST_CRAWLBASE = JSON.stringify({apikey: 'test-key'});
      enableProxySupport(['TEST']);

      expect(getProxyConfig().crawlbase).toBeDefined();

      disableProxySupport();

      expect(getProxyConfig()).toEqual({});
    });
  });
});
