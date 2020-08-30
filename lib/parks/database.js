import ConfigBase from '../configBase.js';
import sift from 'sift';
import {reusePromise, reusePromiseForever} from '../reusePromises.js';

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
    super(options);

    this.cache = new Cache(this.constructor.name, this.config.cacheVersion || 0);
  }

  /**
   * Get the name of this class without requiring an instance.
   * @return {string}
   */
  static get className() {
    return this.toString().split('(' || /s+/)[0].split(' ' || /s+/)[1];
  }

  /**
   * Get singleton of this class type
   * @param {object} [options] Options to pass to new instance.
   * Will only be used if the instance doesn't already exist
   * @return {Database}
   */
  static get(options = {}) {
    const className = this.className;
    if (Databases[className] === undefined) {
      Databases[className] = new this(options);
    }
    return Databases[className];
  }

  /**
   * Get entities from this database. Optionally filtering by some conditions
   * @param {object} [filter]
   */
  async getEntities(filter = {}) {
    const filterFn = sift(filter);

    const entities = await this.cache.wrap('entities', () => {
      return reusePromise(this, this._getEntities);
    }, 1000 * 60); // cache for a minute for fast access

    return entities.filter(filterFn);
  }

  /**
   * Return all entities for this resort/park
   * @abstract
   * @return {array<object>}
   */
  async _getEntities() {
    throw new Error(`Database class ${this.constructor.name} missing _getEntities() function`);
  }
}

export default Database;
