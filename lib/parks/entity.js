import ConfigBase from '../configBase.js';
import moment from 'moment-timezone';
import HarWriter from '../har.js';
import sift from 'sift';
import {URL} from 'url';
import randomUseragent from 'random-useragent';
import needle from 'needle';
import zlib from 'zlib';
import util from 'util';

const zDecompress = util.promisify(zlib.unzip);
const zCompress = util.promisify(zlib.deflate);

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
  new HarWriter({filename: `${process.env['THEMEPARKS_HAR']}.har`}):
  null;

/**
 * A super-class that Parks/Resorts/etc. inherit from.
 * Handles general logic for objects that are a place/entity.
 */
export class Entity extends ConfigBase {
  /**
   * Construct a new Entity
   * @param {object} options
   */
  constructor(options = {}) {
    // offline mode, never request any data, rely on manually serialised data to run
    options.offline = options.offline || false;

    // generate a random Android user-agent if we aren't supplied one
    options.useragent = options.useragent || generateRandomAndroidUseragent();

    super(options);

    if (!options.name) {
      throw new Error(`Missing name for constructed Entity object ${this.constructor.name}`);
    }

    if (!options.timezone) {
      throw new Error(`Missing timezone for constructed Entity object ${this.constructor.name}`);
    }
    if (moment.tz.names().indexOf(options.timezone) < 0) {
      throw new Error(`Entity object ${this.constructor.name} gives an invalid timezone: ${options.timezone}`);
    }

    // any HTTP injections that have been setup
    //  allows parks to automatically intercept HTTP requests and add auth headers etc.
    this._httpInjections = [];

    // offline function data
    this._offlineFunctions = [];
    this._offlineData = {};
    this._hasOfflineData = false;
    this._offlinePromise = null;
    this._offlinePromiseResolve = null;
  }

  /**
   * Get a globally unique ID for this entity
   * @return {string}
   */
  getUniqueID() {
    // by default, return the class name
    return this.constructor.name;
  }

  /**
   * Return the current time for this entity in its local timezone
   * @return {moment}
   */
  getTimeNowMoment() {
    return moment().tz(this.config.timezone);
  }

  /**
   * Return the current time for this entity in its local timezone
   * @return {string}
   */
  getTimeNow() {
    return this.getTimeNowMoment().format();
  }

  /**
   * Get entity's human-friendly name string
   * @return {string}
   */
  get name() {
    return this.config.name;
  }

  /**
   * Is this object operating offline?
   */
  get offline() {
    return !!this.config.offline;
  }

  /**
   * Register a function on this entity for offline access
   * @param {string} functionName
   */
  registerOfflineFunction(functionName) {
    if (this[functionName] && typeof this[functionName] === 'function') {
      if (this._offlineFunctions.indexOf(functionName) < 0) {
        this._offlineFunctions.push(functionName);

        // if we're in offline mode...
        if (this.offline) {
          // override function and restore from our data cache instead
          this[functionName] = async () => {
            await this.ensureHasOfflineData();

            if (this._offlineData[functionName] !== undefined) {
              return this._offlineData[functionName];
            }
            return undefined;
          };
        }
      }
    }
  }

  /**
   * Called after loading serialised offline data
   */
  async _postOfflineLoad() {}

  /**
   * Serialise this entity
   * @param {object} bundle Bundle to read/write from/to
   * @param {boolean} saving Whether we are saving or loading during this serialise operation
   * @param {object} [options]
   * @param {number} [options.version=1] Version of the seialised data
   * @param {boolean} [options.recursive=true] Recurse through attached entities?
   */
  async serialise(bundle = {}, saving = true, options = {
    version: 1,
    recursive: true,
  }) {
    if (saving) {
      // === Saving ===
      // default options
      bundle.version = options.version;
      bundle.ar = {
        functions: {},
        children: [],
      };

      // loop over all offline functions and store their data
      for (let i=0; i<this._offlineFunctions.length; i++) {
        const functionName = this._offlineFunctions[i];
        bundle.ar.functions[functionName] = await this[functionName]();
      }

      // TODO - loop over child entities, call serialise on them, then store their bundle.ar in ours
    } else {
      // === Loading ===
      // decompress/load the data
      const bundleBuffer = await zDecompress(bundle);
      bundle = JSON.parse(bundleBuffer.toString('utf8'));

      const version = bundle.version || 0;
      // check we understand this bundle version
      if (version !== 1) {
        throw new Error('Unable to load serialised bundle version', version);
      }

      // restore function data
      this._offlineData = bundle.ar.functions;

      // TODO - restore child entities
    }

    if (saving) {
      // pack and gz to buffer
      const bundleData = JSON.stringify(bundle);
      return await zCompress(bundleData);
    }

    // after loading, run any postUpdate functions
    this._postOfflineLoad();

    this._hasOfflineData = true;

    // check if any process if waiting for offline data to be ready
    if (this._offlinePromiseResolve !== null) {
      this._offlinePromiseResolve();
      this._offlinePromiseResolve = null;
      this._offlinePromise = null;
    }
  }

  /**
   * Await until offline data is present
   */
  async ensureHasOfflineData() {
    if (this.offline && !this._hasOfflineData) {
      if (this._offlinePromise === null) {
        this._offlinePromise = new Promise((resolve) => {
          this._offlinePromiseResolve = resolve;
        });
      }
      return this._offlinePromise;
    }
  }

  /**
   * Register a new injection for a specific domain
   * @param {object} filter Mongo-type query to use to match a URL
   * @param {function} func Function to call with needle request to inject extra data into.
   * Function will take arguments: (method, URL, data, options)
   */
  async injectForDomain(filter, func) {
    // add to our array of injections, this is processing by http()
    this._httpInjections.push({
      filter: sift(filter),
      func,
    });
  }

  /**
   * Helper function to make an HTTP request for this park
   * Parks can automatically add in authentication headers etc. to requests sent to this function
   * @param {string} method HTTP method to use (GET,POST,DELETE, etc)
   * @param {string} url URL to request
   * @param {object} [data] data to send. Will become querystring for GET, body for POST
   * @param {object} [options] Object containing needle-compatible HTTP options
   */
  async http(method, url, data = {}, options = {}) {
    if (this.offline) {
      // TODO - log these instances somewhere, should never be making HTTP requests in offline mode
      console.trace(`[OFFLINE] Skipping HTTP request ${method} ${url}`);
      return;
    }

    // always have a headers array
    if (!options.headers) {
      options.headers = {};
    }

    // default to accepting compressed data
    options.compressed = options.compressed === undefined ? true : options.compressed;

    // inject custom standard user agent (if we have one)
    //  do this before any custom injections so parks can optionally override this for each domain
    if (this.config.useragent) {
      options.headers['user-agent'] = this.config.useragent;
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
    for (let injectionIDX=0; injectionIDX<this._httpInjections.length; injectionIDX++) {
      const injection = this._httpInjections[injectionIDX];

      // check if the domain matches
      if (injection.filter(urlFilter)) {
        await injection.func(method, url, data, options);
      }
    }

    const startMs = +new Date();
    const startTime = moment(startMs).toISOString();

    return needle(method, url, data, options).then(async (resp) => {
      // intercept response to write to our .har file
      if (harWriter) {
        const timeTaken = (+new Date()) - startMs;

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

      return resp;
    });
  }
}

export default Entity;
