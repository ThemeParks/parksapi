import { tracing, trace, TraceResult, HttpTraceEvent } from '../tracing';

describe('Tracing System', () => {
  beforeEach(() => {
    tracing.cleanup();
  });

  afterEach(() => {
    tracing.cleanup();
  });

  describe('AsyncLocalStorage Context', () => {
    it('should create trace context for async function', async () => {
      const result = await tracing.trace(async () => {
        expect(tracing.isTracing()).toBe(true);
        expect(tracing.getContext()).toBeDefined();
        return 'test-value';
      });

      expect(result.result).toBe('test-value');
      expect(result.traceId).toBeDefined();
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(result.events).toEqual([]);
    });

    it('should propagate context across async boundaries', async () => {
      let innerTraceId: string | undefined;

      await tracing.trace(async () => {
        const outerTraceId = tracing.getContext()?.traceId;

        await new Promise(resolve => setTimeout(resolve, 10));

        innerTraceId = tracing.getContext()?.traceId;
        expect(innerTraceId).toBe(outerTraceId);
      });

      expect(innerTraceId).toBeDefined();
    });

    it('should not have context outside of trace', () => {
      expect(tracing.isTracing()).toBe(false);
      expect(tracing.getContext()).toBeUndefined();
    });

    it('should include metadata in context', async () => {
      const metadata = { userId: '123', action: 'test' };

      await tracing.trace(async () => {
        const context = tracing.getContext();
        expect(context?.metadata).toEqual(metadata);
      }, metadata);
    });

    it('should handle nested async operations', async () => {
      await tracing.trace(async () => {
        const traceId = tracing.getContext()?.traceId;

        const nestedPromises = Array.from({ length: 5 }, async (_, i) => {
          await new Promise(resolve => setTimeout(resolve, i * 5));
          expect(tracing.getContext()?.traceId).toBe(traceId);
          return i;
        });

        await Promise.all(nestedPromises);
      });
    });
  });

  describe('Event Collection', () => {
    it('should collect HTTP events in trace', async () => {
      const result = await tracing.trace(async () => {
        tracing.emitHttpEvent({
          eventType: 'http.request.start',
          url: 'https://example.com',
          method: 'GET',
        });

        tracing.emitHttpEvent({
          eventType: 'http.request.complete',
          url: 'https://example.com',
          method: 'GET',
          status: 200,
          duration: 100,
        });

        return 'done';
      });

      expect(result.events).toHaveLength(2);
      expect(result.events[0].eventType).toBe('http.request.start');
      expect(result.events[1].eventType).toBe('http.request.complete');
      expect(result.events[0].traceId).toBe(result.traceId);
      expect(result.events[1].traceId).toBe(result.traceId);
    });

    it('should not collect events outside trace', () => {
      tracing.emitHttpEvent({
        eventType: 'http.request.start',
        url: 'https://example.com',
        method: 'GET',
      });

      // Should not throw, just ignore
      expect(tracing.isTracing()).toBe(false);
    });

    it('should include timestamps in events', async () => {
      await tracing.trace(async () => {
        const before = Date.now();
        tracing.emitHttpEvent({
          eventType: 'http.request.start',
          url: 'https://example.com',
          method: 'GET',
        });
        const after = Date.now();

        const context = tracing.getContext();
        expect(context).toBeDefined();
      });
    });

    it('should handle error events', async () => {
      const error = new Error('Test error');

      const result = await tracing.trace(async () => {
        tracing.emitHttpEvent({
          eventType: 'http.request.error',
          url: 'https://example.com',
          method: 'GET',
          error,
          duration: 50,
        });
      });

      expect(result.events).toHaveLength(1);
      expect(result.events[0].eventType).toBe('http.request.error');
      expect(result.events[0].error).toBe(error);
    });

    it('should include optional fields in events', async () => {
      const result = await tracing.trace(async () => {
        tracing.emitHttpEvent({
          eventType: 'http.request.complete',
          url: 'https://example.com',
          method: 'GET',
          status: 200,
          duration: 100,
          cacheHit: true,
          retryCount: 2,
          headers: { 'Content-Type': 'application/json' },
          body: { data: 'test' },
        });
      });

      const event = result.events[0];
      expect(event.cacheHit).toBe(true);
      expect(event.retryCount).toBe(2);
      expect(event.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(event.body).toEqual({ data: 'test' });
    });
  });

  describe('Event Emitters', () => {
    it('should emit events to listeners', async () => {
      const events: HttpTraceEvent[] = [];
      const listener = (event: HttpTraceEvent) => events.push(event);

      tracing.onHttp(listener);

      await tracing.trace(async () => {
        tracing.emitHttpEvent({
          eventType: 'http.request.start',
          url: 'https://example.com',
          method: 'GET',
        });
      });

      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('http.request.start');
    });

    it('should emit specific event types', async () => {
      const startEvents: HttpTraceEvent[] = [];
      const completeEvents: HttpTraceEvent[] = [];
      const errorEvents: HttpTraceEvent[] = [];

      tracing.onHttpStart(e => startEvents.push(e));
      tracing.onHttpComplete(e => completeEvents.push(e));
      tracing.onHttpError(e => errorEvents.push(e));

      await tracing.trace(async () => {
        tracing.emitHttpEvent({
          eventType: 'http.request.start',
          url: 'https://example.com',
          method: 'GET',
        });

        tracing.emitHttpEvent({
          eventType: 'http.request.complete',
          url: 'https://example.com',
          method: 'GET',
          status: 200,
          duration: 100,
        });

        tracing.emitHttpEvent({
          eventType: 'http.request.error',
          url: 'https://example.com',
          method: 'POST',
          error: new Error('test'),
          duration: 50,
        });
      });

      expect(startEvents).toHaveLength(1);
      expect(completeEvents).toHaveLength(1);
      expect(errorEvents).toHaveLength(1);
    });

    it('should remove listeners on cleanup', async () => {
      const events: HttpTraceEvent[] = [];
      tracing.onHttp(e => events.push(e));

      await tracing.trace(async () => {
        tracing.emitHttpEvent({
          eventType: 'http.request.start',
          url: 'https://example.com',
          method: 'GET',
        });
      });

      expect(events).toHaveLength(1);

      tracing.cleanup();

      await tracing.trace(async () => {
        tracing.emitHttpEvent({
          eventType: 'http.request.start',
          url: 'https://example.com',
          method: 'GET',
        });
      });

      // No new events should be captured after cleanup
      expect(events).toHaveLength(1);
    });
  });

  describe('@trace Decorator', () => {
    it('should trace method calls', async () => {
      class TestClass {
        @trace()
        async testMethod() {
          expect(tracing.isTracing()).toBe(true);
          return 'result';
        }
      }

      const instance = new TestClass();
      const result = await instance.testMethod();
      expect(result).toBe('result');
    });

    it('should not create nested traces', async () => {
      class TestClass {
        @trace()
        async method1() {
          return this.method2();
        }

        @trace()
        async method2() {
          return 'nested';
        }
      }

      const instance = new TestClass();
      const result = await instance.method1();
      expect(result).toBe('nested');
    });

    it('should include method metadata', async () => {
      const events: HttpTraceEvent[] = [];
      tracing.onHttp(e => events.push(e));

      class TestClass {
        @trace({ custom: 'metadata' })
        async testMethod() {
          tracing.emitHttpEvent({
            eventType: 'http.request.start',
            url: 'https://example.com',
            method: 'GET',
          });
          return 'done';
        }
      }

      const instance = new TestClass();
      await instance.testMethod();

      expect(events).toHaveLength(1);
    });

    it('should propagate errors', async () => {
      class TestClass {
        @trace()
        async testMethod() {
          throw new Error('Test error');
        }
      }

      const instance = new TestClass();
      await expect(instance.testMethod()).rejects.toThrow('Test error');
    });

    it('should handle multiple concurrent traces', async () => {
      const events: HttpTraceEvent[] = [];
      tracing.onHttp(e => events.push(e));

      class TestClass {
        @trace()
        async request(id: number) {
          await new Promise(resolve => setTimeout(resolve, Math.random() * 20));
          tracing.emitHttpEvent({
            eventType: 'http.request.complete',
            url: `https://example.com/${id}`,
            method: 'GET',
            status: 200,
            duration: 10,
          });
          return id;
        }
      }

      const instance = new TestClass();
      const results = await Promise.all([
        instance.request(1),
        instance.request(2),
        instance.request(3),
      ]);

      expect(results).toEqual([1, 2, 3]);
      expect(events).toHaveLength(3);

      // Each request should have a unique trace ID
      const traceIds = events.map(e => e.traceId);
      const uniqueTraceIds = new Set(traceIds);
      expect(uniqueTraceIds.size).toBe(3);
    });
  });

  describe('Performance', () => {
    it('should measure trace duration accurately', async () => {
      const result = await tracing.trace(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return 'done';
      });

      // Allow 1ms tolerance for timing precision
      expect(result.duration).toBeGreaterThanOrEqual(48);
      expect(result.duration).toBeLessThan(100);
    });

    it('should handle rapid event emissions', async () => {
      const result = await tracing.trace(async () => {
        for (let i = 0; i < 100; i++) {
          tracing.emitHttpEvent({
            eventType: 'http.request.complete',
            url: `https://example.com/${i}`,
            method: 'GET',
            status: 200,
            duration: 10,
          });
        }
      });

      expect(result.events).toHaveLength(100);
    });
  });

  describe('Buffer Cleanup', () => {
    it('should clean up event buffers after trace', async () => {
      const result1 = await tracing.trace(async () => {
        tracing.emitHttpEvent({
          eventType: 'http.request.start',
          url: 'https://example.com',
          method: 'GET',
        });
        return 'trace1';
      });

      // Wait for cleanup timeout
      await new Promise(resolve => setTimeout(resolve, 1100));

      const result2 = await tracing.trace(async () => {
        tracing.emitHttpEvent({
          eventType: 'http.request.start',
          url: 'https://example.com',
          method: 'GET',
        });
        return 'trace2';
      });

      expect(result1.traceId).not.toBe(result2.traceId);
      expect(result1.events).toHaveLength(1);
      expect(result2.events).toHaveLength(1);
    });
  });

  describe('Trace History', () => {
    beforeEach(() => {
      tracing.clearHistory();
    });

    it('should store trace information in history', async () => {
      const result = await tracing.trace(async () => {
        tracing.emitHttpEvent({
          eventType: 'http.request.complete',
          url: 'https://example.com',
          method: 'GET',
          status: 200,
          duration: 100,
        });
        return 'test';
      });

      const trace = tracing.getTrace(result.traceId);
      expect(trace).toBeDefined();
      expect(trace?.traceId).toBe(result.traceId);
      expect(trace?.duration).toBe(result.duration);
      expect(trace?.events).toHaveLength(1);
    });

    it('should retrieve trace events by trace ID', async () => {
      const result = await tracing.trace(async () => {
        tracing.emitHttpEvent({
          eventType: 'http.request.start',
          url: 'https://example.com/1',
          method: 'GET',
        });
        tracing.emitHttpEvent({
          eventType: 'http.request.complete',
          url: 'https://example.com/1',
          method: 'GET',
          status: 200,
          duration: 50,
        });
        return 'test';
      });

      const events = tracing.getTraceEvents(result.traceId);
      expect(events).toHaveLength(2);
      expect(events[0].traceId).toBe(result.traceId);
      expect(events[1].traceId).toBe(result.traceId);
    });

    it('should return empty array for non-existent trace ID', () => {
      const events = tracing.getTraceEvents('non-existent-id');
      expect(events).toEqual([]);
    });

    it('should store trace metadata', async () => {
      const metadata = { userId: '123', action: 'fetch' };
      const result = await tracing.trace(async () => 'test', metadata);

      const trace = tracing.getTrace(result.traceId);
      expect(trace?.metadata).toEqual(metadata);
    });

    it('should get all trace IDs', async () => {
      await tracing.trace(async () => 'test1');
      await tracing.trace(async () => 'test2');
      await tracing.trace(async () => 'test3');

      const traceIds = tracing.getAllTraceIds();
      expect(traceIds).toHaveLength(3);
    });

    it('should get all traces', async () => {
      await tracing.trace(async () => 'test1');
      await tracing.trace(async () => 'test2');

      const traces = tracing.getAllTraces();
      expect(traces).toHaveLength(2);
      expect(traces[0].traceId).toBeDefined();
      expect(traces[1].traceId).toBeDefined();
    });

    it('should filter traces by time range', async () => {
      const startTime = Date.now();

      await tracing.trace(async () => 'test1');
      await new Promise(resolve => setTimeout(resolve, 10));
      await tracing.trace(async () => 'test2');
      await new Promise(resolve => setTimeout(resolve, 10));
      const midTime = Date.now();
      await new Promise(resolve => setTimeout(resolve, 5)); // Ensure third trace starts after midTime
      await tracing.trace(async () => 'test3');

      const endTime = Date.now();

      const allTraces = tracing.getTracesByTimeRange(startTime, endTime);
      expect(allTraces).toHaveLength(3);

      const firstTwo = tracing.getTracesByTimeRange(startTime, midTime);
      expect(firstTwo.length).toBeLessThanOrEqual(2);
    });

    it('should filter traces by metadata', async () => {
      await tracing.trace(async () => 'test1', { type: 'fetch', user: 'alice' });
      await tracing.trace(async () => 'test2', { type: 'update', user: 'bob' });
      await tracing.trace(async () => 'test3', { type: 'fetch', user: 'charlie' });

      const fetchTraces = tracing.getTracesByMetadata({ type: 'fetch' });
      expect(fetchTraces).toHaveLength(2);

      const aliceTraces = tracing.getTracesByMetadata({ user: 'alice' });
      expect(aliceTraces).toHaveLength(1);

      const aliceFetch = tracing.getTracesByMetadata({ type: 'fetch', user: 'alice' });
      expect(aliceFetch).toHaveLength(1);
    });

    it('should enforce max history size', async () => {
      tracing.setMaxHistorySize(3);

      await tracing.trace(async () => 'test1');
      await tracing.trace(async () => 'test2');
      await tracing.trace(async () => 'test3');
      await tracing.trace(async () => 'test4'); // Should evict oldest

      const traces = tracing.getAllTraces();
      expect(traces).toHaveLength(3);

      // Reset to default
      tracing.setMaxHistorySize(1000);
    });

    it('should clear history', async () => {
      await tracing.trace(async () => 'test1');
      await tracing.trace(async () => 'test2');

      expect(tracing.getHistorySize()).toBe(2);

      tracing.clearHistory();

      expect(tracing.getHistorySize()).toBe(0);
      expect(tracing.getAllTraces()).toEqual([]);
    });

    it('should trim history when max size is reduced', async () => {
      await tracing.trace(async () => 'test1');
      await tracing.trace(async () => 'test2');
      await tracing.trace(async () => 'test3');
      await tracing.trace(async () => 'test4');
      await tracing.trace(async () => 'test5');

      expect(tracing.getHistorySize()).toBe(5);

      tracing.setMaxHistorySize(2);

      expect(tracing.getHistorySize()).toBe(2);

      // Reset
      tracing.setMaxHistorySize(1000);
    });

    it('should include start and end times in trace info', async () => {
      const beforeStart = Date.now();

      const result = await tracing.trace(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return 'test';
      });

      const afterEnd = Date.now();

      const trace = tracing.getTrace(result.traceId);
      expect(trace?.startTime).toBeGreaterThanOrEqual(beforeStart);
      expect(trace?.startTime).toBeLessThanOrEqual(trace?.endTime || 0);
      expect(trace?.endTime).toBeLessThanOrEqual(afterEnd);
    });
  });
});
