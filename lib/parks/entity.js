import ConfigBase from '../configBase.js';
import moment from 'moment-timezone';
import zlib from 'zlib';
import util from 'util';
import HTTP from './http.js';

const zDecompress = util.promisify(zlib.unzip);
const zCompress = util.promisify(zlib.deflate);

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
    options.useragent = options.useragent || null;

    super(options);

    if (!this.config.name) {
      throw new Error(`Missing name for constructed Entity object ${this.constructor.name}`);
    }

    if (!this.config.timezone) {
      throw new Error(`Missing timezone for constructed Entity object ${this.constructor.name}`);
    }
    if (moment.tz.names().indexOf(this.config.timezone) < 0) {
      throw new Error(`Entity object ${this.constructor.name} gives an invalid timezone: ${this.config.timezone}`);
    }

    this.http = new HTTP();
    if (this.config.useragent) {
      this.http.useragent = this.config.useragent;
    }

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
    this.http.injectForDomain(filter, func);
  }
}

export default Entity;
