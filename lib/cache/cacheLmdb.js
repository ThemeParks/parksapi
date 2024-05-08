import CacheBase from './cacheBase.js';
import path from 'path';
import fs from 'fs';

import {open} from 'lmdb';

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

    // make sure our cache directory exists
    const cacheDirPath = path.join(process.cwd(), 'datacache');
    if (!fs.existsSync(cacheDirPath)) {
      fs.mkdirSync(cacheDirPath);
    }
    
    const cacheDbpath = path.join(cacheDirPath, 'cache.lmdb');

    // setup our database
    this.db = open({
      path: cacheDbpath,
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
      if (!prefix || key.startsWith(prefix)) {
        keys.push(key);
      }
    }
    return keys;
  }
}
