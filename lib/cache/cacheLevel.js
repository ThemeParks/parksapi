import CacheBase from './cacheBase.js';
import level from 'level';

/**
 * A cache implementation using LevelDown
 * @extends CacheBase
 * @class
 */
export default class CacheLevel extends CacheBase {
  /**
   * Create new Memory cache object
   * @param {object} options
   */
  constructor(options = {}) {
    options.useMemoryCache = false;

    super(options);

    // setup our Level database
    this.db = level('db.cache');
  }

  /**
   * Get a cached object by key
   * @param {string} key
   * @private
   */
  async _get(key) {
    const cacheEntry = await this.db.get(key);

    if (cacheEntry !== undefined) {
      const cacheEntryData = JSON.parse(cacheEntry);
      const now = +new Date();
      if (cacheEntryData.expires >= now) {
        return cacheEntryData.value;
      }
    }

    return undefined;
  }

  /**
   * Set a key
   * @param {string} key
   * @param {object} value
   * @param {*} [ttl]
   * @private
   */
  async _set(key, value, ttl) {
    await this.db.put(key, JSON.stringify({
      value,
      expires: (+ new Date()) + ttl,
    }));
  }
}
