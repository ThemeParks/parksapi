import sqlite3 from 'sqlite3';

import CacheBase from './cacheBase.js';

/**
 * Caching implementation using SQLite
 * @extends CacheBase
 */
export default class CacheSqlite extends CacheBase {
  /**
     * @param {object} options
     * @property {string} options.filename Database filename to use with Sqlite
     * @property {Object} [options.db] Existing SQLite3 object to use for our database
     *  If left empty, a database object will be created automatically
     */
  constructor(options = {
    filename: ':memory:',
    db: undefined,
  }) {
    options.useMemoryCache = false;

    super(options);

    const dbFilename = options.filename || ':memory:';
    this.db = options.db || new sqlite3.Database(dbFilename);

    this.init = false;
  }

  /**
   * Run a query against our SQLite database
   * @param {string} query
   * @param {array} args
   */
  async runQuery(query, args) {
    return new Promise((resolve, reject) => {
      this.db.get(query, args, (err, result) => {
        if (err) {
          return reject(err);
        }
        resolve(result);
      });
    });
  }

  /**
   * @private
   * Setup the database ready for use
   */
  async setupDB() {
    if (this.init) return;

    // setup our database
    this.db.serialize(() => {
      this.db.run('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT, expires BIGINT)');
    });

    this.init = true;
  }

  /**
   * @private
   * Get a cache entry by key
   * @param {string} key
   */
  async _get(key) {
    await this.setupDB();

    const row = await this.runQuery('SELECT value FROM cache WHERE key = ? AND expires >= ?', [key, +new Date()]);
    if (!row) return undefined;

    try {
      return JSON.parse(row.value);
    } catch (e) {
    }
    return undefined;
  }

  /**
   * @private
   * Set a cache entry
   * @param {string} key
   * @param {object} value
   * @param {*} ttl
   */
  async _set(key, value, ttl) {
    await this.setupDB();

    await this.runQuery(
        'INSERT OR REPLACE INTO cache (key, value, expires) VALUES (?, ?, ?)',
        [
          key,
          JSON.stringify(value),
          (+new Date()) + ttl,
        ]);
  }
}
