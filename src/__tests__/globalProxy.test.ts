// Tests for global proxy configuration
import {Destination} from '../destination';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import config from '../config';

// Mock destination for testing
@config
class TestGlobalProxyDestination extends Destination {
  protected async buildEntityList(): Promise<Entity[]> { return []; }
  protected async buildLiveData(): Promise<LiveData[]> { return []; }
  protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
}

// A second destination class to test isolation
@config
class TestGlobalProxyDestination2 extends Destination {
  protected async buildEntityList(): Promise<Entity[]> { return []; }
  protected async buildLiveData(): Promise<LiveData[]> { return []; }
  protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
}

describe('Global Proxy Configuration', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = {...process.env};
    Destination.resetGlobalProxyState();
  });

  afterEach(() => {
    process.env = originalEnv;
    Destination.resetGlobalProxyState();
  });

  describe('Automatic Global Proxy Detection', () => {
    it('should automatically enable global proxy when GLOBAL_CRAWLBASE is set', () => {
      process.env.GLOBAL_CRAWLBASE = JSON.stringify({apikey: 'global-key'});

      const dest = new TestGlobalProxyDestination();
      expect(dest.proxyConfig).toEqual({crawlbase: {apikey: 'global-key'}});
    });

    it('should automatically enable global proxy when GLOBAL_SCRAPFLY is set', () => {
      process.env.GLOBAL_SCRAPFLY = JSON.stringify({apikey: 'global-key'});

      const dest = new TestGlobalProxyDestination();
      expect(dest.proxyConfig).toEqual({scrapfly: {apikey: 'global-key'}});
    });

    it('should automatically enable global proxy when GLOBAL_BASICPROXY is set', () => {
      process.env.GLOBAL_BASICPROXY = JSON.stringify({proxy: 'http://global-proxy.com:8080'});

      const dest = new TestGlobalProxyDestination();
      expect(dest.proxyConfig).toEqual({basicProxy: {proxy: 'http://global-proxy.com:8080'}});
    });

    it('should apply global proxy to all destinations', () => {
      process.env.GLOBAL_CRAWLBASE = JSON.stringify({apikey: 'global-key'});

      const dest1 = new TestGlobalProxyDestination();
      const dest2 = new TestGlobalProxyDestination2();

      expect(dest1.proxyConfig).toEqual({crawlbase: {apikey: 'global-key'}});
      expect(dest2.proxyConfig).toEqual({crawlbase: {apikey: 'global-key'}});
    });

    it('should only check for global proxies once (on first destination)', () => {
      process.env.GLOBAL_CRAWLBASE = JSON.stringify({apikey: 'global-key'});

      new TestGlobalProxyDestination();

      // Change env var (shouldn't affect already-loaded config)
      process.env.GLOBAL_CRAWLBASE = JSON.stringify({apikey: 'different-key'});

      const dest2 = new TestGlobalProxyDestination();
      expect(dest2.proxyConfig).toEqual({crawlbase: {apikey: 'global-key'}});
    });

    it('should not enable proxies if no GLOBAL_* env vars are set', () => {
      const dest = new TestGlobalProxyDestination();
      expect(dest.proxyConfig).toBeNull();
    });
  });

  describe('Per-Destination Override', () => {
    it('should allow destination-specific config to override global', () => {
      process.env.GLOBAL_CRAWLBASE = JSON.stringify({apikey: 'global-key'});
      process.env.OVERRIDE_CRAWLBASE = JSON.stringify({apikey: 'override-key'});

      const dest = new TestGlobalProxyDestination();
      dest.addConfigPrefix('OVERRIDE');

      // Destination-specific should override global
      expect(dest.proxyConfig!.crawlbase).toEqual({apikey: 'override-key'});
    });

    it('should merge destination-specific with global config', () => {
      process.env.GLOBAL_CRAWLBASE = JSON.stringify({apikey: 'global-key'});
      process.env.DEST_SCRAPFLY = JSON.stringify({apikey: 'dest-key'});

      const dest = new TestGlobalProxyDestination();
      dest.addConfigPrefix('DEST');

      // Should have both
      expect(dest.proxyConfig!.crawlbase).toEqual({apikey: 'global-key'});
      expect(dest.proxyConfig!.scrapfly).toEqual({apikey: 'dest-key'});
    });

    it('should not affect other destinations when one enables proxy', () => {
      const dest1 = new TestGlobalProxyDestination();
      const dest2 = new TestGlobalProxyDestination2();

      process.env.DEST1_CRAWLBASE = JSON.stringify({apikey: 'dest1-key'});
      dest1.addConfigPrefix('DEST1');

      // dest1 should have proxy, dest2 should not
      expect(dest1.proxyConfig!.crawlbase).toEqual({apikey: 'dest1-key'});
      expect(dest2.proxyConfig).toBeNull();
    });
  });
});
