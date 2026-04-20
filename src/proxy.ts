// Proxy configuration system for HTTP library
//  Supports CrawlBase, Scrapfly, and basic HTTP(S) proxies
//  Environment variables: {PREFIX}_CRAWLBASE, {PREFIX}_SCRAPFLY, {PREFIX}_BASICPROXY

/**
 * Configuration types for different proxy providers
 */
export type CrawlBaseConfig = {
  apikey: string;
};

export type ScrapflyConfig = {
  apikey: string;
  /** Extra query parameters to pass through to the Scrapfly API. */
  params?: Record<string, string>;
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
 * Load proxy configuration from environment variables.
 * Checks each prefix for _CRAWLBASE, _SCRAPFLY, and _BASICPROXY env vars.
 * Later prefixes override earlier ones for the same proxy type.
 *
 * @param prefixes Array of config prefixes to check (e.g., ['GLOBAL', 'UNIVERSALSTUDIOSJAPAN'])
 * @returns ProxyConfig with any configured proxy settings
 */
export function loadProxyConfig(prefixes: string[]): ProxyConfig {
  const config: ProxyConfig = {};

  for (const prefix of prefixes) {
    // Check for CRAWLBASE
    const crawlbaseVal = process.env[`${prefix}_CRAWLBASE`];
    if (crawlbaseVal) {
      try {
        config.crawlbase = JSON.parse(crawlbaseVal);
      } catch (e) {
        console.warn(`Failed to parse ${prefix}_CRAWLBASE as JSON:`, e);
      }
    }

    // Check for SCRAPFLY
    const scrapflyVal = process.env[`${prefix}_SCRAPFLY`];
    if (scrapflyVal) {
      try {
        config.scrapfly = JSON.parse(scrapflyVal);
      } catch (e) {
        console.warn(`Failed to parse ${prefix}_SCRAPFLY as JSON:`, e);
      }
    }

    // Check for BASICPROXY
    const basicProxyVal = process.env[`${prefix}_BASICPROXY`];
    if (basicProxyVal) {
      try {
        config.basicProxy = JSON.parse(basicProxyVal);
      } catch (e) {
        console.warn(`Failed to parse ${prefix}_BASICPROXY as JSON:`, e);
      }
    }
  }

  return config;
}

/**
 * Check if a ProxyConfig has any proxy configured
 */
export function hasProxyConfig(config: ProxyConfig): boolean {
  return !!(config.crawlbase || config.scrapfly || config.basicProxy);
}
