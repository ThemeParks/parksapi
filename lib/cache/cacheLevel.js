import CacheBase from './cacheBase.js';
import levelup from 'levelup';
import leveldown from 'leveldown';
import memdown from 'memdown';
import path from 'path';

const memory = false;

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
    super(options);

    // setup our Level database
    if (memory) {
      this.db = levelup(memdown());
    } else {
      this.db = levelup(leveldown(path.join(process.cwd(), 'db.cache')));
    }
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
          keys.push(data.toString());
        }
      });
      keyStream.on('end', () => {
        return resolve(keys);
      });
    });
  }
}
