import ConfigBase from '../configBase.js';
import sieve from './sieve.js';
import {reusePromise, reusePromiseForever} from '../reusePromises.js';
import HTTP from './http.js';
import Cache from '../cache/scopedCache.js';

const Databases = {};

/**
 * A class that handles fetching and storing data for a resort/park
 */
export class Database extends ConfigBase {
  /**
   * Construct a new Database object
   * @param {object} options
   */
  constructor(options = {}) {
    options.useragent = options.useragent || null;

    super(options);

    this.cache = new Cache(this.constructor.name, this.config.cacheVersion || 0);

    this.http = new HTTP();
    if (this.config.useragent) {
      this.http.useragent = this.config.useragent;
    }

    this.http.injectForDomain({hostname: {$exists: true}}, (method, url) => {
      this.log(method, url);
    });
  }

  /**
   * Pretty print log for this database
   */
  log(...args) {
    console.log(`[\x1b[32m${this.constructor.name}\x1b[0m]`, ...args);
  }

  /**
   * Get singleton of this class type
   * @param {object} [options] Options to pass to new instance.
   * Will only be used if the instance doesn't already exist
   * @return {Database}
   */
  static get(options = {}) {
    const className = this.name;
    if (Databases[className] === undefined) {
      Databases[className] = new this(options);
    }
    return Databases[className];
  }

  /**
   * Initialise this database object
   */
  async init() {
    // only ever call _init once
    await reusePromiseForever(this, this._init);
  }

  /**
   * Internal init function, override this in child classes for functionality
   * @abstract
   */
  async _init() {}

  /**
   * Get entities from this database. Optionally filtering by some conditions
   * @param {object} [filter]
   */
  async getEntities(filter = {}) {
    await this.init();

    const entities = await this.cache.wrap('entities', () => {
      return reusePromise(this, this._getEntities);
    }, 1000 * 60); // cache for a minute for faster access

    const filterFn = sieve(filter);
    return entities.filter(filterFn);
  }

  /**
   * Find a single entity from this database
   * @param {object} [filter]
   */
  async findEntity(filter = {}) {
    const ents = await this.getEntities();
    const filterFn = sieve(filter);
    return ents.find(filterFn);
  }

  /**
   * Return all entities for this resort/park
   * @abstract
   * @return {array<object>}
   */
  async _getEntities() {
    throw new Error(`Database class ${this.constructor.name} missing _getEntities() function`);
  }

  /**
   * Get an entity object from it's ID
   * @param {string} entityId Entity ID
   */
  async getEntitiyById(entityId) {
    return await this.findEntity({
      id: `${entityId}`,
    });
  }
}

export default Database;
