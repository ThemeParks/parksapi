import CacheBase from './cacheBase.js';
import path from 'path';

import {open} from 'lmdb-store';

/**
 * A cache implementation using LMDB
 * @extends CacheBase
 * @class
 */
export default class CacheLmdb extends CacheBase {
  /**
   * Create new Memory cache object
   * @param {object} options
   */
  constructor(options = {}) {
    super(options);

    // setup our database
    this.db = open({
      path: path.join(process.cwd(), 'db.datacache'),
      compression: true,
    });
  }

  /**
   * @inheritdoc
   */
  async _get(key) {
    return this.db.get(key);
  }

  /**
   * @inheritdoc
   */
  async _set(key, object) {
    await this.db.put(key, object);
  }

  /**
   * @inheritdoc
   */
  async _del(key) {
    await this.db.remove(key);
  }

  /**
   * @inheritdoc
   */
  async _getKeys(prefix) {
    const keys = [];
    for (const key of this.db.getKeys()) {
      keys.push(key);
    }
    return keys;
  }
}
