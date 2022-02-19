import fs from 'fs';

/**
 * Our base Cache implementation
 * Extend this class with new implementations to create different cache types (in-memory, database, file system etc.)
 * @class
 */
export default class CacheBase {
  /**
     * @param {Object} options
     */
  constructor(options = {}) {
    // stack up multiple cache wraps so they wait for a single request to finish
    this.pendingCacheWraps = {};

    this.failedCacheWraps = {};

    this.pendingLocks = [];
    this.hasPendingLocks = false;
  }

  /**
     * Internal implementation of Get()
     * @param {string} key Unique key name for this cache entry
     * @return {(Object|undefined)} Returns the object in the cache, or undefined if not present
     * @abstract
     * @private
     */
  async _get(key) {
    throw new Error('Missing Implementation CacheBase::_get(key)');
  }

  /**
     * Internal implementation of Set()
     * @param {string} key Unique key name for this cache entry
     * @param {Object} object Data to be set
     * @abstract
     * @private
     */
  async _set(key, object) {
    throw new Error('Missing Implementation CacheBase::_set(key, object)');
  }

  /**
     * Internal operation to delete a key
     * @param {string} key Key name to delete
     * @abstract
     * @private
     */
  async _del(key) {
    throw new Error('Missing Implementation CacheBase::_del(key)');
  }

  /**
     * Internal implementation of getKeys()
     * @param {string} prefix
     * @abstract
     * @private
     */
  async _getKeys(prefix) {
    throw new Error('Missing Implementation CacheBase::_getKeys(prefix)');
  }

  /**
     * Get a cached object
     * @param {string} key Unique key name for this cache entry
     * @param {boolean} [getFullObject] Get the full cache entry, including expiry time, even if expired
     * @param {boolean} [force=false] Force set, bypassing transaction blocks
     * @return {(Object|undefined)} Returns the object in the cache, or undefined if not present
     */
  async get(key, getFullObject = false, force = false) {
    if (!force) {
      await this.blockOnPendingTransactions();
    }

    const now = +new Date();

    // then use our internal cache if we haven't got the value stored locally
    const cacheValue = await this._get(key);
    if (cacheValue !== undefined) {
      if (getFullObject) {
        return cacheValue;
      }

      if (cacheValue.expires >= now) {
        return cacheValue.value;
      }
    }

    return undefined;
  }

  /**
     * Set a key in our cache
     * @param {string} key Unique key name for this cache entry
     * @param {Object} value
     * @param {(Function|number)} [ttl=3600000] How long the cache entry should last in milliseconds
     * @param {boolean} [force=false] Force set, bypassing transaction blocks
     *  Can be a number or a function that will return a number
     *  Default 1 hour
     */
  async set(key, value, ttl = 3600000, force = false) {
    // resolve our cache time
    let cacheTime = ttl;
    // if our cache time input is a function, resolve it and store the result (in milliseconds)
    if (typeof cacheTime === 'function') {
      cacheTime = await cacheTime();
    }

    if (!force) {
      await this.blockOnPendingTransactions();
    }

    if (cacheTime < 0) {
      // delete key if ttl is negative
      await this._del(key);
    } else {
      // call the private _Set implementation to actually set the key
      await this._set(key, {
        value,
        expires: (+new Date()) + cacheTime,
      });
    }
  }

  /**
     * A helper "wrap" function that will return a cached value if present
     *  This will call the supplied function to fetch it if the value isn't present in the cache
     * @param {string} key Unique key name for this cache entry
     * @param {function} fn Fetch function that will be called if the cache entry is not present
     * @param {(function|number)} [ttl] How long the cache entry should last in milliseconds
     *  Can be a number or a function that will return a number
     */
  async wrap(key, fn, ttl) {
    // if another system is already wrapping this key, return it's pending Promise
    if (this.pendingCacheWraps[key] !== undefined) {
      return this.pendingCacheWraps[key];
    }

    // wrap all await calls in another Promise that we store
    //  this allows multiple calls to Wrap to stack up, and they all get the same result
    this.pendingCacheWraps[key] = new Promise(async (resolve) => {
      // try and fetch the cached value
      const cachedValue = await this.get(key, true);

      // if not in our cache, call the supplied fetcher function
      if (cachedValue !== undefined) {
        // check timestamp to see if value is still valid
        const now = +new Date();
        if (cachedValue.expires > now) {
          // it is! return it!
          return resolve(cachedValue.value);
        }
        // it isn't! fall through and run our wrap function to get new data
      }

      let error = null;
      try {
        const newValue = await fn();

        // set the new value in our cache
        this.failedCacheWraps[key] = 0;
        await this.set(key, newValue, ttl);
        return resolve(newValue);
      } catch (e) {
        // store in case we want to throw this later
        error = e;
        console.error(`Error caching value ${key}`, e);
      }

      if (this.failedCacheWraps[key] === undefined) {
        this.failedCacheWraps[key] = 0;
      }
      this.failedCacheWraps[key]++;

      // failed! store old data briefly, then return old data back
      await this.set(key, cachedValue?.value, 1000 * 30); // try again in 30 seconds
      if (this.failedCacheWraps[key] > 5) {
        // report after multiple failures
        if (error !== null) {
          // throw the actual error if we had one
          throw error;
        }
        throw new Error(`Failed to resolve wrap function for cache key ${key}`);
      }
      return resolve(cachedValue?.value);
    });
    const cachedValue = await this.pendingCacheWraps[key];
    this.pendingCacheWraps[key] = undefined;

    // if debugging, store data to disk
    if (process.env.DEBUG_WRITE) {
      if (!fs.existsSync('./debug_cache')) {
        fs.mkdirSync('./debug_cache');
      }
      fs.writeFileSync(`debug_cache/${key.replace(/[^a-zA-Z0-9_-]/g, '')}.json`, JSON.stringify(cachedValue, null, 2));
    }

    // return the fetched or calculated value
    return cachedValue;
  }

  /**
   * Get an array of all the cached keys matching the supplied prefix
   * @param {string} [prefix='']
   * @return {array<string>}
   */
  async getKeys(prefix = '') {
    return this._getKeys(prefix);
  }

  /**
   * Run a transaction.
   * All other queries are halted while this is running
   * @param {function} func
   * @param {function} [keyModifierFunc=null] Optional function that translates incoming keys
   */
  async runTransaction(func, keyModifierFunc = null) {
    // function to convert key names (used by scopedCache)
    const keyNamer = keyModifierFunc ? keyModifierFunc : (key) => key;

    return new Promise(async (resolve) => {
      this.pendingLocks.push(async () => {
        // call function with a helper stub with core functions
        //  use this to make requests inside transaction
        await func({
          get: async (key, getFullObject) => {
            return this.get(keyNamer(key), getFullObject, true);
          },
          set: async (key, value, ttl) => {
            return this.set(keyNamer(key), value, ttl, true);
          },
        });
        resolve();
      });

      // process all our pending locks
      if (!this.hasPendingLocks) {
        this.hasPendingLocks = true;
        while (this.pendingLocks.length > 0) {
          const currLock = this.pendingLocks.shift();
          await currLock();
        }
        this.hasPendingLocks = false;
      }
    });
  }

  /**
   * Block if we have any pending transactions
   * @return {Promise}
   */
  async blockOnPendingTransactions() {
    if (this.hasPendingLocks) {
      return new Promise((resolve) => {
        this.pendingLocks.push(resolve);
      });
    }
  }
}
