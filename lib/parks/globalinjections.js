import {HttpsProxyAgent} from 'hpagent';

/**
 *  Inject CrawlBase proxy into HTTP object
 * @param {*} param0
 */
function injectCrawlBase({
  httpObject = null,
  args = {},
}) {
  if (!httpObject) {
    throw new Error('httpObject is required');
  }

  const apikey = args.apikey;
  if (!apikey) {
    throw new Error('apikey for CrawlBase is required');
  }

  httpObject.injectForDomain({}, (method, url, data, options) => {
    // route via proxy
    return {
      url: `https://api.crawlbase.com/?url=${encodeURIComponent(url)}&token=${apikey}`,
    };
  });
}

/**
 * Inject Scrapfly proxy into HTTP object
 * @param {*} param0
 */
function injectScrapfly({
  httpObject = null,
  args = {},
}) {
  if (!httpObject) {
    throw new Error('httpObject is required');
  }

  const apikey = args.apikey;
  if (!apikey) {
    throw new Error('apikey for Scrapfly is required');
  }

  httpObject.injectForDomain({}, (method, url, data, options) => {
    // route via proxy
    return {
      url: `https://api.scrapfly.io/scrape?url=${encodeURIComponent(url)}&key=${apikey}`,
    };
  });

  httpObject.injectForDomainResponse({}, (resp) => {
    // convert scrapfly response to standard response
    return {
      body: resp.body.result.content,
      headers: resp.body.result.response_headers,
      status: resp.body.result.status_code,
    };
  });
}

/**
 * Inject basic proxy into HTTP object
 * @param {*} param0
 */
function injectBasicProxy({
  httpObject = null,
  args = {},
}) {
  if (!httpObject) {
    throw new Error('httpObject is required');
  }

  const proxy = args.proxy;
  if (!proxy) {
    throw new Error('proxy is required');
  }

  const agent = new HttpsProxyAgent({
    proxy: proxy,
  });

  httpObject.injectForDomain({}, (method, url, data, options) => {
    // route via proxy
    return {
      options: {
        agent: agent,
        ...options,
      },
    };
  });
}

const injectionTypes = {
  CRAWLBASE: injectCrawlBase,
  SCRAPFLY: injectScrapfly,
  BASICPROXY: injectBasicProxy,
};
const injectionKeys = Object.keys(injectionTypes);

/**
 * Add global injections to HTTP object to support general proxies etc.
 * @param {*} param0
 */
export function addGlobalInjections({
  httpObject = null,
  configPrefixes = [],
}) {
  if (!httpObject) {
    throw new Error('httpObject is required');
  }

  if (!configPrefixes) {
    throw new Error('configPrefixes is required');
  }

  // loop over all config prefixes
  configPrefixes.forEach((prefix) => {
    // find matching environment variables
    injectionKeys.forEach((key) => {
      const envVar = `${prefix}_${key}`;
      const envVal = process.env[envVar];
      if (envVal) {
        let jsonVal = null;
        try {
          jsonVal = JSON.parse(envVal);
        } catch (e) {
        }
        // add injection
        injectionTypes[key]({
          httpObject,
          args: jsonVal,
        });
      }
    });
  });
}
