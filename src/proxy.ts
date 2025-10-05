// Proxy injection system for HTTP library
//  Supports CrawlBase, Scrapfly, and basic HTTP(S) proxies
//  Environment variables: {PREFIX}_CRAWLBASE, {PREFIX}_SCRAPFLY, {PREFIX}_BASICPROXY

import {inject, registerInstance} from './injector.js';
import {HTTPObj} from './http.js';

/**
 * Configuration types for different proxy providers
 */
export type CrawlBaseConfig = {
  apikey: string;
};

export type ScrapflyConfig = {
  apikey: string;
};

export type BasicProxyConfig = {
  proxy: string; // e.g., "http://proxy.example.com:8080"
};

export type ProxyConfig = {
  crawlbase?: CrawlBaseConfig;
  scrapfly?: ScrapflyConfig;
  basicProxy?: BasicProxyConfig;
};

/**
 * Singleton proxy injector class
 * Loads configuration from environment variables and modifies HTTP requests/responses
 */
class ProxyInjector {
  private static instance: ProxyInjector | null = null;
  private config: ProxyConfig = {};
  private enabled: boolean = false;

  private constructor(configPrefixes: string[]) {
    this.loadConfig(configPrefixes);

    // Register this instance globally so it receives HTTP events
    registerInstance(this);
    this.enabled = true;
  }

  /**
   * Initialize the proxy injector with config prefixes
   * @param configPrefixes Array of config prefixes to check (e.g., ['UNIVERSAL', 'GLOBAL'])
   */
  public static enable(configPrefixes: string[] = []): ProxyInjector {
    if (!ProxyInjector.instance) {
      ProxyInjector.instance = new ProxyInjector(configPrefixes);
      console.log('🔌 Proxy support enabled');
    } else {
      // Update config if already enabled
      ProxyInjector.instance.loadConfig(configPrefixes);
      ProxyInjector.instance.enabled = true; // Re-enable if it was disabled
    }
    return ProxyInjector.instance;
  }

  /**
   * Disable proxy support
   */
  public static disable(): void {
    if (ProxyInjector.instance) {
      ProxyInjector.instance.enabled = false;
      ProxyInjector.instance.config = {};
      console.log('🔌 Proxy support disabled');
    }
  }

  /**
   * Get current proxy configuration (for debugging)
   */
  public static getConfig(): ProxyConfig {
    return ProxyInjector.instance?.config || {};
  }

