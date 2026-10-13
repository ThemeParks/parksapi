import { inject, broadcast, registerInstance } from '../injector.js';

describe('Injector System', () => {
  beforeEach(() => {
    // Clear any global state if needed
    // Note: In a real implementation, we might need to expose a way to clear registries for testing
  });

  describe('Function Injection', () => {
    it('should call injected function when event matches filter', async () => {
      const mockFn = vi.fn();
      const filter = { eventName: 'testEvent' };

      inject(filter)(mockFn);

      await broadcast('global', { eventName: 'testEvent' }, 'arg1', 'arg2');

      expect(mockFn).toHaveBeenCalledWith('arg1', 'arg2');
    });

    it('should not call injected function when event does not match filter', async () => {
      const mockFn = vi.fn();
      const filter = { eventName: 'testEvent' };

      inject(filter)(mockFn);

      await broadcast('global', { eventName: 'otherEvent' }, 'arg1');

      expect(mockFn).not.toHaveBeenCalled();
    });

    it('should call injected function with complex filter matching', async () => {
      const mockFn = vi.fn();
      const filter = { eventName: 'httpRequest', hostname: 'api.themeparks.wiki' };

      inject(filter)(mockFn);

      await broadcast('global', { eventName: 'httpRequest', hostname: 'api.themeparks.wiki' }, 'data');

      expect(mockFn).toHaveBeenCalledWith('data');
    });

    it('should not call injected function with complex filter not matching', async () => {
      const mockFn = vi.fn();
      const filter = { eventName: 'httpRequest', hostname: 'api.themeparks.wiki' };

      inject(filter)(mockFn);

      await broadcast('global', { eventName: 'httpRequest', hostname: 'other.host' }, 'data');

      expect(mockFn).not.toHaveBeenCalled();
    });
  });

  describe('Method Injection', () => {
    class TestClass {
      @inject({ eventName: 'methodEvent' })
      async testMethod(arg: string) {
        return `processed ${arg}`;
      }
    }

    it('should call injected method on registered instance for global broadcast', async () => {
      const instance = new TestClass();
      registerInstance(instance);

      const spy = vi.spyOn(instance, 'testMethod');

      await broadcast('global', { eventName: 'methodEvent' }, 'testArg');

      expect(spy).toHaveBeenCalledWith('testArg');
    });

    it('should not call injected method when event does not match', async () => {
      const instance = new TestClass();
      registerInstance(instance);

      const spy = vi.spyOn(instance, 'testMethod');

      await broadcast('global', { eventName: 'otherEvent' }, 'testArg');

      expect(spy).not.toHaveBeenCalled();
    });

    it('should call injected method on specific instance', async () => {
      const instance1 = new TestClass();
      const instance2 = new TestClass();

      const spy1 = vi.spyOn(instance1, 'testMethod');
      const spy2 = vi.spyOn(instance2, 'testMethod');

      await broadcast(instance1, { eventName: 'methodEvent' }, 'testArg');

      expect(spy1).toHaveBeenCalledWith('testArg');
      expect(spy2).not.toHaveBeenCalled();
    });

    it('should call injected method on array of instances', async () => {
      const instance1 = new TestClass();
      const instance2 = new TestClass();

      const spy1 = vi.spyOn(instance1, 'testMethod');
      const spy2 = vi.spyOn(instance2, 'testMethod');

      await broadcast([instance1, instance2], { eventName: 'methodEvent' }, 'testArg');

      expect(spy1).toHaveBeenCalledWith('testArg');
      expect(spy2).toHaveBeenCalledWith('testArg');
    });
  });

  describe('Mixed Injections', () => {
    it('should call both global functions and methods for global broadcast', async () => {
      const mockFn = vi.fn();
      inject({ eventName: 'mixedEvent' })(mockFn);

      class TestClass {
        @inject({ eventName: 'mixedEvent' })
        async testMethod(arg: string) {}
      }

      const instance = new TestClass();
      registerInstance(instance);

      const spy = vi.spyOn(instance, 'testMethod');

      await broadcast('global', { eventName: 'mixedEvent' }, 'arg');

      expect(mockFn).toHaveBeenCalledWith('arg');
      expect(spy).toHaveBeenCalledWith('arg');
    });
  });

  describe('Multiple Injections', () => {
    it('should call all matching injections', async () => {
      const mockFn1 = vi.fn();
      const mockFn2 = vi.fn();

      inject({ eventName: 'multiEvent' })(mockFn1);
      inject({ eventName: 'multiEvent' })(mockFn2);

      await broadcast('global', { eventName: 'multiEvent' }, 'arg');

      expect(mockFn1).toHaveBeenCalledWith('arg');
      expect(mockFn2).toHaveBeenCalledWith('arg');
    });

    it('should handle different filters correctly', async () => {
      const mockFn1 = vi.fn();
      const mockFn2 = vi.fn();

      inject({ eventName: 'event1' })(mockFn1);
      inject({ eventName: 'event2' })(mockFn2);

      await broadcast('global', { eventName: 'event1' }, 'arg');

      expect(mockFn1).toHaveBeenCalledWith('arg');
      expect(mockFn2).not.toHaveBeenCalled();
    });

    it('should call multiple methods on same class matching same event', async () => {
      const callOrder: string[] = [];

      class MultiTransformer {
        @inject({ eventName: 'httpResponse' })
        async transform1(data: any) {
          callOrder.push('transform1');
          data.transformed1 = true;
        }

        @inject({ eventName: 'httpResponse' })
        async transform2(data: any) {
          callOrder.push('transform2');
          data.transformed2 = true;
        }

        @inject({ eventName: 'httpResponse' })
        async transform3(data: any) {
          callOrder.push('transform3');
          data.transformed3 = true;
        }
      }

      const instance = new MultiTransformer();
      const data = { value: 'test' };

      await broadcast(instance, { eventName: 'httpResponse' }, data);

      expect(data).toEqual({
        value: 'test',
        transformed1: true,
        transformed2: true,
        transformed3: true,
      });
      expect(callOrder).toHaveLength(3);
      expect(callOrder).toContain('transform1');
      expect(callOrder).toContain('transform2');
      expect(callOrder).toContain('transform3');
    });

    it('should support priority ordering for multiple methods', async () => {
      const callOrder: string[] = [];

      class PriorityTransformer {
        @inject({ eventName: 'httpResponse', priority: 10 })
        async lowPriority(data: any) {
          callOrder.push('low');
        }

        @inject({ eventName: 'httpResponse', priority: 1 })
        async highPriority(data: any) {
          callOrder.push('high');
        }

        @inject({ eventName: 'httpResponse', priority: 5 })
        async mediumPriority(data: any) {
          callOrder.push('medium');
        }
      }

      const instance = new PriorityTransformer();
      const data = { value: 'test' };

      await broadcast(instance, { eventName: 'httpResponse' }, data);

      // Should be called in priority order: high (1) -> medium (5) -> low (10)
      expect(callOrder).toEqual(['high', 'medium', 'low']);
    });

    it('should handle methods without priority (default to 0)', async () => {
      const callOrder: string[] = [];

      class MixedPriorityTransformer {
        @inject({ eventName: 'httpResponse' })
        async noPriority(data: any) {
          callOrder.push('noPriority');
        }

        @inject({ eventName: 'httpResponse', priority: 5 })
        async withPriority(data: any) {
          callOrder.push('withPriority');
        }
      }

      const instance = new MixedPriorityTransformer();
      const data = { value: 'test' };

      await broadcast(instance, { eventName: 'httpResponse' }, data);

      // noPriority has default priority 0, withPriority has 5
      // Should be called: noPriority (0) -> withPriority (5)
      expect(callOrder).toEqual(['noPriority', 'withPriority']);
    });
  });

  describe('Dynamic Filter Resolution', () => {
    it('should resolve function-based filters with instance context', async () => {
      class TestClass {
        baseURL = 'api.example.com';

        @inject({
          eventName: 'httpRequest',
          hostname: function() {
            return this.baseURL;
          }
        })
        async injectMethod(req: any) {
          req.injected = true;
        }
      }

      const instance = new TestClass();
      const spy = vi.spyOn(instance, 'injectMethod');

      await broadcast(instance, { eventName: 'httpRequest', hostname: 'api.example.com' }, { injected: false });

      expect(spy).toHaveBeenCalled();
    });

    it('should not match when dynamic filter resolves to different value', async () => {
      class TestClass {
        baseURL = 'api.example.com';

        @inject({
          eventName: 'httpRequest',
          hostname: function() {
            return this.baseURL;
          }
        })
        async injectMethod(req: any) {
          req.injected = true;
        }
      }

      const instance = new TestClass();
      const spy = vi.spyOn(instance, 'injectMethod');

      await broadcast(instance, { eventName: 'httpRequest', hostname: 'other.example.com' }, { injected: false });

      expect(spy).not.toHaveBeenCalled();
    });

    it('should resolve nested function-based filters', async () => {
      class TestClass {
        allowedDomains = ['example.com', 'test.com'];

        @inject({
          eventName: 'httpRequest',
          hostname: function() {
            return { $in: this.allowedDomains };
          }
        })
        async injectMethod(req: any) {
          req.injected = true;
        }
      }

      const instance = new TestClass();
      const spy = vi.spyOn(instance, 'injectMethod');

      await broadcast(instance, { eventName: 'httpRequest', hostname: 'example.com' }, { injected: false });

      expect(spy).toHaveBeenCalled();
    });

    it('should resolve async function-based filters', async () => {
      class TestClass {
        async getBaseURL() {
          return 'api.example.com';
        }

        @inject({
          eventName: 'httpRequest',
          hostname: async function() {
            return await this.getBaseURL();
          }
        })
        async injectMethod(req: any) {
          req.injected = true;
        }
      }

      const instance = new TestClass();
      const spy = vi.spyOn(instance, 'injectMethod');

      await broadcast(instance, { eventName: 'httpRequest', hostname: 'api.example.com' }, { injected: false });

      expect(spy).toHaveBeenCalled();
    });

    it('should resolve regex patterns from instance properties', async () => {
      class TestClass {
        domainPattern = 'universalorlando\\.com|universalstudios\\.com';

        @inject({
          eventName: 'httpRequest',
          hostname: function() {
            return { $regex: new RegExp(this.domainPattern) };
          }
        })
        async injectMethod(req: any) {
          req.injected = true;
        }
      }

      const instance = new TestClass();
      const spy = vi.spyOn(instance, 'injectMethod');

      await broadcast(instance, { eventName: 'httpRequest', hostname: 'universalorlando.com' }, { injected: false });

      expect(spy).toHaveBeenCalled();

      spy.mockClear();

      await broadcast(instance, { eventName: 'httpRequest', hostname: 'universalstudios.com' }, { injected: false });

      expect(spy).toHaveBeenCalled();
    });

    it('should preserve static filter values alongside dynamic ones', async () => {
      class TestClass {
        baseURL = 'api.example.com';

        @inject({
          eventName: 'httpRequest',
          hostname: function() {
            return this.baseURL;
          },
          tags: { $nin: ['skipAuth'] }
        })
        async injectMethod(req: any) {
          req.injected = true;
        }
      }

      const instance = new TestClass();
      const spy = vi.spyOn(instance, 'injectMethod');

      // Should match when tags don't include 'skipAuth'
      await broadcast(instance, {
        eventName: 'httpRequest',
        hostname: 'api.example.com',
        tags: ['other']
      }, { injected: false });

      expect(spy).toHaveBeenCalled();

      spy.mockClear();

      // Should not match when tags include 'skipAuth'
      await broadcast(instance, {
        eventName: 'httpRequest',
        hostname: 'api.example.com',
        tags: ['skipAuth']
      }, { injected: false });

      expect(spy).not.toHaveBeenCalled();
    });
  });

  // Gate for sift upgrades. These are the filter shapes the parks use to route
  // auth: `tags: {$nin: [...]}`, `tags: {$in: [...]}` and `hostname: {$in: [...]}`.
  // sift 17.1.4 changed how $ne/$in/$nin/$exists behave on paths through arrays,
  // and a wrong match here puts auth headers on the auth request itself, or
  // leaves them off everything else. Expected results are MongoDB semantics,
  // written by hand, never copied from what sift currently returns.
  describe('Production filter shapes', () => {
    class FilterShapes {
      calls: string[] = [];

      @inject({eventName: 'httpRequest', tags: {$nin: ['auth']}})
      async notAuth() { this.calls.push('notAuth'); }

      @inject({eventName: 'httpRequest', tags: {$in: ['auth']}})
      async onlyAuth() { this.calls.push('onlyAuth'); }

      @inject({eventName: 'httpRequest', hostname: {$in: ['a.example.com', 'b.example.com']}})
      async knownHost() { this.calls.push('knownHost'); }

      @inject({eventName: 'httpRequest', hostname: {$in: ['a.example.com', 'b.example.com']}, tags: {$nin: ['auth']}})
      async knownHostNotAuth() { this.calls.push('knownHostNotAuth'); }
    }

    const cases: Array<{name: string; event: Record<string, unknown>; expected: string[]}> = [
      {name: 'tags undefined', event: {hostname: 'other.example.com', tags: undefined}, expected: ['notAuth']},
      {name: 'tags missing', event: {hostname: 'other.example.com'}, expected: ['notAuth']},
      {name: 'tags null', event: {hostname: 'other.example.com', tags: null}, expected: ['notAuth']},
      {name: 'tags empty', event: {hostname: 'other.example.com', tags: []}, expected: ['notAuth']},
      {name: 'only the auth tag', event: {hostname: 'other.example.com', tags: ['auth']}, expected: ['onlyAuth']},
      {name: 'auth among several tags', event: {hostname: 'other.example.com', tags: ['vqueue', 'auth']}, expected: ['onlyAuth']},
      {name: 'auth listed first among several tags', event: {hostname: 'other.example.com', tags: ['auth', 'vqueue']}, expected: ['onlyAuth']},
      {name: 'unrelated tags only', event: {hostname: 'other.example.com', tags: ['vqueue']}, expected: ['notAuth']},
      {name: 'tag that merely contains auth', event: {hostname: 'other.example.com', tags: ['oauth', 'authz']}, expected: ['notAuth']},
      {name: 'known host, no tags', event: {hostname: 'a.example.com', tags: []}, expected: ['notAuth', 'knownHost', 'knownHostNotAuth']},
      {name: 'known host, tags undefined', event: {hostname: 'a.example.com'}, expected: ['notAuth', 'knownHost', 'knownHostNotAuth']},
      {name: 'second known host, unrelated tag', event: {hostname: 'b.example.com', tags: ['x']}, expected: ['notAuth', 'knownHost', 'knownHostNotAuth']},
      {name: 'known host with the auth tag', event: {hostname: 'a.example.com', tags: ['auth']}, expected: ['onlyAuth', 'knownHost']},
      {name: 'hostname missing', event: {tags: []}, expected: ['notAuth']},
      {name: 'hostname only a prefix of a known host', event: {hostname: 'a.example.com.evil.test', tags: []}, expected: ['notAuth']},
      {name: 'hostname is a subdomain of a known host', event: {hostname: 'x.a.example.com', tags: []}, expected: ['notAuth']},
    ];

    it.each(cases)('routes $name', async ({event, expected}) => {
      const instance = new FilterShapes();

      await broadcast(instance, {eventName: 'httpRequest', ...event});

      expect([...instance.calls].sort()).toEqual([...expected].sort());
    });

    it('does not route events with a different eventName, whatever their tags', async () => {
      const instance = new FilterShapes();

      await broadcast(instance, {eventName: 'httpResponse', hostname: 'a.example.com', tags: ['auth']});
      await broadcast(instance, {eventName: 'httpResponse', hostname: 'a.example.com', tags: []});

      expect(instance.calls).toEqual([]);
    });

    it('does not mutate the event while matching', async () => {
      const instance = new FilterShapes();
      const event = {eventName: 'httpRequest', hostname: 'a.example.com', tags: ['vqueue', 'auth']};
      const before = JSON.parse(JSON.stringify(event));

      await broadcast(instance, event);

      expect(event).toEqual(before);
    });
  });
});