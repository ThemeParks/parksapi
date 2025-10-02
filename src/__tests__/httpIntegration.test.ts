import {describe, test, expect, beforeAll, afterAll, beforeEach} from '@jest/globals';
import {createServer, IncomingMessage, ServerResponse} from 'http';
import {http, stopHttpQueue} from '../http.js';
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
    // Clear request log and cache before each test
    requestLog = [];
    CacheLib.clear();
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

    test('should retry failed requests', async () => {
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
});