  /**
   * Load proxy configuration from environment variables
   * @param prefixes Array of config prefixes to check
   */
  private loadConfig(prefixes: string[]): void {
    const newConfig: ProxyConfig = {};

    for (const prefix of prefixes) {
      // Check for CRAWLBASE
      const crawlbaseEnv = `${prefix}_CRAWLBASE`;
      const crawlbaseVal = process.env[crawlbaseEnv];
      if (crawlbaseVal) {
        try {
          newConfig.crawlbase = JSON.parse(crawlbaseVal);
          console.log(`📡 Loaded CrawlBase config from ${crawlbaseEnv}`);
        } catch (e) {
          console.warn(`Failed to parse ${crawlbaseEnv} as JSON:`, e);
        }
      }

      // Check for SCRAPFLY
      const scrapflyEnv = `${prefix}_SCRAPFLY`;
      const scrapflyVal = process.env[scrapflyEnv];
      if (scrapflyVal) {
        try {
          newConfig.scrapfly = JSON.parse(scrapflyVal);
          console.log(`📡 Loaded Scrapfly config from ${scrapflyEnv}`);
        } catch (e) {
          console.warn(`Failed to parse ${scrapflyEnv} as JSON:`, e);
        }
      }

      // Check for BASICPROXY
      const basicProxyEnv = `${prefix}_BASICPROXY`;
      const basicProxyVal = process.env[basicProxyEnv];
      if (basicProxyVal) {
        try {
          newConfig.basicProxy = JSON.parse(basicProxyVal);
          console.log(`📡 Loaded basic proxy config from ${basicProxyEnv}`);
        } catch (e) {
          console.warn(`Failed to parse ${basicProxyEnv} as JSON:`, e);
        }
      }
    }

    // Merge new config with existing (last prefix wins)
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Inject proxy settings into HTTP requests
   * Called before each HTTP request via the injector system
   */
  @inject({ eventName: 'httpRequest' })
  async injectProxy(requestObj: HTTPObj): Promise<void> {
    if (!this.enabled) return;

    // Apply proxies in priority order: CrawlBase > Scrapfly > BasicProxy
    // Only one proxy type is applied per request

    if (this.config.crawlbase) {
      const originalUrl = requestObj.url;
      requestObj.url = `https://api.crawlbase.com/?url=${encodeURIComponent(originalUrl)}&token=${this.config.crawlbase.apikey}`;
      console.log(`🔄 Routing through CrawlBase: ${originalUrl}`);
      return;
    }

    if (this.config.scrapfly) {
      const originalUrl = requestObj.url;
      requestObj.url = `https://api.scrapfly.io/scrape?url=${encodeURIComponent(originalUrl)}&key=${this.config.scrapfly.apikey}`;
      console.log(`🔄 Routing through Scrapfly: ${originalUrl}`);
      return;
    }

    if (this.config.basicProxy) {
      console.log(`🔄 Using basic HTTP proxy: ${this.config.basicProxy.proxy}`);
      // Note: Basic proxy is handled by HTTP library using node:http/https with Agent
    }
  }

  /**
   * Unwrap proxy responses (e.g., Scrapfly wraps responses in JSON)
   * Called after each HTTP response via the injector system
   */
  @inject({ eventName: 'httpResponse' })
  async unwrapProxyResponse(requestObj: HTTPObj): Promise<void> {
    if (!this.enabled) return;

    // Only Scrapfly needs response unwrapping (CrawlBase returns direct response)
    if (this.config.scrapfly && requestObj.response) {
      try {
        const body = await requestObj.response.clone().json();

        // Scrapfly wraps response in: { result: { content: "...", status_code: 200, response_headers: {} } }
        if (body.result && body.result.content !== undefined) {
          console.log(`📦 Unwrapping Scrapfly response (status ${body.result.status_code || 200})`);

          // Create a new response with unwrapped content
          requestObj.response = new Response(body.result.content, {
            status: body.result.status_code || 200,
            headers: body.result.response_headers || {},
          });
        }
      } catch (e) {
        // Failed to unwrap (maybe not JSON or not Scrapfly response), leave as-is
        console.warn('⚠️  Failed to unwrap Scrapfly response:', e);
      }
    }
  }
}

/**
 * Enable proxy support for HTTP requests
 * Reads configuration from environment variables: {PREFIX}_CRAWLBASE, {PREFIX}_SCRAPFLY, {PREFIX}_BASICPROXY
 *
 * Example environment variables:
 *   UNIVERSAL_CRAWLBASE='{"apikey":"YOUR_CRAWLBASE_TOKEN"}'
 *   UNIVERSAL_SCRAPFLY='{"apikey":"YOUR_SCRAPFLY_KEY"}'
 *   UNIVERSAL_BASICPROXY='{"proxy":"http://proxy.example.com:8080"}'
 *
 * @param configPrefixes Array of config prefixes to check (e.g., ['UNIVERSAL', 'GLOBAL'])
 */
export function enableProxySupport(configPrefixes: string[] = []): void {
  ProxyInjector.enable(configPrefixes);
}

/**
 * Enable global proxy support for all HTTP requests.
 * Convenience function that enables proxies using the 'GLOBAL' prefix.
 *
 * This is called automatically by the Destination base class if GLOBAL_* env vars are detected.
 * You can also call it manually before creating any destinations.
 *
 * Environment variables checked:
 *   GLOBAL_CRAWLBASE='{"apikey":"YOUR_CRAWLBASE_TOKEN"}'
 *   GLOBAL_SCRAPFLY='{"apikey":"YOUR_SCRAPFLY_KEY"}'
 *   GLOBAL_BASICPROXY='{"proxy":"http://proxy.example.com:8080"}'
 */
export function enableGlobalProxySupport(): void {
  ProxyInjector.enable(['GLOBAL']);
}

/**
 * Disable proxy support
 */
export function disableProxySupport(): void {
  ProxyInjector.disable();
}

/**
 * Get current proxy configuration (for debugging/testing)
 */
export function getProxyConfig(): ProxyConfig {
  return ProxyInjector.getConfig();
}

/**
 * Get the current basic proxy URL if configured
 * Used by HTTP library to determine if it should use the proxy client
 * @returns Proxy URL string or undefined
 */
export function getBasicProxyUrl(): string | undefined {
  return ProxyInjector.getConfig().basicProxy?.proxy;
}
