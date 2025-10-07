import { tracing } from '../tracing';
import { http, HTTPObj, stopHttpQueue, waitForHttpQueue } from '../http';
import { inject } from '../injector';

describe('Trace Context Propagation', () => {
  afterAll(() => {
    stopHttpQueue();
  });

  it('should propagate trace context through injection handlers', async () => {
    const capturedTraceIds: string[] = [];
    const capturedEvents: string[] = [];

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
          url: 'http://httpbin.org/get',
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
          url: 'http://httpbin.org/delay/1',
          tags: ['nested'],
        } as HTTPObj;
      }

      @inject({
        eventName: 'httpRequest',
        hostname: 'httpbin.org',
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
    capturedTraceIds.forEach((id, index) => {
      expect(id).toBe(firstTraceId);
    });

    // All should match the trace result
    expect(firstTraceId).toBe(result.traceId);
  }, 35000); // Increased timeout to account for external HTTP requests

  it('should capture HTTP events in trace when requests are made in injection handlers', async () => {
    class TestClass {
      @http({ cacheSeconds: 0 })
      async mainRequest(): Promise<HTTPObj> {
        return {
          method: 'GET',
          url: 'http://httpbin.org/status/200',
          tags: ['main'],
        } as HTTPObj;
      }

      @http({ cacheSeconds: 0 })
      async authRequest(): Promise<HTTPObj> {
        return {
          method: 'GET',
          url: 'http://httpbin.org/status/201',
          tags: ['auth'],
        } as HTTPObj;
      }

      @inject({
        eventName: 'httpRequest',
        hostname: 'httpbin.org',
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

    expect(urls).toContain('http://httpbin.org/status/200');
    expect(urls).toContain('http://httpbin.org/status/201');

    // All events should have the same trace ID
    expect(result.events.every(e => e.traceId === result.traceId)).toBe(true);
  }, 35000); // Increased timeout to account for external HTTP requests
});
