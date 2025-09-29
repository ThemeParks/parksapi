import { inject, broadcast, registerInstance } from '../injector';

describe('Injector System', () => {
  beforeEach(() => {
    // Clear any global state if needed
    // Note: In a real implementation, we might need to expose a way to clear registries for testing
  });

  describe('Function Injection', () => {
    it('should call injected function when event matches filter', async () => {
      const mockFn = jest.fn();
      const filter = { eventName: 'testEvent' };

      inject(filter)(mockFn);

      await broadcast('global', { eventName: 'testEvent' }, 'arg1', 'arg2');

      expect(mockFn).toHaveBeenCalledWith('arg1', 'arg2');
    });

    it('should not call injected function when event does not match filter', async () => {
      const mockFn = jest.fn();
      const filter = { eventName: 'testEvent' };

      inject(filter)(mockFn);

      await broadcast('global', { eventName: 'otherEvent' }, 'arg1');

      expect(mockFn).not.toHaveBeenCalled();
    });

    it('should call injected function with complex filter matching', async () => {
      const mockFn = jest.fn();
      const filter = { eventName: 'httpRequest', hostname: 'api.themeparks.wiki' };

      inject(filter)(mockFn);

      await broadcast('global', { eventName: 'httpRequest', hostname: 'api.themeparks.wiki' }, 'data');

      expect(mockFn).toHaveBeenCalledWith('data');
    });

    it('should not call injected function with complex filter not matching', async () => {
      const mockFn = jest.fn();
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

      const spy = jest.spyOn(instance, 'testMethod');

      await broadcast('global', { eventName: 'methodEvent' }, 'testArg');

      expect(spy).toHaveBeenCalledWith('testArg');
    });

    it('should not call injected method when event does not match', async () => {
      const instance = new TestClass();
      registerInstance(instance);

      const spy = jest.spyOn(instance, 'testMethod');

      await broadcast('global', { eventName: 'otherEvent' }, 'testArg');

      expect(spy).not.toHaveBeenCalled();
    });

    it('should call injected method on specific instance', async () => {
      const instance1 = new TestClass();
      const instance2 = new TestClass();

      const spy1 = jest.spyOn(instance1, 'testMethod');
      const spy2 = jest.spyOn(instance2, 'testMethod');

      await broadcast(instance1, { eventName: 'methodEvent' }, 'testArg');

      expect(spy1).toHaveBeenCalledWith('testArg');
      expect(spy2).not.toHaveBeenCalled();
    });

    it('should call injected method on array of instances', async () => {
      const instance1 = new TestClass();
      const instance2 = new TestClass();

      const spy1 = jest.spyOn(instance1, 'testMethod');
      const spy2 = jest.spyOn(instance2, 'testMethod');

      await broadcast([instance1, instance2], { eventName: 'methodEvent' }, 'testArg');

      expect(spy1).toHaveBeenCalledWith('testArg');
      expect(spy2).toHaveBeenCalledWith('testArg');
    });
  });

  describe('Mixed Injections', () => {
    it('should call both global functions and methods for global broadcast', async () => {
      const mockFn = jest.fn();
      inject({ eventName: 'mixedEvent' })(mockFn);

      class TestClass {
        @inject({ eventName: 'mixedEvent' })
        async testMethod(arg: string) {}
      }

      const instance = new TestClass();
      registerInstance(instance);

      const spy = jest.spyOn(instance, 'testMethod');

      await broadcast('global', { eventName: 'mixedEvent' }, 'arg');

      expect(mockFn).toHaveBeenCalledWith('arg');
      expect(spy).toHaveBeenCalledWith('arg');
    });
  });

  describe('Multiple Injections', () => {
    it('should call all matching injections', async () => {
      const mockFn1 = jest.fn();
      const mockFn2 = jest.fn();

      inject({ eventName: 'multiEvent' })(mockFn1);
      inject({ eventName: 'multiEvent' })(mockFn2);

      await broadcast('global', { eventName: 'multiEvent' }, 'arg');

      expect(mockFn1).toHaveBeenCalledWith('arg');
      expect(mockFn2).toHaveBeenCalledWith('arg');
    });

    it('should handle different filters correctly', async () => {
      const mockFn1 = jest.fn();
      const mockFn2 = jest.fn();

      inject({ eventName: 'event1' })(mockFn1);
      inject({ eventName: 'event2' })(mockFn2);

      await broadcast('global', { eventName: 'event1' }, 'arg');

      expect(mockFn1).toHaveBeenCalledWith('arg');
      expect(mockFn2).not.toHaveBeenCalled();
    });
  });
});