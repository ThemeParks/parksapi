import EventEmitter from 'events';
import objHash from 'object-hash';

import Cache from '../cache/scopedCache.js';
import {reusePromiseForever} from '../reusePromises.js';
import {entityType} from './parkTypes.js';
import {getLiveDataErrors} from './livedata.js';

/**
 * The base Resort object
 */
export class Resort extends EventEmitter {
  /**
   * Construct a new empty Resort object
   * @param {object} options
   */
  constructor(options = {}) {
    super();

    this._resortEntityObject = null;
    // TODO - parse from ENV
    this.config = options;

    // create a new cache object for this resort
    this.cache = new Cache(this.constructor.name, this.config.cacheVersion || 0);
  }

  /**
   * Initialise the object. Will only be initialised once
   */
  async init() {
    await reusePromiseForever(this, this._init);
  }

  /**
   * Instance implementation of init, implement this function for a single-execution of init()
   */
  async _init() { }

  /**
   * Set local live data cache for an entity
   * @param {string} id
   * @param {object} data
   * @param {object} [lock] Optional lock file to use for transactions
   * @private
   */
  async setLiveCache(id, data, lock) {
    const cache = lock ? lock : this.cache;
    const cacheTime = 1000 * 60 * 60 * 24 * 30 * 6; // 6 months
    await cache.set(`${id}_live`, data, cacheTime);
    // generate hash and store separately
    await cache.set(`${id}_livehash`, objHash(data), cacheTime);
  }

  /**
   * Get the locally stored live data for an ID
   * @param {string} id
   * @param {object} [lock]
   * @return {object}
   */
  async getLiveCache(id, lock) {
    const cache = lock ? lock : this.cache;
    return cache.get(`${id}_live`);
  }

  /**
   * Get the hash of a stored live data of an entity
   * @param {string} id
   * @param {object} [lock] Optional lock file to use for transactions
   * @private
   */
  async getLiveHash(id, lock) {
    const cache = lock ? lock : this.cache;
    return await cache.get(`${id}_livehash`);
  }

  /**
   * Build a generic base entity object
   * @param {object} data
   * @return {object}
   */
  buildBaseEntityObject(data) {
    const entity = {
      timezone: this.config.timezone,
    };

    return entity;
  }

  /**
   * Build the resort entity representing this resort
   */
  async buildResortEntity() {
    throw new Error('buildResortEntity() needs an implementation', this.constructor.name);
  }

  /**
   * Build the park entities for this resort
   */
  async buildParkEntities() {
    throw new Error('buildParkEntities() needs an implementation', this.constructor.name);
  }

  /**
   * Build the attraction entities for this resort
   */
  async buildAttractionEntities() {
    throw new Error('buildAttractionEntities() needs an implementation', this.constructor.name);
  }

  /**
   * Build the restaurant entities for this resort
   */
  async buildRestaurantEntities() {
    throw new Error('buildRestaurantEntities() needs an implementation', this.constructor.name);
  }

  /**
   * Get the Entity object for this resort
   * @return {Object}
   */
  async getResortEntity() {
    await this.init();

    // TODO - cache this?
    if (!this._resortEntityObject) {
      this._resortEntityObject = await this.buildResortEntity();
    }
    return this._resortEntityObject;
  }

  /**
   * Get all entities belonging to this resort.
   */
  async getAllEntities() {
    // TODO - cache each of these calls for some time
    // TODO - promise reuse this function
    const resort = await this.getResortEntity();

    return [].concat(
      resort,
      (await this.buildParkEntities()).map((x) => {
        return {
          ...x,
          _resortId: resort._id,
        };
      }),
      (await this.buildAttractionEntities()).map((x) => {
        return {
          ...x,
          _resortId: resort._id,
        };
      }),
      (await this.buildRestaurantEntities()).map((x) => {
        return {
          ...x,
          _resortId: resort._id,
        };
      }),
    );
  }

  /**
   * Get all park entities within this resort.
   */
  async getParkEntities() {
    const entities = await this.getAllEntities();
    return entities.filter((e) => e.entityType === entityType.park);
  }

  /**
   * Get all resort entities within this resort.
   */
  async getResortEntities() {
    const entities = await this.getAllEntities();
    return entities.filter((e) => e.entityType === entityType.resort);
  }

  /**
   * Get all attraction entities within this resort.
   */
  async getAttractionEntities() {
    const entities = await this.getAllEntities();
    return entities.filter((e) => e.entityType === entityType.attraction);
  }

  /**
   * Get all restaurant entities within this resort.
   */
  async getRestaurantEntities() {
    const entities = await this.getAllEntities();
    return entities.filter((e) => e.entityType === entityType.restaurant);
  }

  async getEntityFromId(id) {
    const entities = await this.getAllEntities();
    return entities.find((x) => x._id === id);
  }

  // TODO - live data API methods in resort

  /**
   * Update an entity with livedata
   * @param {string} internalId
   * @param {object} data
   */
  async updateEntityLiveData(internalId, data) {
    // stack up any emit events we want to send
    //  we will build these up inside our database transaction,
    //  but don't actually send them until we've released our lock
    let events = [];

    // get our entity doc
    const entity = await getEntityFromId(internalId);
    if (!entity) {
      throw new Error(`Trying to assign live data update to unknown entity ${internalId}`);
    }

    // validate incoming data
    const validationErrors = getLiveDataErrors(entity, data);
    if (validationErrors !== null) {
      throw new Error(`Error validating incoming live data [${internalId}] ${data}.\n\t${validationErrors.join('\n\t')}`);
    }

    // lock our live data in a transaction to avoid weird conflicts
    await this.cache.runTransaction(async (lock) => {
      try {
        // check live data hasn't changed from cache
        const storedHash = await this.getLiveHash(internalId, lock);

        if (storedHash) {
          const newHash = objHash(data);
          if (newHash === storedHash) {
            // incoming data matches stored data! no change
            return;
          }
        }

        // TODO - get previous data and diff
        // const existingData = await this.getLiveCache(internalId, lock);

        // TODO - identify specific live data type changes
        //  eg. broadcast "queueupdate" changes etc.

        // always push a general "liveupdate" event
        events.push('liveupdate', internalId, data);

        // store locally
        await this.setLiveCache(internalId, data, lock);
      } catch (e) {
        console.error(e);
      }
    });

    // emit all our events *outside* the database transaction
    //  so we don't block database IO any longer than we need to
    events.forEach((ev) => {
      this.emit(...ev);
    });
  }

  /**
   * Build all live data for entities - implement this function in child class
   */
  async buildEntityLiveData() {
    throw new Error('buildEntityLiveData() needs an implementation', this.constructor.name);
  }

  /**
   * Get all live data for entities
   */
  async getEntityLiveData() {
    await this.init();
    const liveData = (await this.buildEntityLiveData()) || [];

    // process all live data we generated
    for (let liveDataIdx = 0; liveDataIdx < liveData.length; liveDataIdx++) {
      const data = liveData[liveDataIdx];
      await this.updateEntityLiveData(data.id, data);
    }

    return liveData;
  }
}

export default Resort;
