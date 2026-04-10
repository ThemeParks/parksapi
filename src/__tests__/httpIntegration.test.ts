import {createServer, IncomingMessage, ServerResponse} from 'http';
import {http, stopHttpQueue, waitForHttpQueue, clearHttpInflightMap} from '../http.js';
import {CacheLib} from '../cache.js';

// Test server configuration
const TEST_PORT = 9991;
const TEST_URL = `http://localhost:${TEST_PORT}`;

// Test server instance
let server: ReturnType<typeof createServer>;

// Track requests for testing
let requestLog: Array<{method: string, url: string, headers: any, body?: string}> = [];

describe('HTTP Library Integration Tests', () => {
  beforeAll(async () => {
    // Start test HTTP server
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || '';

      // Log the request
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });

      req.on('end', () => {
        requestLog.push({
          method: req.method || 'GET',
          url: url,
          headers: req.headers,
          body: body || undefined
        });

        // Route handlers
        if (url === '/success') {
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({status: 'ok', data: 'test'}));
        }
        else if (url === '/error') {
          res.writeHead(500, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({error: 'Internal Server Error'}));
        }
        else if (url === '/not-found') {
          res.writeHead(404, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({error: 'Not Found'}));
        }
        else if (url === '/unauthorized') {
          res.writeHead(401, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({error: 'Unauthorized'}));
        }
        else if (url === '/too-many-requests') {
          res.writeHead(429, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({error: 'Too Many Requests'}));
        }
        else if (url === '/text') {
          res.writeHead(200, {'Content-Type': 'text/plain'});
          res.end('Hello World');
        }
        else if (url.startsWith('/delay/')) {
          const ms = parseInt(url.split('/')[2]);
          setTimeout(() => {
            res.writeHead(200, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({delayed: ms}));
          }, ms);
        }
        else if (url === '/validate-good') {
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({Results: [{id: 1}, {id: 2}]}));
        }
        else if (url === '/validate-bad') {
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({WrongField: 'data'}));
        }
        else if (url === '/echo-headers') {
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({headers: req.headers}));
        }
        else if (url === '/echo-body') {
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({receivedBody: body}));
        }
        else if (url.startsWith('/query')) {
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({url: url}));
        }
        else if (url === '/gzip') {
          // Return gzip-compressed JSON
          const zlib = require('zlib');
          const payload = JSON.stringify({compressed: true, data: 'gzip-test'});
          const compressed = zlib.gzipSync(payload);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
          });
          res.end(compressed);
        }
        else if (url === '/large-binary') {
          // Return a ~64KB binary payload
          const buf = Buffer.alloc(65536);
          for (let i = 0; i < buf.length; i++) buf[i] = i % 256;
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(buf.length),
          });
          res.end(buf);
        }
        else if (url === '/redirect-target') {
          res.writeHead(200, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({redirected: true}));
        }
        else if (url === '/redirect') {
          res.writeHead(303, {'Location': `${TEST_URL}/redirect-target`});
          res.end();
        }
        else if (url === '/binary') {
          // Return binary data with bytes above 127 (non-UTF-8 safe)
          const buf = Buffer.from([
            0x50, 0x4B, 0x03, 0x04, // ZIP magic header PK\x03\x04
            0xFF, 0xFE, 0x80, 0x90, // Bytes that would be corrupted by UTF-8 encoding
            0xA0, 0xB0, 0xC0, 0xD0,
            0xE0, 0xF0, 0x00, 0x01,
          ]);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(buf.length),
          });
          res.end(buf);
        }
        else {
          res.writeHead(404, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({error: 'Not Found'}));
        }
      });
    });

    // Start server and wait for it to be ready
    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => {
        console.log(`Test HTTP server started on port ${TEST_PORT}`);
        resolve();
      });
    });
  });

  afterAll(async () => {
    // Stop HTTP queue processor
    stopHttpQueue();

    // Shutdown test server
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else {
          console.log('Test HTTP server stopped');
          resolve();
        }
      });
    });
  });

  beforeEach(() => {
    // Clear request log, cache, and in-flight dedup map before each test
    requestLog = [];
    CacheLib.clear();
    clearHttpInflightMap();
  });

  describe('Basic HTTP Requests', () => {
    test('should make successful GET request', async () => {
      class TestClass {
        @http()
        async getData(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/success`,
            tags: []
          };
        }
      }

      const instance = new TestClass();
      const response = await instance.getData();

      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('ok');
      expect(data.data).toBe('test');
    });

    test('should handle text responses', async () => {
      class TestClass {
        @http()
        async getText(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/text`,
            tags: []
          };
        }
      }

      const instance = new TestClass();
      const response = await instance.getText();
      const text = await response.text();

      expect(text).toBe('Hello World');
    });

    test('should make POST request with body', async () => {
      class TestClass {
        @http()
        async postData(): Promise<any> {
          return {
            method: 'POST',
            url: `${TEST_URL}/echo-body`,
            body: {name: 'test', value: 42},
            options: {json: true},
            tags: []
          };
        }
      }

      const instance = new TestClass();
      const response = await instance.postData();
      const data = await response.json();

      expect(data.receivedBody).toBe(JSON.stringify({name: 'test', value: 42}));
      expect(requestLog[0].headers['content-type']).toBe('application/json');
    });
  });

  describe('Headers and Query Parameters', () => {
    test('should send custom headers', async () => {
      class TestClass {
        @http()
        async withHeaders(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/echo-headers`,
            headers: {
              'X-Custom-Header': 'test-value',
              'X-API-Key': 'secret123'
            },
            tags: []
          };
        }
      }

      const instance = new TestClass();
      const response = await instance.withHeaders();
      const data = await response.json();

      expect(data.headers['x-custom-header']).toBe('test-value');
      expect(data.headers['x-api-key']).toBe('secret123');
    });

    test('should build URL with query parameters', async () => {
      class TestClass {
        @http()
        async withQuery(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/query`,
            queryParams: {
              filter: 'active',
              limit: '10',
              sort: 'name'
            },
            tags: []
          };
        }
      }

      const instance = new TestClass();
      const response = await instance.withQuery();
      const data = await response.json();

      expect(data.url).toContain('filter=active');
      expect(data.url).toContain('limit=10');
      expect(data.url).toContain('sort=name');
    });
  });

  describe('Caching', () => {
    test('should cache successful responses', async () => {
      class TestClass {
        @http({cacheSeconds: 60})
        async getCached(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/success`,
            tags: []
          };
        }
      }

      const instance = new TestClass();

      // First request
      const response1 = await instance.getCached();
      expect(response1.ok).toBe(true);
      expect(requestLog.length).toBe(1);

      // Second request should use cache
      const response2 = await instance.getCached();
      expect(response2.ok).toBe(true);
      expect(requestLog.length).toBe(1); // No new request made
    });

    test('should use custom cache key', async () => {
      class TestClass {
        @http({cacheKey: 'my-custom-key', cacheSeconds: 60})
        async getCached(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/success`,
            tags: []
          };
        }
      }

      const instance = new TestClass();
      await instance.getCached();

      // Check cache has the custom key (hashed)
      expect(CacheLib.size()).toBeGreaterThan(0);
    });
  });

  describe('Response Validation', () => {
    test('should validate successful response against schema', async () => {
      class TestClass {
        @http({
          validateResponse: {
            type: 'object',
            properties: {
              Results: {type: 'array'}
            },
            required: ['Results']
          }
        })
        async getValidated(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/validate-good`,
            tags: []
          };
        }
      }

      const instance = new TestClass();
      const response = await instance.getValidated();

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.Results).toHaveLength(2);
    });

    test('should reject invalid response schema', async () => {
      class TestClass {
        @http({
          validateResponse: {
            type: 'object',
            properties: {
              Results: {type: 'array'}
            },
            required: ['Results']
          }
        })
        async getInvalid(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/validate-bad`,
            tags: []
          };
        }
      }

      const instance = new TestClass();

      await expect(instance.getInvalid()).rejects.toThrow(/does not match the expected format/);
    });
  });

  describe('Error Handling and Retries', () => {
    test('should handle server errors', async () => {
      class TestClass {
        @http()
        async getError(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/error`,
            tags: []
          };
        }
      }

      const instance = new TestClass();

      await expect(instance.getError()).rejects.toThrow(/HTTP request not OK: 500/);
    });

    test('should retry on 5xx server errors', async () => {
      class TestClass {
        @http({retries: 2})
        async getWithRetry(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/error`,
            tags: []
          };
        }
      }

      const instance = new TestClass();

      // Should fail after retries
      await expect(instance.getWithRetry()).rejects.toThrow();

      // Should have made initial request + 2 retries = 3 total
      // Wait a bit for retries to complete
      await new Promise(resolve => setTimeout(resolve, 5000));
      expect(requestLog.length).toBe(3);
    }, 10000);

    test('should NOT retry on 4xx client errors', async () => {
      class TestClass {
        @http({retries: 2})
        async getNotFound(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/not-found`,
            tags: []
          };
        }
      }

      const instance = new TestClass();

      // Should fail immediately without retrying
      await expect(instance.getNotFound()).rejects.toThrow(/HTTP request not OK: 404/);

      // Wait briefly to confirm no retries were queued
      await waitForHttpQueue();
      expect(requestLog.length).toBe(1); // Only the initial request, no retries
    }, 5000);

    test('should NOT retry on 401 Unauthorized', async () => {
      class TestClass {
        @http({retries: 3})
        async getUnauthorized(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/unauthorized`,
            tags: []
          };
        }
      }

      const instance = new TestClass();

      await expect(instance.getUnauthorized()).rejects.toThrow(/HTTP request not OK: 401/);

      await waitForHttpQueue();
      expect(requestLog.length).toBe(1); // Only the initial request, no retries
    }, 5000);

    test('should retry on 429 Too Many Requests', async () => {
      class TestClass {
        @http({retries: 2})
        async getTooManyRequests(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/too-many-requests`,
            tags: []
          };
        }
      }

      const instance = new TestClass();

      // Should fail after retries
      await expect(instance.getTooManyRequests()).rejects.toThrow();

      // Should have made initial request + 2 retries = 3 total
      await new Promise(resolve => setTimeout(resolve, 5000));
      expect(requestLog.length).toBe(3);
    }, 10000);
  });

  describe('Delayed Requests', () => {
    test('should handle delayed execution', async () => {
      class TestClass {
        @http({delayMs: 500})
        async getDelayed(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/success`,
            tags: []
          };
        }
      }

      const instance = new TestClass();
      const startTime = Date.now();

      await instance.getDelayed();

      const elapsed = Date.now() - startTime;
      // Should have waited at least 500ms
      expect(elapsed).toBeGreaterThanOrEqual(500);
    }, 10000);
  });

  describe('Global Rate Limiting', () => {
    test('should enforce 250ms spacing between concurrent requests', async () => {
      // 5 requests to distinct URLs fired in parallel must take at least
      // (5-1)*250ms = 1000ms due to the global rate limiter, even though
      // they all start "at once" via Promise.all.
      class TestClass {
        @http()
        async getSuccess(): Promise<any> {
          return {method: 'GET', url: `${TEST_URL}/success`, tags: []};
        }
        @http()
        async getText(): Promise<any> {
          return {method: 'GET', url: `${TEST_URL}/text`, tags: []};
        }
        @http()
        async getValidateGood(): Promise<any> {
          return {method: 'GET', url: `${TEST_URL}/validate-good`, tags: []};
        }
        @http()
        async getDelay0(): Promise<any> {
          return {method: 'GET', url: `${TEST_URL}/delay/0`, tags: []};
        }
        @http()
        async getEchoHeaders(): Promise<any> {
          return {method: 'GET', url: `${TEST_URL}/echo-headers`, tags: []};
        }
      }

      const instance = new TestClass();
      const startTime = Date.now();

      await Promise.all([
        instance.getSuccess(),
        instance.getText(),
        instance.getValidateGood(),
        instance.getDelay0(),
        instance.getEchoHeaders(),
      ]);

      const elapsed = Date.now() - startTime;
      // 5 requests, 250ms apart minimum → at least ~1000ms total
      expect(elapsed).toBeGreaterThanOrEqual(1000);
    }, 10000);
  });

  describe('Response Callbacks', () => {
    test('should call onJson callback on successful response', async () => {
      let callbackData: any = null;

      class TestClass {
        @http()
        async getData(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/success`,
            tags: [],
            onJson: (data: any) => {
              callbackData = data;
            }
          };
        }
      }

      const instance = new TestClass();
      await instance.getData();

      expect(callbackData).toBeDefined();
      expect(callbackData.status).toBe('ok');
    });

    test('should call onText callback', async () => {
      let callbackData: string | null = null;

      class TestClass {
        @http()
        async getText(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/text`,
            tags: [],
            onText: (data: string) => {
              callbackData = data;
            }
          };
        }
      }

      const instance = new TestClass();
      await instance.getText();

      expect(callbackData).toBe('Hello World');
    });
  });

  describe('Binary Responses', () => {
    test('should preserve binary data integrity via arrayBuffer()', async () => {
      class TestClass {
        @http()
        async getBinary(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/binary`,
            tags: [],
          };
        }
      }

      const instance = new TestClass();
      const resp = await instance.getBinary();
      const ab = await resp.arrayBuffer();
      const buf = Buffer.from(ab);

      // Verify exact byte values — these include bytes above 127 that would be
      // corrupted if the response was decoded as UTF-8 text (the old behavior)
      expect(buf.length).toBe(16);
      expect(buf[0]).toBe(0x50); // 'P'
      expect(buf[1]).toBe(0x4B); // 'K'
      expect(buf[4]).toBe(0xFF);
      expect(buf[5]).toBe(0xFE);
      expect(buf[6]).toBe(0x80);
      expect(buf[7]).toBe(0x90);
    });

    test('binary response should have correct Content-Length', async () => {
      class TestClass {
        @http()
        async getBinary(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/binary`,
            tags: [],
          };
        }
      }

      const instance = new TestClass();
      const resp = await instance.getBinary();
      const ab = await resp.arrayBuffer();

      // Content-Length should match actual binary data size (not inflated by UTF-8 encoding)
      expect(ab.byteLength).toBe(16);
    });

    test('should handle large binary payloads (64KB)', async () => {
      class TestClass {
        @http()
        async getLargeBinary(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/large-binary`,
            tags: [],
          };
        }
      }

      const instance = new TestClass();
      const resp = await instance.getLargeBinary();
      const ab = await resp.arrayBuffer();
      const buf = Buffer.from(ab);

      expect(buf.length).toBe(65536);
      // Verify byte pattern survived intact
      for (let i = 0; i < 256; i++) {
        expect(buf[i]).toBe(i);
      }
      expect(buf[256]).toBe(0); // wraps around
      expect(buf[511]).toBe(255);
    });

    test('should access binary data via text() as well', async () => {
      class TestClass {
        @http()
        async getBinary(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/binary`,
            tags: [],
          };
        }
      }

      const instance = new TestClass();
      const resp = await instance.getBinary();
      // text() should return something without throwing
      const text = await resp.text();
      expect(typeof text).toBe('string');
    });
  });

  describe('Gzip Responses', () => {
    test('should decompress gzip-encoded JSON responses', async () => {
      class TestClass {
        @http()
        async getGzip(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/gzip`,
            tags: [],
          };
        }
      }

      const instance = new TestClass();
      const resp = await instance.getGzip();
      const data = await resp.json();

      expect(data.compressed).toBe(true);
      expect(data.data).toBe('gzip-test');
    });
  });

  describe('Redirect Handling', () => {
    test('httpProxy does not auto-follow redirects (303 returns raw status)', async () => {
      // This is critical for Attractions.io which uses 303 to signal new ZIP data
      const {makeHttpRequest} = await import('../httpProxy.js');

      const resp = await makeHttpRequest({
        method: 'GET',
        url: `${TEST_URL}/redirect`,
        headers: {},
      });

      // httpProxy should NOT follow the redirect
      expect(resp.status).toBe(303);
      expect(resp.headers.get('location')).toBe(`${TEST_URL}/redirect-target`);
    });
  });

  describe('In-flight Deduplication', () => {
    test('concurrent identical @http calls result in only one HTTP request', async () => {
      // Simulate a cold-start race condition: multiple concurrent callers hit the
      // same @http method before the first request resolves. Without dedup this
      // would enqueue N separate requests; with dedup only one is enqueued.
      class TestClass {
        @http()
        async fetchShared(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/success`,
            tags: [],
          };
        }
      }

      const instance = new TestClass();

      // Fire 5 concurrent calls — none should be cached at this point
      const results = await Promise.all([
        instance.fetchShared(),
        instance.fetchShared(),
        instance.fetchShared(),
        instance.fetchShared(),
        instance.fetchShared(),
      ]);

      await waitForHttpQueue();

      // All promises should resolve successfully
      expect(results).toHaveLength(5);
      for (const r of results) {
        expect(r.ok).toBe(true);
      }

      // Critically: only ONE actual HTTP request should have been made
      expect(requestLog.length).toBe(1);
    });

    test('different instances each make their own request', async () => {
      class TestClass {
        @http()
        async fetchData(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/success`,
            tags: [],
          };
        }
      }

      const instance1 = new TestClass();
      const instance2 = new TestClass();

      // Fire concurrent calls from two different instances — each should get its own request
      await Promise.all([
        instance1.fetchData(),
        instance2.fetchData(),
      ]);

      await waitForHttpQueue();

      // Two instances → two separate HTTP requests
      expect(requestLog.length).toBe(2);
    });

    test('different args each make their own request', async () => {
      class TestClass {
        @http()
        async fetchWithParam(path: string): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}${path}`,
            tags: [],
          };
        }
      }

      const instance = new TestClass();

      await Promise.all([
        instance.fetchWithParam('/success'),
        instance.fetchWithParam('/text'),
      ]);

      await waitForHttpQueue();

      // Different args → two separate HTTP requests (no dedup across different args)
      expect(requestLog.length).toBe(2);
    });

    test('sequential calls each make their own request after the first resolves', async () => {
      class TestClass {
        @http()
        async fetchData(): Promise<any> {
          return {
            method: 'GET',
            url: `${TEST_URL}/success`,
            tags: [],
          };
        }
      }

      const instance = new TestClass();

      // First call
      await instance.fetchData();
      await waitForHttpQueue();
      expect(requestLog.length).toBe(1);

      // Second call — inflight entry was removed on resolve, so a fresh request is made
      await instance.fetchData();
      await waitForHttpQueue();
      expect(requestLog.length).toBe(2);
    });
  });
});
