/**
 * Trace context has to survive the hop into an injection handler and into any
 * request that handler makes of its own. That is a property of `src/tracing.ts`
 * and `src/http.ts`, not of any particular endpoint, so these run against a
 * loopback server rather than httpbin.org — see helpers/localHttpServer.ts.
 */
import { tracing } from '../tracing';
import { http, HTTPObj, stopHttpQueue, waitForHttpQueue } from '../http';
import { inject } from '../injector';
import { startLocalServer, LocalServer } from './helpers/localHttpServer';

/** Loopback, so the `@inject` hostname matcher has a literal to match on. */
const HOST = '127.0.0.1';

describe('Trace Context Propagation', () => {
  let server: LocalServer;

  beforeAll(async () => {
    server = await startLocalServer();
  });

  afterAll(async () => {
    stopHttpQueue();
    await server.close();
  });

  it('should propagate trace context through injection handlers', async () => {
    const capturedTraceIds: string[] = [];
    const capturedEvents: string[] = [];
    const baseURL = server.baseURL;

    class TestClass {
      @http({ cacheSeconds: 0 })
      async makeRequest(): Promise<HTTPObj> {
        const context = tracing.getContext();
        if (context) {
          capturedTraceIds.push(context.traceId);
          capturedEvents.push('makeRequest');
        }

        return {
          method: 'GET',
          url: `${baseURL}/get`,
          tags: ['test'],
        } as HTTPObj;
      }

      @http({ cacheSeconds: 0 })
      async nestedRequest(): Promise<HTTPObj> {
        const context = tracing.getContext();
        if (context) {
          capturedTraceIds.push(context.traceId);
          capturedEvents.push('nestedRequest');
        }

        return {
          method: 'GET',
          url: `${baseURL}/delay/1`,
          tags: ['nested'],
        } as HTTPObj;
      }

      @inject({
        eventName: 'httpRequest',
        hostname: HOST,
        tags: { $nin: ['nested'] }
      })
      async injectHandler(req: any) {
        // Check that trace context is available in injection handler
        const context = tracing.getContext();
        if (context) {
          capturedTraceIds.push(context.traceId);
          capturedEvents.push('injectHandler');
        }

        // Make a nested request - should inherit trace context
        await this.nestedRequest();
      }
    }

    const instance = new TestClass();

    // Execute within a trace context
    const result = await tracing.trace(async () => {
      try {
        await instance.makeRequest();
      } catch (e) {
        // Ignore HTTP errors, we're testing trace context propagation
      }

      // Wait for the HTTP queue to finish processing
      await waitForHttpQueue();
    });

    // Verify all events happened
    expect(capturedEvents).toContain('makeRequest');
    expect(capturedEvents).toContain('injectHandler');
    expect(capturedEvents).toContain('nestedRequest');

    // All captured trace IDs should be the same
    expect(capturedTraceIds.length).toBeGreaterThan(0);
    const firstTraceId = capturedTraceIds[0];
    capturedTraceIds.forEach((id) => {
      expect(id).toBe(firstTraceId);
    });

    // All should match the trace result
    expect(firstTraceId).toBe(result.traceId);

    // The requests really went out over the socket, rather than the assertions
    // above passing on a request that never left.
    expect(server.requests).toContain('/get');
    expect(server.requests).toContain('/delay/1');
  });

  it('should capture HTTP events in trace when requests are made in injection handlers', async () => {
    const baseURL = server.baseURL;

    class TestClass {
      @http({ cacheSeconds: 0 })
      async mainRequest(): Promise<HTTPObj> {
        return {
          method: 'GET',
          url: `${baseURL}/status/200`,
          tags: ['main'],
        } as HTTPObj;
      }

      @http({ cacheSeconds: 0 })
      async authRequest(): Promise<HTTPObj> {
        return {
          method: 'GET',
          url: `${baseURL}/status/201`,
          tags: ['auth'],
        } as HTTPObj;
      }

      @inject({
        eventName: 'httpRequest',
        hostname: HOST,
        tags: { $nin: ['auth'] }
      })
      async injectAuth(req: any) {
        // Make auth request - should be captured in same trace
        await this.authRequest();
      }
    }

    const instance = new TestClass();

    const result = await tracing.trace(async () => {
      try {
        await instance.mainRequest();
      } catch (e) {
        // Ignore HTTP errors
      }

      // Wait for the HTTP queue to finish processing
      await waitForHttpQueue();
    });

    // Both requests should be in the trace events (start events at minimum)
    const startEvents = result.events.filter(e => e.eventType === 'http.request.start');
    const urls = startEvents.map(e => e.url);

    expect(urls).toContain(`${baseURL}/status/200`);
    expect(urls).toContain(`${baseURL}/status/201`);

    // All events should have the same trace ID
    expect(result.events.every(e => e.traceId === result.traceId)).toBe(true);
  });
});
