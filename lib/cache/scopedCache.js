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

    // list of keys pending read/write locks
    this.transactionKeys = [];
    this.pendingLocks = [];
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
   * Block until the requested key is no longer locked in a transaction
   * @param {string} key
   */
  async blockUntilKeyFree(key) {
    if (this.transactionKeys.indexOf(key) < 0) {
      return;
    }

    return new Promise((resolve) => {
      this.pendingLocks.push({
        key,
        resolve: () => {
          if (this.transactionKeys.indexOf(key) >= 0) {
            return this.blockUntilKeyFree(key);
          }

          return resolve();
        },
      });
    });
  }

  /**
   * Create a read/write lock.
   * Use the returned object to interact with cache in a safe way.
   * @return {Object} Read/Write Manager
   */
  createLock() {
    const locks = [];

    const releaseLocks = async () => {
      // remove all transaction keys we are currently locking
      locks.forEach((lock) => {
        this.transactionKeys.splice(this.transactionKeys.indexOf(lock.key), 1);
      });
    };

    const releaseBlocks = async () => {
      // release any blocking promises
      for (let lockIDX = 0; lockIDX < locks.length; lockIDX++) {
        for (let i=0; i<this.pendingLocks.length; i++) {
          if (this.pendingLocks[i].key === locks[lockIDX].key) {
            if (this.transactionKeys.indexOf(locks[lockIDX].key) < 0) {
              await this.pendingLocks[i].resolve();

              this.pendingLocks.splice(i, 1);
              i--;
            }
          }
        }
      }
    };

    return {
      get: async (key) => {
        // look for any existing locked data first, and return that
        const lockedData = locks.find((x) => x.key === key);
        if (lockedData) {
          return lockedData.value;
        }

        while (this.transactionKeys.indexOf(key) >= 0) {
          await this.blockUntilKeyFree(key);
        }

        this.transactionKeys.push(key);

        const value = await this.get(key, true);

        locks.push({key, value, write: false});

        // return key as normal
        return value;
      },
      set: async (key, value, ttl) => {
        // helper function to check locks and update the existing record with new write data
        const updateExistingLockedData = () => {
          const lockedData = locks.find((x) => x.key === key);
          if (lockedData) {
            lockedData.value = value;
            lockedData.ttl = ttl;
            lockedData.write = true;
            return true;
          }
          return false;
        };

        // if we already have a lock in this lock object, then update it's entry
        if (updateExistingLockedData()) {
          return;
        }

        // check for existing transactions first, and block until free again
        while (this.transactionKeys.indexOf(key) >= 0) {
          // this means another transaction has lock for this key, so block until we're free again
          await this.blockUntilKeyFree(key);
        }

        // check our lockedData again, a GET request while we were blocked may have added an entry
        if (updateExistingLockedData()) {
          return;
        }

        // add to our internal locks
        locks.push({
          key,
          value,
          ttl,
          write: true,
        });

        this.transactionKeys.push(key);
      },
      commit: async () => {
        // release locks first so our set() calls can go through
        await releaseLocks();

        // commit all locks with write === true
        for (let i=0; i<locks.length; i++) {
          if (locks[i].write) {
            await this.set(locks[i].key, locks[i].value, locks[i].ttl);
          }
        }

        // then release all our Promise blocks
        releaseBlocks();
      },
      rollback: async () => {
        await releaseLocks();
        releaseBlocks();
      },
    };
  }

  /**
     * Get a cached object
     * @public
     * @async
     * @param {string} key Unique key name for this cache entry
     * @param {boolean} [force=false]
     * @return {(Object|undefined)} Returns the object in the cache, or undefined if not present
     */
  async get(key, force=false) {
    // check for any read/write locks
    if (!force && this.transactionKeys.indexOf(key) >= 0) {
      // block until key is free of any transactions
      await this.blockUntilKeyFree(key);
    }

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
    // check for any read/write locks
    if (this.transactionKeys.indexOf(key) >= 0) {
      // block until key is free of any transactions
      await this.blockUntilKeyFree(key);
    }

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
