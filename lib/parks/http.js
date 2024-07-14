import HarWriter from '../har.js';
import randomUseragent from 'random-useragent';
import moment from 'moment-timezone';
import sift from 'sift';
import needle from 'needle';
import promiseRetry from 'promise-retry';

let overrideFunc = null;
/**
 * Set an override function to use for HTTP requests
 * Accepts (method, URL, data, options)
 * @param {function} fn
 */
export function setOverrideFunction(fn) {
  overrideFunc = fn;
}

/**
 * Generate a random Android user agent for making network requests
 * @return {string}
 */
export function generateRandomAndroidUseragent() {
  return randomUseragent.getRandom((ua) => {
    return (ua.osName === 'Android');
  });
}

// start our har writer (if debugging)
const harWriter = process.env['THEMEPARKS_HAR'] ?
  new HarWriter({filename: `${process.env['THEMEPARKS_HAR']}.har`}) :
  null;

/**
   * Write a HTTP response to HAR file for debugging
   * @param {*} method
   * @param {*} url
   * @param {*} data
   * @param {*} options
   * @param {*} resp
   * @param {*} startTime
   * @param {*} timeTaken
   * @private
   */
async function writeToHAR(method, url, data, options, resp, startTime, timeTaken) {
  const objToArr = (obj) => {
    return Object.keys(obj).map((header) => {
      return {name: header, value: obj[header].toString()};
    });
  };

  const entry = {
    startedDateTime: startTime,
    time: timeTaken,
    request: {
      method: method,
      url: url,
      httpVersion: `HTTP/${resp.httpVersion}`, // this is actually the response, TODO
      cookies: [],
      headers: objToArr(options.headers), // not the actual headers needle sends - TODO, how to get these?
      queryString: method === 'GET' ? objToArr(data) : [], // TODO - parse from needle's .path
      postData: {
        mimeType: options.json ? 'application/json' : (options.headers['content-type'] || ''),
        params: method !== 'GET' ? [] : [],
        text: '',
      },
      headersSize: -1,
      bodySize: -1,
    },
    response: {
      status: resp.statusCode,
      statusText: resp.statusMessage,
      httpVersion: `HTTP/${resp.httpVersion}`,
      cookies: [],
      headers: objToArr(resp.headers),
      content: {
        size: resp.raw.length || -1,
        mimeType: resp.headers['content-type'],
        text: resp.raw.toString('base64'),
        encoding: 'base64',
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: {
      send: -1,
      wait: -1,
      receive: -1,
    },
  };
  await harWriter.recordEntry(entry);
}

/**
 * HTTP helper with injection
 * @return {*}
 */
export const HTTP = (function() {
  this._httpInjections = [];
  this._httpResponseInjections = [];
  this.useragent = generateRandomAndroidUseragent();

  this.customOverrideFunc = null;

  /**
   * Helper function to make an HTTP request for this park
   * Parks can automatically add in authentication headers etc. to requests sent to this function
   * @param {string} method HTTP method to use (GET,POST,DELETE, etc)
   * @param {string} url URL to request
   * @param {object} [data] data to send. Will become querystring for GET, body for POST
   * @param {object} [options = {}] Object containing needle-compatible HTTP options
   */
  const mainFunction = async (method, url, data, options = {}) => {
    // default to GET if we only have one argument
    if (url === undefined && data === undefined) {
      url = method;
      method = 'GET';
    }

    // always have a headers array
    if (!options.headers) {
      options.headers = {};
    }

    // default to accepting compressed data
    options.compressed = options.compressed === undefined ? true : options.compressed;

    // 10 seconds default timeout opening response
    options.response_timeout = options.response_timeout !== undefined ? options.response_timeout : 10000;
    // 30 seconds default timeout for reading data (for large data streams)
    options.read_timeout = options.read_timeout !== undefined ? options.read_timeout : 30000;

    // inject custom standard user agent (if we have one)
    //  do this before any custom injections so parks can optionally override this for each domain
    if (this.useragent && !options.headers['user-agent']) {
      options.headers['user-agent'] = this.useragent;
    }

    if (!options.headers['user-agent'] && process.env.DEFAULT_USER_AGENT) {
      // if no user-agent supplied, set a default one from the env
      options.headers['user-agent'] = process.env.DEFAULT_USER_AGENT;
    }

    // check any hostname injections we have setup
    const urlObj = new URL(url);
    const urlFilter = {
      protocol: urlObj.protocol,
      host: urlObj.host,
      hostname: urlObj.hostname,
      pathname: urlObj.pathname,
      search: urlObj.search,
      hash: urlObj.hash,
    };

    // wrap our needle call in a retry
    return await promiseRetry({
      retries: options.retries === undefined ? 3 : options.retries,
    }, async (retryFn) => {
      // make sure we run initial injections on each retry
      for (let injectionIDX = 0; injectionIDX < this._httpInjections.length; injectionIDX++) {
        const injection = this._httpInjections[injectionIDX];

        // check if the domain matches
        if (injection.filter(urlFilter)) {
          const injectionResp = await injection.func(method, url, data, options);
          if (injectionResp) {
            url = injectionResp.url || url;
            method = injectionResp.method || method;
            data = injectionResp.data || data;
            options = injectionResp.options || options;
          }
        }
      }

      // record some stats for the optional HAR Writer
      const startMs = +new Date();
      const startTime = moment(startMs).toISOString();

      // optionally override the HTTP function to use
      const httpFunc = this.customOverrideFunc || (overrideFunc ? overrideFunc : needle);

      return httpFunc(method, url, data, options).then(async (resp) => {
        // intercept response to write to our .har file
        if (harWriter) {
          await writeToHAR(method, url, data, options, resp, startTime, (+new Date()) - startMs);
        }

        // call any response injections
        for (let injectionIDX = 0; injectionIDX < this._httpResponseInjections.length; injectionIDX++) {
          const injection = this._httpResponseInjections[injectionIDX];

          // check if the domain matches
          // (reuse urlFilter from the incoming injections)
          if (injection.filter(urlFilter)) {
            resp = await injection.func(resp);
          }
        }

        // if our response if now undefined, retry our request
        if (resp === undefined) {
          return retryFn();
        }

        // if we got an error code, retry our request
        if (!options.ignoreErrors && resp.statusCode >= 400) {
          return retryFn();
        }

        // force response to JSON object if options.json is set
        if (options.json && resp.body && typeof resp.body === 'string') {
          try {
            resp.body = JSON.parse(resp.body);
          } catch (e) {
            // ignore
          }
        }

        return resp;
      });
    });
  };

  /**
   * Register a new injection for a specific domain
   * @param {object} filter Mongo-type query to use to match a URL
   * @param {function} func Function to call with needle request to inject extra data into.
   * Function will take arguments: (method, URL, data, options)
   */
  mainFunction.injectForDomain = (filter, func) => {
    // add to our array of injections, this is processing by HTTP()
    this._httpInjections.push({
      filter: sift(filter),
      func,
    });
  };

  /**
   * Register a new response injection for a specific domain
   * @param {object} filter Mongo-type query to use to match a URL
   * @param {function} func Function to call with needle response object to make changes
   * Function will take arguments: (response)
   * Function *must* return the response object back, or undefined if you want to force a retry
   */
  mainFunction.injectForDomainResponse = (filter, func) => {
    this._httpResponseInjections.push({
      filter: sift(filter),
      func,
    });
  };

  /**
   * Helper function to make a GET request
   * @param {string} url URL to request
   * @param {object} [data] data to send. Will become querystring for GET, body for POST
   * @param {object} [options = {}] Object containing needle-compatible HTTP options
   * @return {Promise<*>}
   */
  mainFunction.get = (url, data, options) => {
    return mainFunction('GET', url, data, options);
  };

  /**
   * Helper function to make a POST request
   * @param {string} url URL to request
   * @param {object} [data] data to send. Will become querystring for GET, body for POST
   * @param {object} [options = {}] Object containing needle-compatible HTTP options
   * @return {Promise<*>}
   */
  mainFunction.post = (url, data, options) => {
    return mainFunction('POST', url, data, options);
  };

  /**
   * Helper function to make a PUT request
   * @param {string} url URL to request
   * @param {object} [data] data to send. Will become querystring for GET, body for POST
   * @param {object} [options = {}] Object containing needle-compatible HTTP options
   * @return {Promise<*>}
   */
  mainFunction.put = (url, data, options) => {
    return mainFunction('PUT', url, data, options);
  };

  /**
   * Helper function to make a DELETE request
   * @param {string} url URL to request
   * @param {object} [data] data to send. Will become querystring for GET, body for POST
   * @param {object} [options = {}] Object containing needle-compatible HTTP options
   * @return {Promise<*>}
   */
  mainFunction.delete = (url, data, options) => {
    return mainFunction('DELETE', url, data, options);
  };

  /**
   * Helper function to make a PATCH request
   * @param {string} url URL to request
   * @param {object} [data] data to send. Will become querystring for GET, body for POST
   * @param {object} [options = {}] Object containing needle-compatible HTTP options
   * @return {Promise<*>}
   */
  mainFunction.patch = (url, data, options) => {
    return mainFunction('PATCH', url, data, options);
  };

  /**
   * Helper function to make a HEAD request
   * @param {string} url URL to request
   * @param {object} [data] data to send. Will become querystring for GET, body for POST
   * @param {object} [options = {}] Object containing needle-compatible HTTP options
   * @return {Promise<*>}
   */
  mainFunction.head = (url, data, options) => {
    return mainFunction('HEAD', url, data, options);
  };

  /**
   * Helper function to make a OPTIONS request
   * @param {string} url URL to request
   * @param {object} [data] data to send. Will become querystring for GET, body for POST
   * @param {object} [options = {}] Object containing needle-compatible HTTP options
   * @return {Promise<*>}
   */
  mainFunction.options = (url, data, options) => {
    return mainFunction('OPTIONS', url, data, options);
  };

  /**
   * Helper function to make a TRACE request
   * @param {string} url URL to request
   * @param {object} [data] data to send. Will become querystring for GET, body for POST
   * @param {object} [options = {}] Object containing needle-compatible HTTP options
   * @return {Promise<*>}
   */
  mainFunction.trace = (url, data, options) => {
    return mainFunction('TRACE', url, data, options);
  };

  /**
   * Customise the network function used for this instance of the HTTP lib
   * @param {*} fn 
   */
  mainFunction.setOverrideFunction = (fn) => {
    this.customOverrideFunc = fn;
  };

  return mainFunction;
});


export default HTTP;
