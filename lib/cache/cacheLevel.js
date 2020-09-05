import CacheBase from './cacheBase.js';
import level from 'level';
import path from 'path';

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
    this.db = level(path.join(process.cwd(), 'db.cache'));
  }

  /**
   * @inheritdoc
   */
  async _get(key) {
    try {
      const cacheEntry = await this.db.get(key);
      if (cacheEntry !== undefined) {
        return JSON.parse(cacheEntry);
      }
    } catch (err) {
      // ignore NotFoundError, throw any other errors back up the chain
      if (err.name !== 'NotFoundError') {
        throw err;
      }
    }

    return undefined;
  }

  /**
   * @inheritdoc
   */
  async _set(key, object) {
    await this.db.put(key, JSON.stringify(object));
  }

  /**
   * @inheritdoc
   */
  async _del(key) {
    await this.db.del(key);
  }

  /**
   * @inheritdoc
   */
  async _getKeys(prefix) {
    return new Promise((resolve) => {
      const keys = [];
      const keyStream = this.db.createKeyStream();
      keyStream.on('data', (data) => {
        if (data.indexOf(prefix) === 0) {
          keys.push(data);
        }
      });
      keyStream.on('end', () => {
        return resolve(keys);
      });
    });
  }
}
