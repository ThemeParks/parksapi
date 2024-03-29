import {getCache} from '../cache.js';
import {reusePromiseForever} from '../reusePromises.js';

/**
 * A wrapper class for accessing the cache.
 * Prefixes a string before each key to avoid conflicts.
 */
export class ScopedCache {
  /**
   * Create a new ScopedCache object by passing in the key prefix descired
   * @param {string} keyPrefix
   * @param {number} [version] Cache version, bump this to invalidate existing cache entries for a scope
   * @param {object} [cacheObject=null] Manually supply a cache object to use
   */
  constructor(keyPrefix, version = 0, cacheObject = null) {
    this.prefix = keyPrefix;
    this.version = version;

    this.cache = null;
    this.cacheOverride = cacheObject;
  }

  /**
   * Initialise the cache for this scope
   */
  async initCache() {
    return await reusePromiseForever(this, this._initCache);
  }

  /**
   * Internal cache initialisation
   */
  async _initCache() {
    if (this.cache) {
      return this.cache;
    }

    if (!!this.cacheOverride) {
      this.cache = this.cacheOverride;
    } else {
      this.cache = await getCache();
    }

    // check and flush cache if version mismatch
    const cacheVersion = await this.cache.get(this.generateScopedKey('%%version%%'));
    if (cacheVersion !== undefined && cacheVersion != this.version) {
      // find all cache entries with this scope, and remove them
      const keys = await this.cache.getKeys(`${this.prefix}_`);

      await Promise.allSettled(keys.map((key) => {
        // set expire date to 1 millisecond ago (this basically deletes it)
        return this.cache.set(key, {}, -1);
      }));
    }

    // set our new cache version with a very very long ttl
    await this.cache.set(this.generateScopedKey('%%version%%'), this.version, Number.MAX_SAFE_INTEGER);
    this._initCachePromise = null;

    return this.cache;
  }

  /**
   * Generate a scoped key by adding our prefix to the incoming key
   * @param {string} inKey
   * @return {string} Scoped key
   */
  generateScopedKey(inKey) {
    return `${this.prefix}_${inKey}`;
  }

  /**
     * Get a cached object
     * @public
     * @async
     * @param {string} key Unique key name for this cache entry
     * @param {boolean} [getFullObject] Get the full cache entry, including expiry time, even if expired
     * @param {boolean} [force=false] Force set, bypassing transaction blocks
     * @return {(Object|undefined)} Returns the object in the cache, or undefined if not present
     */
  async get(key, getFullObject = false, force = false) {
    return this.getGlobal(this.generateScopedKey(key), getFullObject, force);
  }

  /**
     * Get a cached object from the global cache (skipping the scope prefix)
     * @public
     * @async
     * @param {string} key Unique key name for this cache entry
     * @param {boolean} [getFullObject] Get the full cache entry, including expiry time, even if expired
     * @param {boolean} [force=false] Force set, bypassing transaction blocks
     * @return {(Object|undefined)} Returns the object in the cache, or undefined if not present
     */
  async getGlobal(key, getFullObject = false, force = false) {
    const cache = await this.initCache();
    return cache.get(key, getFullObject, force);
  }

  /**
     * Set a key in our cache
     * @public
     * @async
     * @param {string} key Unique key name for this cache entry
     * @param {Object} value
     * @param {(Function|number)} [ttl=3600000] How long the cache entry should last in milliseconds
     *  Can be a number or a function that will return a number
     *  Default 1 hour
     */
  async set(key, value, ttl = 3600000) {
    return this.setGlobal(this.generateScopedKey(key), value, ttl);
  }

  /**
     * Set a key in our global cache, skipping the scoped prefix
     * @public
     * @async
     * @param {string} key Unique key name for this cache entry
     * @param {Object} value
     * @param {(Function|number)} [ttl=3600000] How long the cache entry should last in milliseconds
     *  Can be a number or a function that will return a number
     *  Default 1 hour
     */
  async setGlobal(key, value, ttl = 3600000) {
    const cache = await this.initCache();
    return cache.set(key, value, ttl);
  }

  /**
     * A helper "wrap" function that will return a cached value if present
     *  This will call the supplied function to fetch it if the value isn't present in the cache
     * @public
     * @async
     * @param {string} key Unique key name for this cache entry
     * @param {function} fn Fetch function that will be called if the cache entry is not present
     * @param {(function|number)} [ttl] How long the cache entry should last in milliseconds
     *  Can be a number or a function that will return a number
     */
  async wrap(key, fn, ttl) {
    return this.wrapGlobal(this.generateScopedKey(key), fn, ttl);
  }

  /**
     * A helper "wrap" function that will return a cached value if present (in the global scope)
     *  This will call the supplied function to fetch it if the value isn't present in the cache
     * @public
     * @async
     * @param {string} key Unique key name for this cache entry
     * @param {function} fn Fetch function that will be called if the cache entry is not present
     * @param {(function|number)} [ttl] How long the cache entry should last in milliseconds
     *  Can be a number or a function that will return a number
     */
  async wrapGlobal(key, fn, ttl) {
    const cache = await this.initCache();
    return cache.wrap(key, fn, ttl);
  }

  /**
   * Run a series of functions in a single transaction
   * @param {functions} func
   * @return {promise}
   */
  async runTransaction(func) {
    const cache = await this.initCache();
    return cache.runTransaction(func, (key) => {
      return this.generateScopedKey(key);
    });
  }

  /**
   * Block if we have any pending transactions
   * @return {Promise}
   */
  async blockOnPendingTransactions() {
    const cache = await this.initCache();
    return cache.blockOnPendingTransactions();
  }

  /**
   * Get an array of all the cached keys matching the supplied prefix
   * @param {string} [prefix='']
   * @return {array<string>}
   */
  async getKeys(prefix = '') {
    const cache = await this.initCache();
    return (await cache.getKeys(`${this.prefix}_${prefix}`)).map((x) => {
      // return keys without our scoped cache prefix
      return x.slice(this.prefix.length + 1);
    });
  }
}

export default ScopedCache;
