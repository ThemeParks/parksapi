/**
 * Test that @config properties resolve correctly inside @http decorated methods.
 *
 * This is a regression test for a real bug: when @http wraps a method,
 * `this` inside the method may be the raw instance (not the @config proxy),
 * causing config properties to return their default values instead of
 * env var overrides.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import config from '../config.js';
import { http, HTTPObj, stopHttpQueue } from '../http.js';
import { cache } from '../cache.js';
import { Destination, DestinationConstructor } from '../destination.js';
import { Entity, LiveData, EntitySchedule } from '@themeparks/typelib';
import { destinationController } from '../destinationRegistry.js';

afterAll(() => {
  stopHttpQueue();
});

describe('@config property resolution inside @http methods', () => {
  test('@config property accessed inside @http method resolves from env var', async () => {
    process.env.TESTHTTPCONFIG_BASEURL = 'https://resolved.example.com';

    let capturedUrl = '';

    @config
    class TestHttpConfig {
      @config
      baseUrl: string = '';

      @http({})
      async fetchData(): Promise<HTTPObj> {
        // This is the critical test: does this.baseUrl resolve from env var
        // inside an @http decorated method?
        capturedUrl = `${this.baseUrl}/data`;
        return {
          method: 'GET',
          url: capturedUrl,
          options: { json: true },
        } as any as HTTPObj;
      }
    }

    const instance = new TestHttpConfig();

    // Direct access works (through proxy)
    expect(instance.baseUrl).toBe('https://resolved.example.com');

    // Access inside @http method — this is where the bug manifests
    try {
      await instance.fetchData();
    } catch {
      // HTTP request will fail (no real server), but we captured the URL
    }

    expect(capturedUrl).toBe('https://resolved.example.com/data');

    delete process.env.TESTHTTPCONFIG_BASEURL;
  });

  test('@config property with default value resolves inside @http method', async () => {
    let capturedUrl = '';

    @config
    class TestHttpDefault {
      @config
      baseUrl: string = 'https://default.example.com';

      @http({})
      async fetchData(): Promise<HTTPObj> {
        capturedUrl = `${this.baseUrl}/data`;
        return {
          method: 'GET',
          url: capturedUrl,
          options: { json: true },
        } as any as HTTPObj;
      }
    }

    const instance = new TestHttpDefault();

    try {
      await instance.fetchData();
    } catch {}

    expect(capturedUrl).toBe('https://default.example.com/data');
  });

  test('@config property resolves inside @cache → @http chain', async () => {
    let capturedUrl = '';

    @config
    class TestCacheHttpConfig {
      @config
      baseUrl: string = 'https://chain.example.com';

      @http({})
      async fetchRaw(): Promise<HTTPObj> {
        capturedUrl = `${this.baseUrl}/raw`;
        return {
          method: 'GET',
          url: capturedUrl,
          options: { json: true },
        } as any as HTTPObj;
      }

      @cache({ ttlSeconds: 1 })
      async getData(): Promise<any> {
        const resp = await this.fetchRaw();
        return resp;
      }
    }

    const instance = new TestCacheHttpConfig();

    try {
      await instance.getData();
    } catch {}

    expect(capturedUrl).toBe('https://chain.example.com/raw');
  });

  test('@config property resolves inside @http method on Destination subclass', async () => {
    process.env.TESTDESTHTTP_APIBASE = 'https://api.testdest.com';

    let capturedUrl = '';

    @config
    @destinationController({ category: 'TestDest' })
    class TestDestHttp extends Destination {
      @config
      apiBase: string = '';

      @config
      timezone: string = 'UTC';

      constructor(options?: DestinationConstructor) {
        super(options);
        this.addConfigPrefix('TESTDESTHTTP');
      }

      @http({})
      async fetchPOI(): Promise<HTTPObj> {
        capturedUrl = `${this.apiBase}/pois`;
        return {
          method: 'GET',
          url: capturedUrl,
          options: { json: true },
        } as any as HTTPObj;
      }

      @cache({ ttlSeconds: 1 })
      async getPOI(): Promise<any> {
        return await this.fetchPOI();
      }

      protected async buildEntityList(): Promise<Entity[]> {
        await this.getPOI();
        return [];
      }
      protected async buildLiveData(): Promise<LiveData[]> { return []; }
      protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
      async getDestinations(): Promise<Entity[]> { return []; }
    }

    const instance = new TestDestHttp();

    // Direct access
    expect(instance.apiBase).toBe('https://api.testdest.com');

    // Access through buildEntityList → getPOI → fetchPOI chain
    try {
      await instance.getEntities();
    } catch {}

    expect(capturedUrl).toBe('https://api.testdest.com/pois');

    delete process.env.TESTDESTHTTP_APIBASE;
  });

  test('@config property resolves when instance is created via registry pattern', async () => {
    process.env.TESTREGISTRY_APIBASE = 'https://api.registry.com';

    let capturedUrl = '';

    // IMPORTANT: @destinationController MUST be outer (first) decorator
    // so it registers the @config proxy-wrapped class, not the raw class.
    // Wrong order: @config → @destinationController (registry gets raw class)
    // Right order: @destinationController → @config (registry gets proxy)
    @destinationController({ category: 'TestRegistry' })
    @config
    class TestRegistryPark extends Destination {
      @config
      apiBase: string = '';

      @config
      timezone: string = 'UTC';

      constructor(options?: DestinationConstructor) {
        super(options);
        this.addConfigPrefix('TESTREGISTRY');
      }

      @http({})
      async fetchPOI(): Promise<HTTPObj> {
        capturedUrl = `${this.apiBase}/pois`;
        return {
          method: 'GET',
          url: capturedUrl,
          options: { json: true },
        } as any as HTTPObj;
      }

      @cache({ ttlSeconds: 1 })
      async getPOI(): Promise<any> {
        return await this.fetchPOI();
      }

      protected async buildEntityList(): Promise<Entity[]> {
        await this.getPOI();
        return [];
      }
      protected async buildLiveData(): Promise<LiveData[]> { return []; }
      protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
      async getDestinations(): Promise<Entity[]> { return []; }
    }

    // Simulate the registry pattern: get class from registry, instantiate
    const { getDestinationById } = await import('../destinationRegistry.js');
    const entry = await getDestinationById('testregistrypark');
    expect(entry).toBeDefined();

    const instance = new entry!.DestinationClass();
    expect(instance.apiBase).toBe('https://api.registry.com');

    // Now test through the full chain
    try {
      await instance.getEntities();
    } catch {}

    expect(capturedUrl).toBe('https://api.registry.com/pois');

    delete process.env.TESTREGISTRY_APIBASE;
  });
});
