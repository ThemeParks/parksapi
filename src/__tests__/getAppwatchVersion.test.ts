/**
 * Tests for Destination.getAppwatchVersion — the shared helper that pulls
 * the latest Play Store version string for a mobile app via the
 * themeparks.wiki appwatch mirror. Used by parks whose APIs gate on the
 * App-Version header so we ride the live app's version automatically.
 */

import {describe, test, expect, afterAll} from 'vitest';
import {Destination} from '../destination.js';
import {stopHttpQueue} from '../http.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';

afterAll(() => {
  stopHttpQueue();
});

type StubResponse = {json(): Promise<unknown>};

function makeStubDestination(stub: () => Promise<StubResponse>) {
  class StubDestination extends Destination {
    // Override the @http-decorated fetcher with a plain stub. The outer
    // getAppwatchVersion (which has @cache) still runs.
    protected async fetchAppwatchVersion(_packageId: string): Promise<any> {
      return stub();
    }
    async getDestinations(): Promise<Entity[]> { return []; }
    protected async buildEntityList(): Promise<Entity[]> { return []; }
    protected async buildLiveData(): Promise<LiveData[]> { return []; }
    protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
  }
  return new StubDestination();
}

describe('Destination.getAppwatchVersion', () => {
  test('returns the live version when appwatch responds with one', async () => {
    const dest = makeStubDestination(async () => ({
      json: async () => ({version: '13.8.0'}),
    }));
    const v = await dest.getAppwatchVersion('appwatch.test.happy', 'fallback');
    expect(v).toBe('13.8.0');
  });

  test('returns the fallback when the response is missing the version field', async () => {
    const dest = makeStubDestination(async () => ({
      json: async () => ({name: 'Some App'}),
    }));
    const v = await dest.getAppwatchVersion('appwatch.test.missing-field', 'fallback-version');
    expect(v).toBe('fallback-version');
  });

  test('returns the fallback when the fetcher throws', async () => {
    const dest = makeStubDestination(async () => {
      throw new Error('network down');
    });
    const v = await dest.getAppwatchVersion('appwatch.test.throws', '9.9.9');
    expect(v).toBe('9.9.9');
  });

  test('returns the empty default fallback when none provided and appwatch fails', async () => {
    const dest = makeStubDestination(async () => {
      throw new Error('network down');
    });
    const v = await dest.getAppwatchVersion('appwatch.test.empty-fallback');
    expect(v).toBe('');
  });

  test('caches per package id so different packages get isolated entries', async () => {
    let callCount = 0;
    const dest = makeStubDestination(async () => {
      callCount += 1;
      return {json: async () => ({version: `v${callCount}`})};
    });

    const a1 = await dest.getAppwatchVersion('appwatch.test.cache.pkgA', 'fb');
    const a2 = await dest.getAppwatchVersion('appwatch.test.cache.pkgA', 'fb');
    const b1 = await dest.getAppwatchVersion('appwatch.test.cache.pkgB', 'fb');

    expect(a1).toBe('v1');
    expect(a2).toBe('v1'); // cached, no second call
    expect(b1).toBe('v2'); // different package id → new cache entry
    expect(callCount).toBe(2);
  });
});
