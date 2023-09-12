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

const injectionTypes = {
  CRAWLBASE: injectCrawlBase,
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
