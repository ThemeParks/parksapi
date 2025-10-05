// Tests for global proxy configuration
import {enableGlobalProxySupport, disableProxySupport, getProxyConfig} from '../proxy';
import {Destination} from '../destination';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import config from '../config';

// Mock destination for testing
@config
class TestDestination extends Destination {
  protected async buildEntityList(): Promise<Entity[]> {
    return [];
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    return [];
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    return [];
  }
}

describe('Global Proxy Configuration', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = {...process.env};
    disableProxySupport();

    // Reset the static flag for testing
    // @ts-ignore - accessing private static field for testing
    Destination.globalProxiesEnabled = false;
  });

  afterEach(() => {
    process.env = originalEnv;
    disableProxySupport();
    // @ts-ignore
    Destination.globalProxiesEnabled = false;
  });

  describe('Automatic Global Proxy Detection', () => {
    it('should automatically enable global proxy when GLOBAL_CRAWLBASE is set', () => {
      process.env.GLOBAL_CRAWLBASE = JSON.stringify({apikey: 'global-key'});

      // Creating a destination should auto-enable global proxies
      new TestDestination();

      const config = getProxyConfig();
      expect(config.crawlbase).toEqual({apikey: 'global-key'});
    });

    it('should automatically enable global proxy when GLOBAL_SCRAPFLY is set', () => {
      process.env.GLOBAL_SCRAPFLY = JSON.stringify({apikey: 'global-key'});

      new TestDestination();

      const config = getProxyConfig();
      expect(config.scrapfly).toEqual({apikey: 'global-key'});
    });

    it('should automatically enable global proxy when GLOBAL_BASICPROXY is set', () => {
      process.env.GLOBAL_BASICPROXY = JSON.stringify({proxy: 'http://global-proxy.com:8080'});

      new TestDestination();

      const config = getProxyConfig();
      expect(config.basicProxy).toEqual({proxy: 'http://global-proxy.com:8080'});
    });

    it('should only check for global proxies once (on first destination)', () => {
      process.env.GLOBAL_CRAWLBASE = JSON.stringify({apikey: 'global-key'});

      // Create first destination
      new TestDestination();
      const config1 = getProxyConfig();
      expect(config1.crawlbase).toEqual({apikey: 'global-key'});

      // Change env var (shouldn't affect already-enabled proxy)
      process.env.GLOBAL_CRAWLBASE = JSON.stringify({apikey: 'different-key'});

      // Create second destination
      new TestDestination();
      const config2 = getProxyConfig();

      // Should still have original key (only checked once)
      expect(config2.crawlbase).toEqual({apikey: 'global-key'});
    });

    it('should not enable proxies if no GLOBAL_* env vars are set', () => {
      // No GLOBAL_* env vars set
      new TestDestination();

      const config = getProxyConfig();
      expect(config).toEqual({});
    });
  });

  describe('Manual Global Proxy Enabling', () => {
    it('should enable global proxies via enableGlobalProxySupport()', () => {
      process.env.GLOBAL_CRAWLBASE = JSON.stringify({apikey: 'manual-key'});

      // Enable manually before creating any destinations
      enableGlobalProxySupport();

      const config = getProxyConfig();
      expect(config.crawlbase).toEqual({apikey: 'manual-key'});
    });

    it('should work even if called before env vars are set', () => {
      // Enable first (no env vars yet)
      enableGlobalProxySupport();
      expect(getProxyConfig()).toEqual({});

      // Set env var and re-enable
      process.env.GLOBAL_SCRAPFLY = JSON.stringify({apikey: 'late-key'});
      enableGlobalProxySupport();

      const config = getProxyConfig();
      expect(config.scrapfly).toEqual({apikey: 'late-key'});
    });
  });

  describe('Per-Destination Override', () => {
    it('should allow destinations to add their own proxy config on top of global', () => {
      process.env.GLOBAL_CRAWLBASE = JSON.stringify({apikey: 'global-key'});
      process.env.TEST_SCRAPFLY = JSON.stringify({apikey: 'destination-key'});

      const dest = new TestDestination();
      dest.addConfigPrefix('TEST');
      dest.enableProxySupport();

      const config = getProxyConfig();
      // Should have both global CrawlBase and destination-specific Scrapfly
      expect(config.crawlbase).toEqual({apikey: 'global-key'});
      expect(config.scrapfly).toEqual({apikey: 'destination-key'});
    });

    it('should allow destination-specific config to override global config', () => {
      process.env.GLOBAL_CRAWLBASE = JSON.stringify({apikey: 'global-key'});
      process.env.OVERRIDE_CRAWLBASE = JSON.stringify({apikey: 'override-key'});

      const dest = new TestDestination();
      dest.addConfigPrefix('OVERRIDE');
      dest.enableProxySupport();

      const config = getProxyConfig();
      // Destination-specific should win (last one wins in loadConfig)
      expect(config.crawlbase).toEqual({apikey: 'override-key'});
    });
  });
});
