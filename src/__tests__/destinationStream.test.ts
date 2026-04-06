import { describe, test, expect } from 'vitest';
import { Destination } from '../destination.js';
import { Entity, LiveData, EntitySchedule } from '@themeparks/typelib';

/** Park with no live stream — default behaviour */
class NoStreamPark extends Destination {
  protected async buildEntityList(): Promise<Entity[]> { return []; }
  protected async buildLiveData(): Promise<LiveData[]> { return []; }
  protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
  async getDestinations(): Promise<Entity[]> { return []; }
}

/** Park that simulates a live feed yielding three batches then ending */
class FakeStreamPark extends Destination {
  hasLiveStream = true;

  private updates: LiveData[][] = [
    [{ id: 'ride1', status: 'OPERATING' } as LiveData],
    [{ id: 'ride2', status: 'DOWN' } as LiveData],
    [{ id: 'ride1', status: 'CLOSED' } as LiveData],
  ];

  protected async buildEntityList(): Promise<Entity[]> { return []; }
  protected async buildLiveData(): Promise<LiveData[]> { return []; }
  protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
  async getDestinations(): Promise<Entity[]> { return []; }

  protected async *buildLiveDataStream(): AsyncGenerator<LiveData[]> {
    for (const batch of this.updates) {
      yield batch;
    }
  }
}

describe('Destination streamLiveData', () => {
  test('hasLiveStream defaults to false', () => {
    const park = new NoStreamPark();
    expect(park.hasLiveStream).toBe(false);
  });

  test('streamLiveData returns immediately for parks with no live stream', async () => {
    const park = new NoStreamPark();
    const results: LiveData[][] = [];
    for await (const update of park.streamLiveData()) {
      results.push(update);
    }
    expect(results).toHaveLength(0);
  });

  test('streamLiveData yields updates from buildLiveDataStream', async () => {
    const park = new FakeStreamPark();
    const results: LiveData[][] = [];
    for await (const update of park.streamLiveData()) {
      results.push(update);
    }
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual([{ id: 'ride1', status: 'OPERATING' }]);
    expect(results[1]).toEqual([{ id: 'ride2', status: 'DOWN' }]);
    expect(results[2]).toEqual([{ id: 'ride1', status: 'CLOSED' }]);
  });

  test('streamLiveData can be cancelled with break', async () => {
    const park = new FakeStreamPark();
    const results: LiveData[][] = [];
    for await (const update of park.streamLiveData()) {
      results.push(update);
      if (results.length === 2) break;
    }
    expect(results).toHaveLength(2);
  });

  test('hasLiveStream is true for streaming parks', () => {
    const park = new FakeStreamPark();
    expect(park.hasLiveStream).toBe(true);
  });

  test('streamLiveData calls init before streaming', async () => {
    let initCalled = false;

    class InitTrackingPark extends Destination {
      hasLiveStream = true;
      protected async _init() { initCalled = true; }
      protected async buildEntityList(): Promise<Entity[]> { return []; }
      protected async buildLiveData(): Promise<LiveData[]> { return []; }
      protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
      async getDestinations(): Promise<Entity[]> { return []; }
      protected async *buildLiveDataStream(): AsyncGenerator<LiveData[]> {
        yield [{ id: 'a', status: 'OPERATING' } as LiveData];
      }
    }

    const park = new InitTrackingPark();
    for await (const _ of park.streamLiveData()) { break; }
    expect(initCalled).toBe(true);
  });
});
