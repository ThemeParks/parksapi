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
      return cacheEntry;
    }

    return undefined;
  }

  /**
   * @inheritdoc
   */
  async _set(key, object) {
    this.cache[key] = object;
  }

  /**
   * @inheritdoc
   */
  async _del(key) {
    if (this.cache[key]) {
      delete this.cache[key];
    }
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
