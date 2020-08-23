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
   */
  constructor(keyPrefix, version = 0) {
    this.prefix = keyPrefix;
    this.version = version;

    this.cache = null;
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

    this.cache = await getCache();

    // check and flush cache if version mismatch
    const cacheVersion = await this.cache.get(this.generateScopedKey('%%version%%'));
    if (cacheVersion !== undefined && cacheVersion != this.version) {
      // find all cache entries with this scope, and remove them
      const keys = await this.cache.getKeys(`${this.prefix}_`);

      await Promise.allSettled(keys.map((key) => {
        // set expire date to 1 millisecond ago (this basically deletes it)
        return this.cache.setGlobal(key, {}, -1);
      }));
    }

    // set our new cache version with a very very long ttl
    await this.cache.set('%%version%%', this.generateScopedKey(this.version), Number.MAX_SAFE_INTEGER);
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
     * @return {(Object|undefined)} Returns the object in the cache, or undefined if not present
     */
  async get(key) {
    return this.getGlobal(this.generateScopedKey(key));
  }

  /**
     * Get a cached object from the global cache (skipping the scope prefix)
     * @public
     * @async
     * @param {string} key Unique key name for this cache entry
     * @return {(Object|undefined)} Returns the object in the cache, or undefined if not present
     */
  async getGlobal(key) {
    const cache = await this.initCache();
    return cache.get(key);
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
}

export default ScopedCache;
