import CacheBase from './cacheBase.js';

/**
 * A basic in-memory cache implementation
 * @extends CacheBase
 * @class
 */
export default class CacheMemory extends CacheBase {
  /**
   * Create new Memory cache object
   * @param {object} options
   */
  constructor(options) {
    // disable our internal memory cache, since this is exactly what this implementation is already doing
    options.useMemoryCache = false;

    super(options);

    this.cache = {};
  }

  /**
   * @inheritdoc
   */
  async _get(key) {
    const cacheEntry = this.cache[key];

    if (cacheEntry !== undefined) {
      const now = +new Date();
      if (cacheEntry.expires >= now) {
        return cacheEntry.value;
      }
    }

    return undefined;
  }

  /**
   * @inheritdoc
   */
  async _set(key, value, ttl) {
    this.cache[key] = {
      value,
      expires: (+ new Date()) + ttl,
    };
  }

  /**
   * @inheritdoc
   */
  async _getKeys(prefix) {
    return Object.keys(this.cache).filter((key) => {
      return key.indexOf(prefix) === 0;
    });
  }
}
