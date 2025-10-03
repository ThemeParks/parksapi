import { reusable, getActivePromiseCount, clearActivePromises } from '../promiseReuse';

describe('Promise Reuse Decorator', () => {
  beforeEach(() => {
    // Clear any active promises before each test
    clearActivePromises();
  });

  afterEach(() => {
    // Cleanup after each test
    clearActivePromises();
  });

  describe('Basic Reuse', () => {
    it('should reuse promise while pending', async () => {
      let callCount = 0;

      class TestClass {
        @reusable()
        async fetchData() {
          callCount++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return 'data';
        }
      }

      const instance = new TestClass();

      // Make multiple calls while promise is pending
      const promise1 = instance.fetchData();
      const promise2 = instance.fetchData();
      const promise3 = instance.fetchData();

      // Should be the same promise instance
      expect(promise1).toBe(promise2);
      expect(promise2).toBe(promise3);

      // Wait for all to complete
      const results = await Promise.all([promise1, promise2, promise3]);

      // Should have only been called once
      expect(callCount).toBe(1);
      expect(results).toEqual(['data', 'data', 'data']);
    });

    it('should create new promise after previous one resolves', async () => {
      let callCount = 0;

      class TestClass {
        @reusable()
        async fetchData() {
          callCount++;
          return `data-${callCount}`;
        }
      }

      const instance = new TestClass();

      // First call
      const result1 = await instance.fetchData();
      expect(result1).toBe('data-1');
      expect(callCount).toBe(1);

      // Second call (should create new promise)
      const result2 = await instance.fetchData();
      expect(result2).toBe('data-2');
      expect(callCount).toBe(2);
    });

    it('should track different instances separately', async () => {
      let callCount = 0;

      class TestClass {
        @reusable()
        async fetchData() {
          callCount++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return 'data';
        }
      }

      const instance1 = new TestClass();
      const instance2 = new TestClass();

      // Make calls on both instances
      const promise1 = instance1.fetchData();
      const promise2 = instance2.fetchData();

      // Should be different promises (different instances)
      expect(promise1).not.toBe(promise2);

      await Promise.all([promise1, promise2]);

      // Should have been called twice (once per instance)
      expect(callCount).toBe(2);
    });

    it('should cleanup active promises after resolution', async () => {
      class TestClass {
        @reusable()
        async fetchData() {
          return 'data';
        }
      }

      const instance = new TestClass();

      expect(getActivePromiseCount()).toBe(0);

      const promise = instance.fetchData();
      expect(getActivePromiseCount()).toBe(1);

      await promise;
      expect(getActivePromiseCount()).toBe(0);
    });
  });

  describe('Forever Mode', () => {
    it('should cache result forever', async () => {
      let callCount = 0;

      class TestClass {
        @reusable({forever: true})
        async init() {
          callCount++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return 'initialized';
        }
      }

      const instance = new TestClass();

      // First call
      const result1 = await instance.init();
      expect(result1).toBe('initialized');
      expect(callCount).toBe(1);

      // Subsequent calls should return cached value without executing
      const result2 = await instance.init();
      expect(result2).toBe('initialized');
      expect(callCount).toBe(1);

      const result3 = await instance.init();
      expect(result3).toBe('initialized');
      expect(callCount).toBe(1);
    });

    it('should reuse promise while pending in forever mode', async () => {
      let callCount = 0;

      class TestClass {
        @reusable({forever: true})
        async init() {
          callCount++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return 'initialized';
        }
      }

      const instance = new TestClass();

      // Make multiple calls while pending
      const promise1 = instance.init();
      const promise2 = instance.init();
      const promise3 = instance.init();

      // Should be the same promise
      expect(promise1).toBe(promise2);
      expect(promise2).toBe(promise3);

      await Promise.all([promise1, promise2, promise3]);

      // Should have only been called once
      expect(callCount).toBe(1);
    });

    it('should not cleanup active promises in forever mode', async () => {
      class TestClass {
        @reusable({forever: true})
        async init() {
          return 'initialized';
        }
      }

      const instance = new TestClass();

      expect(getActivePromiseCount()).toBe(0);

      await instance.init();

      // Should still have entry (cached forever)
      expect(getActivePromiseCount()).toBe(1);
    });
  });

  describe('Arguments', () => {
    it('should reuse promises with same arguments', async () => {
      let callCount = 0;

      class TestClass {
        @reusable()
        async fetchById(id: number) {
          callCount++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return `data-${id}`;
        }
      }

      const instance = new TestClass();

      // Make multiple calls with same argument
      const promise1 = instance.fetchById(1);
      const promise2 = instance.fetchById(1);
      const promise3 = instance.fetchById(1);

      // Should be the same promise
      expect(promise1).toBe(promise2);
      expect(promise2).toBe(promise3);

      const results = await Promise.all([promise1, promise2, promise3]);

      expect(callCount).toBe(1);
      expect(results).toEqual(['data-1', 'data-1', 'data-1']);
    });

    it('should create different promises for different arguments', async () => {
      let callCount = 0;

      class TestClass {
        @reusable()
        async fetchById(id: number) {
          callCount++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return `data-${id}`;
        }
      }

      const instance = new TestClass();

      // Make calls with different arguments
      const promise1 = instance.fetchById(1);
      const promise2 = instance.fetchById(2);
      const promise3 = instance.fetchById(3);

      // Should be different promises
      expect(promise1).not.toBe(promise2);
      expect(promise2).not.toBe(promise3);

      const results = await Promise.all([promise1, promise2, promise3]);

      expect(callCount).toBe(3);
      expect(results).toEqual(['data-1', 'data-2', 'data-3']);
    });

    it('should handle multiple arguments', async () => {
      let callCount = 0;

      class TestClass {
        @reusable()
        async fetchData(id: number, type: string) {
          callCount++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return `${type}-${id}`;
        }
      }

      const instance = new TestClass();

      // Same arguments
      const promise1 = instance.fetchData(1, 'user');
      const promise2 = instance.fetchData(1, 'user');
      expect(promise1).toBe(promise2);

      // Different arguments
      const promise3 = instance.fetchData(1, 'admin');
      expect(promise1).not.toBe(promise3);

      await Promise.all([promise1, promise2, promise3]);

      expect(callCount).toBe(2);
    });

    it('should handle complex object arguments', async () => {
      let callCount = 0;

      class TestClass {
        @reusable()
        async fetchData(options: {id: number; filter?: string}) {
          callCount++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return `data-${options.id}`;
        }
      }

      const instance = new TestClass();

      // Same object structure
      const promise1 = instance.fetchData({id: 1, filter: 'active'});
      const promise2 = instance.fetchData({id: 1, filter: 'active'});
      expect(promise1).toBe(promise2);

      // Different object structure
      const promise3 = instance.fetchData({id: 1, filter: 'inactive'});
      expect(promise1).not.toBe(promise3);

      await Promise.all([promise1, promise2, promise3]);

      expect(callCount).toBe(2);
    });
  });

  describe('Error Handling', () => {
    it('should cleanup on error', async () => {
      let callCount = 0;

      class TestClass {
        @reusable()
        async fetchData() {
          callCount++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error('Fetch failed');
        }
      }

      const instance = new TestClass();

      expect(getActivePromiseCount()).toBe(0);

      try {
        await instance.fetchData();
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toBe('Fetch failed');
      }

      // Wait a tick for cleanup to complete
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Should have cleaned up
      expect(getActivePromiseCount()).toBe(0);
      expect(callCount).toBe(1);

      // Next call should try again
      try {
        await instance.fetchData();
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toBe('Fetch failed');
      }

      expect(callCount).toBe(2);
    });

    it('should cleanup on error even in forever mode', async () => {
      let callCount = 0;

      class TestClass {
        @reusable({forever: true})
        async init() {
          callCount++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error('Init failed');
        }
      }

      const instance = new TestClass();

      try {
        await instance.init();
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toBe('Init failed');
      }

      // Wait a tick for cleanup to complete
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Should have cleaned up (even in forever mode, errors don't cache)
      expect(getActivePromiseCount()).toBe(0);

      // Should be able to retry
      try {
        await instance.init();
        fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toBe('Init failed');
      }

      expect(callCount).toBe(2);
    });

    it('should propagate errors to all waiters', async () => {
      let callCount = 0;

      class TestClass {
        @reusable()
        async fetchData() {
          callCount++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error('Fetch failed');
        }
      }

      const instance = new TestClass();

      // Make multiple calls that will all fail
      const promise1 = instance.fetchData();
      const promise2 = instance.fetchData();
      const promise3 = instance.fetchData();

      // All should receive the error
      await expect(promise1).rejects.toThrow('Fetch failed');
      await expect(promise2).rejects.toThrow('Fetch failed');
      await expect(promise3).rejects.toThrow('Fetch failed');

      // Should have only called once
      expect(callCount).toBe(1);
    });
  });

  describe('Real-World Scenarios', () => {
    it('should work like database init pattern', async () => {
      let initCount = 0;
      const events: string[] = [];

      class Database {
        private isInitialized = false;

        @reusable({forever: true})
        async init() {
          initCount++;
          events.push('init-start');
          await new Promise((resolve) => setTimeout(resolve, 50));
          this.isInitialized = true;
          events.push('init-complete');
          return true;
        }

        async query(sql: string) {
          await this.init(); // Always call init, but it only runs once
          return `result for ${sql}`;
        }
      }

      const db = new Database();

      // Multiple queries that all try to init
      const results = await Promise.all([
        db.query('SELECT * FROM users'),
        db.query('SELECT * FROM posts'),
        db.query('SELECT * FROM comments'),
      ]);

      // Init should have only run once
      expect(initCount).toBe(1);
      expect(events).toEqual(['init-start', 'init-complete']);
      expect(results).toEqual([
        'result for SELECT * FROM users',
        'result for SELECT * FROM posts',
        'result for SELECT * FROM comments',
      ]);
    });

    it('should work for temporary data fetching', async () => {
      let fetchCount = 0;

      class DataService {
        @reusable()
        async fetchUserData(userId: number) {
          fetchCount++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {id: userId, name: `User ${userId}`};
        }
      }

      const service = new DataService();

      // Multiple components requesting same user simultaneously
      const promise1 = service.fetchUserData(1);
      const promise2 = service.fetchUserData(1);
      const promise3 = service.fetchUserData(1);

      const results = await Promise.all([promise1, promise2, promise3]);

      // Should have only fetched once
      expect(fetchCount).toBe(1);
      expect(results).toEqual([
        {id: 1, name: 'User 1'},
        {id: 1, name: 'User 1'},
        {id: 1, name: 'User 1'},
      ]);

      // Subsequent call after resolution should fetch again
      await service.fetchUserData(1);
      expect(fetchCount).toBe(2);
    });
  });
});
