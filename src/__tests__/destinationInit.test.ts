/**
 * Test Destination init() lifecycle method
 */

import {Destination} from '../destination.js';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';

describe('Destination init() lifecycle', () => {
  it('should call init() before getEntities()', async () => {
    let initCalled = false;
    let buildEntitiesCalled = false;

    class TestDestination extends Destination {
      protected async _init() {
        initCalled = true;
      }

      protected async buildEntityList(): Promise<Entity[]> {
        buildEntitiesCalled = true;
        expect(initCalled).toBe(true); // init should be called first
        return [
          {
            id: 'dest1',
            name: 'Test',
            entityType: 'DESTINATION',
            timezone: 'UTC',
          } as Entity
        ];
      }

      protected async buildLiveData(): Promise<LiveData[]> {
        return [];
      }

      protected async buildSchedules(): Promise<EntitySchedule[]> {
        return [];
      }

      async getDestinations(): Promise<Entity[]> {
        return [];
      }
    }

    const dest = new TestDestination();
    await dest.getEntities();

    expect(initCalled).toBe(true);
    expect(buildEntitiesCalled).toBe(true);
  });

  it('should call init() before getLiveData()', async () => {
    let initCalled = false;
    let buildLiveDataCalled = false;

    class TestDestination extends Destination {
      protected async _init() {
        initCalled = true;
      }

      protected async buildEntityList(): Promise<Entity[]> {
        return [];
      }

      protected async buildLiveData(): Promise<LiveData[]> {
        buildLiveDataCalled = true;
        expect(initCalled).toBe(true); // init should be called first
        return [];
      }

      protected async buildSchedules(): Promise<EntitySchedule[]> {
        return [];
      }

      async getDestinations(): Promise<Entity[]> {
        return [];
      }
    }

    const dest = new TestDestination();
    await dest.getLiveData();

    expect(initCalled).toBe(true);
    expect(buildLiveDataCalled).toBe(true);
  });

  it('should call init() before getSchedules()', async () => {
    let initCalled = false;
    let buildSchedulesCalled = false;

    class TestDestination extends Destination {
      protected async _init() {
        initCalled = true;
      }

      protected async buildEntityList(): Promise<Entity[]> {
        return [];
      }

      protected async buildLiveData(): Promise<LiveData[]> {
        return [];
      }

      protected async buildSchedules(): Promise<EntitySchedule[]> {
        buildSchedulesCalled = true;
        expect(initCalled).toBe(true); // init should be called first
        return [];
      }

      async getDestinations(): Promise<Entity[]> {
        return [];
      }
    }

    const dest = new TestDestination();
    await dest.getSchedules();

    expect(initCalled).toBe(true);
    expect(buildSchedulesCalled).toBe(true);
  });

  it('should only call init() once even with multiple calls', async () => {
    let initCallCount = 0;

    class TestDestination extends Destination {
      protected async _init() {
        initCallCount++;
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      protected async buildEntityList(): Promise<Entity[]> {
        return [
          {
            id: 'dest1',
            name: 'Test',
            entityType: 'DESTINATION',
            timezone: 'UTC',
          } as Entity
        ];
      }

      protected async buildLiveData(): Promise<LiveData[]> {
        return [];
      }

      protected async buildSchedules(): Promise<EntitySchedule[]> {
        return [];
      }

      async getDestinations(): Promise<Entity[]> {
        return [];
      }
    }

    const dest = new TestDestination();

    // Call multiple methods that should all trigger init
    await Promise.all([
      dest.getEntities(),
      dest.getLiveData(),
      dest.getSchedules(),
    ]);

    // init() should only have been called once
    expect(initCallCount).toBe(1);
  });

  it('should reuse init() promise while it is pending', async () => {
    let initCallCount = 0;
    const initPromises: Promise<void>[] = [];

    class TestDestination extends Destination {
      protected async _init() {
        initCallCount++;
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      protected async buildEntityList(): Promise<Entity[]> {
        return [
          {
            id: 'dest1',
            name: 'Test',
            entityType: 'DESTINATION',
            timezone: 'UTC',
          } as Entity
        ];
      }

      protected async buildLiveData(): Promise<LiveData[]> {
        return [];
      }

      protected async buildSchedules(): Promise<EntitySchedule[]> {
        return [];
      }

      async getDestinations(): Promise<Entity[]> {
        return [];
      }
    }

    const dest = new TestDestination();

    // Start multiple calls simultaneously
    const promise1 = dest.getEntities();
    const promise2 = dest.getLiveData();
    const promise3 = dest.getSchedules();

    await Promise.all([promise1, promise2, promise3]);

    // init() should only have been called once
    expect(initCallCount).toBe(1);
  });

  it('should allow subclasses to perform setup in _init()', async () => {
    let setupValue = '';

    class TestDestination extends Destination {
      value = '';

      protected async _init() {
        this.value = 'initialized';
        setupValue = 'initialized';
      }

      protected async buildEntityList(): Promise<Entity[]> {
        // Should have access to initialized state
        expect(this.value).toBe('initialized');
        return [
          {
            id: 'dest1',
            name: 'Test',
            entityType: 'DESTINATION',
            timezone: 'UTC',
          } as Entity
        ];
      }

      protected async buildLiveData(): Promise<LiveData[]> {
        return [];
      }

      protected async buildSchedules(): Promise<EntitySchedule[]> {
        return [];
      }

      async getDestinations(): Promise<Entity[]> {
        return [];
      }
    }

    const dest = new TestDestination();
    expect(dest.value).toBe(''); // Not initialized yet

    await dest.getEntities();

    expect(setupValue).toBe('initialized');
    expect(dest.value).toBe('initialized');
  });

  it('should work when _init() is not overridden', async () => {
    class TestDestination extends Destination {
      protected async buildEntityList(): Promise<Entity[]> {
        return [
          {
            id: 'dest1',
            name: 'Test',
            entityType: 'DESTINATION',
            timezone: 'UTC',
          } as Entity
        ];
      }

      protected async buildLiveData(): Promise<LiveData[]> {
        return [];
      }

      protected async buildSchedules(): Promise<EntitySchedule[]> {
        return [];
      }

      async getDestinations(): Promise<Entity[]> {
        return [];
      }
    }

    const dest = new TestDestination();

    // Should work without error
    const entities = await dest.getEntities();
    expect(entities).toHaveLength(1);
  });
});
