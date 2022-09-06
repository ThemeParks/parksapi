import EventEmitter from 'events';
import objHash from 'object-hash';
import moment from 'moment-timezone';
import tz_lookup from 'tz-lookup';

import Cache from '../cache/scopedCache.js';
import {reusePromiseForever} from '../reusePromises.js';
import {entityType} from './parkTypes.js';
import {getLiveDataErrors} from './livedata.js';
import HTTP from './http.js';

import {parseConfig} from '../configBase.js';
import {validateEntitySchedule} from './scheduledata.js';

/**
 * Return functions available on the supplied object as an array of strings
 * @param {object} obj
 * @return {Array<string>} array of function names
 */
const getMethods = (obj) => {
  const properties = new Set();
  let currentObj = obj;
  do {
    Object.getOwnPropertyNames(currentObj).map((item) => properties.add(item));
  } while ((currentObj = Object.getPrototypeOf(currentObj)));
  return [...properties.keys()].filter((item) => typeof obj[item] === 'function');
};

/**
 * Meta-programming commands
 * Functions can declare tags to add extra functionality to their behaviour.
 * This is a replacement for decorators until they actually exist.
 */
const metaCommands = {
  // @cache|minutesToCache
  cache: function(fnName, args) {
    const originalFunction = this[fnName].bind(this);

    this[fnName] = async (...originalFunctionArgs) => {
      let funcCacheName = `metacache_${fnName}`;
      if (originalFunctionArgs.length > 0) {
        funcCacheName = `metacache_${fnName}_${originalFunctionArgs.map((x) => JSON.stringify(x)).join(',')}`;
      }

      // figure out cache time from args[0]
      let cacheTime = 1000 * 60 * 5; // default to 5 minutes
      if (args.length > 0) {
        // look for units of time
        const timeUnit = args[0].match(/^(\d+)([mhd])$/);
        if (timeUnit) {
          const time = parseInt(timeUnit[1], 10);
          const unit = timeUnit[2];
          switch (unit) {
            case 'm':
              cacheTime = 1000 * 60 * time;
              break;
            case 'h':
              cacheTime = 1000 * 60 * 60 * time;
              break;
            case 'd':
              cacheTime = 1000 * 60 * 60 * 24 * time;
              break;
          }
        } else {
          // if no unit of time is supplied, assume minutes
          cacheTime = parseInt(args[0], 10) * 1000 * 60;
        }
      }

      // replace original function with a cache wrap
      return this.cache.wrap(
          // try and make a unique name based on our function name
          //  to store in cache
          funcCacheName,
          // call original function if value not in cache
          async () => {
            return originalFunction(...originalFunctionArgs);
          },
          cacheTime,
      );
    };
  },
};

/**
 * The base Destination object
 */
export class Destination extends EventEmitter {
  /**
   * Construct a new empty Destination object
   * @param {object} options
   */
  constructor(options = {}) {
    super();

    // add class name to our $env options
    options.configPrefixes = [this.constructor.name].concat(
        options.configPrefixes || [],
    );

    // debug callback to list environment variables
    if (options?.envCallback) {
      const keys = Object.keys(options);
      const prefix = this.constructor.name;
      keys.map((x) => {
        options?.envCallback(prefix, x);
      });
    }

    // parse config from ENV by combining with options
    const config = parseConfig(options);
    this.config = config;

    this._destinationEntityObject = null;

    // create a new cache object for this destination
    this.cache = new Cache(this.constructor.name, this.config.cacheVersion || 0);

    this._allEntities = null;
    this._allEntitiesLastStash = 0;

    this.http = new HTTP();
    if (this.config.useragent) {
      this.http.useragent = this.config.useragent;
    }

    if (!this.config.timezone) {
      throw new Error(`All destination objects must have a timezone! ${this.constructor.name}`);
    }

    // debug log all HTTP requests
    this.http.injectForDomain({hostname: {$exists: true}}, (method, url) => {
      this.log(method, url);
    });

    // get list of all class functions for some meta programming
    const funcs = getMethods(this);
    funcs.forEach((funcName) => {
      // skip constructor
      if (funcName === 'constructor') return;

      // get function as a string
      const funcStr = this[funcName].toString();
      // match any lines that contain only a string starting with @
      //  eg. '@cache()';
      // TODO - match multiple times for complex meta functions
      const match = /^\s*(['"`])\s*@([^'"`]+)\1;?/mg.exec(funcStr);
      if (match) {
        const splits = match[2].split('|');
        // look for matching meta function
        const metaFn = metaCommands[splits[0]];
        if (!metaFn) {
          return;
        }

        // console.log(`Setting up ${splits[0]} for ${funcName}...`);

        // call meta function
        metaFn.call(this, funcName, splits.slice(1));
      }
    });
  }

  /**
   * Debug log
   * @param  {...any} args Message to debug log
   */
  log(...args) {
    console.log(`[\x1b[32m${this.constructor.name}\x1b[0m]`, ...args);
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
   * Return the current time for this destination in its local timezone
   * @return {moment}
   */
  getTimeNowMoment() {
    return moment().tz(this.config.timezone);
  }

  /**
   * Return the current time for this destination in its local timezone
   * @return {string}
   */
  getTimeNow() {
    return this.getTimeNowMoment().format();
  }

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
    await cache.set(`${id}_livehash`, data ? objHash(data) : undefined, cacheTime);
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
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    throw new Error('buildDestinationEntity() needs an implementation', this.constructor.name);
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    throw new Error('buildParkEntities() needs an implementation', this.constructor.name);
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    throw new Error('buildAttractionEntities() needs an implementation', this.constructor.name);
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    throw new Error('buildShowEntities() needs an implementation', this.constructor.name);
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    throw new Error('buildRestaurantEntities() needs an implementation', this.constructor.name);
  }

  /**
   * Get the Entity object for this destination
   * @return {Object}
   */
  async getDestinationEntity() {
    await this.init();

    // TODO - cache this?
    if (!this._destinationEntityObject) {
      this._destinationEntityObject = await this.buildDestinationEntity();
    }
    // force to array (for multi-destination destinations)
    return [].concat(this._destinationEntityObject);
  }

  /**
   * Get all entities belonging to this destination.
   */
  async getAllEntities() {
    const minCacheTime = +new Date() - (1000 * 60 * 5); // refresh every 5 minutes
    if (this._allEntities && this._allEntitiesLastStash > minCacheTime) {
      return this._allEntities;
    }

    // TODO - cache each of these calls for some time
    // TODO - promise reuse this function
    const destination = await this.getDestinationEntity();

    this._allEntities = [].concat(
        destination,
        (await this.buildParkEntities()),
        (await this.buildAttractionEntities()),
        (await this.buildShowEntities()),
        (await this.buildRestaurantEntities()),
    );

    this._allEntitiesLastStash = +new Date();
    return this._allEntities;
  }

  /**
   * Get all park entities within this destination.
   */
  async getParkEntities() {
    const entities = await this.getAllEntities();
    return entities.filter((e) => e.entityType === entityType.park);
  }

  /**
   * Get all destination entities within this destination.
   */
  async getDestinationEntities() {
    const entities = await this.getAllEntities();
    return entities.filter((e) => e.entityType === entityType.destination);
  }

  /**
   * Get all attraction entities within this destination.
   */
  async getAttractionEntities() {
    const entities = await this.getAllEntities();
    return entities.filter((e) => e.entityType === entityType.attraction);
  }

  /**
   * Get all show entities within this destination.
   */
  async getShowEntities() {
    const entities = await this.getAllEntities();
    return entities.filter((e) => e.entityType === entityType.show);
  }

  /**
   * Get all restaurant entities within this destination.
   */
  async getRestaurantEntities() {
    const entities = await this.getAllEntities();
    return entities.filter((e) => e.entityType === entityType.restaurant);
  }

  /**
   * Given an internal entity ID, return it's full entity object
   * @param {string} id
   * @return {object}
   */
  async getEntityFromId(id) {
    const entities = await this.getAllEntities();
    return entities.find((x) => x && x._id === id);
  }

  // TODO - live data API methods in destination

  /**
   * Update an entity with livedata
   * @param {string} internalId
   * @param {object} data
   */
  async updateEntityLiveData(internalId, data) {
    // format incoming livedata to iron our any weird sorting inconsistency
    //  sort showtimes by startTime
    if (data?.showtimes) {
      data.showtimes.sort((a, b) => {
        if (!a.startTime || !b.startTime) return false;
        return moment(a.startTime).unix() - moment(b.startTime).unix();
      });
    }

    // stack up any emit events we want to send
    //  we will build these up inside our database transaction,
    //  but don't actually send them until we've released our lock
    const events = [];

    // get our entity doc
    const entity = await this.getEntityFromId(internalId);
    if (!entity) {
      return;

      this.emit('error', internalId, 'UNKNOWN_ENTITY_LIVEDATA', {
        message: `Trying to assign live data update to unknown entity ${internalId}`,
        data,
      });
      return;
    }

    // validate incoming data
    const validationErrors = getLiveDataErrors(data);
    if (validationErrors !== null) {
      this.emit('error', internalId, 'INVALID_LIVEDATA', {
        message: `Error validating incoming live data [${internalId}] ${JSON.stringify(data)}.
\t${validationErrors.map((x) => `${x.dataPath} ${x.message}`).join('\n\t')}`,
        data,
      });
      return;
    }

    // lock our live data in a transaction to avoid weird conflicts
    await this.cache.runTransaction(async (lock) => {
      try {
        // check live data hasn't changed from cache
        const storedHash = await this.getLiveHash(internalId, lock);

        if (storedHash) {
          const newHash = data ? objHash(data) : undefined;
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
        events.push(['liveupdate', internalId, data]);

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
   * Build all schedule data for entities - implement this function in child class
   * Returns array of schedule objects
   */
  async buildEntityScheduleData() {
    throw new Error('buildEntityScheduleData() needs an implementation', this.constructor.name);
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
      try {
        await this.updateEntityLiveData(data._id, data);
      } catch (e) {
        // if (!e instanceof EntityNotFound) {
        console.error(`Failed to apply live data to ${data._id}`);
        console.error(e);
        // }
        // 19411262;entityType=Attraction = Pop/Art Skyliner Line
        // 19404062;entityType=Attraction = Hollywood Studios Skyliner Line
        // 19404065;entityType=Attraction = Epcot Skyliner Line
      }
    }

    return liveData;
  }

  /**
   * Get all schedules for this destination's entites
   * @return {Array<object>} Array of objects containing _id and schedules
   */
  async getEntitySchedules() {
    await this.init();
    const scheduleData = (await this.buildEntityScheduleData()) || [];

    // validate schedule data
    scheduleData.forEach((data, idx) => {
      const errors = validateEntitySchedule(data);
      if (errors) {
        this.emit('error', data._id, 'INVALID_SCHEDULEDATA', {
          message: `Destination returned invalid schedule data for ${data._id}`,
          data: errors,
        });
        // clear out invalid schedule data
        data.schedule = [];
      } else {
        // sort data by openingTime
        data.schedule.sort((a, b) => {
          return moment(a.openingTime).valueOf() - moment(b.openingTime).valueOf();
        });
      }
    });

    return scheduleData;
  }

  /**
   * Clear the cache for a given meta function
   * @private
   * @param {string} functionName
   * @param {Array<*>} args
   */
  async _clearFunctionCache(functionName, args = []) {
    let funcCacheName = `metacache_${functionName}`;
    if (args.length > 0) {
      funcCacheName = `metacache_${functionName}_${args.map((x) => JSON.stringify(x)).join(',')}`;
    }
    await this.cache.set(funcCacheName, null, -1);
  }

  /**
   * Helper function to call a function, passing in a date for each date x days in the future.
   * First date will be current park date.
   * @param {Function} func
   * @param {Number} dates
   */
  async forEachUpcomingDate(func, dates = 30) {
    const now = this.getTimeNowMoment();
    const end = now.clone().add(dates, 'days');

    const results = [];

    for (; now.isSameOrBefore(end, 'day'); now.add(1, 'day')) {
      const d = await func(now.clone());
      if (d) {
        results.push(d);
      }
    }

    return results;
  }

  /**
   * Get the app version of an Android package ID
   * Only returns a valid response for apps tracked in the appwatch tracker service
   * @param {string} packageId
   * @return {string|undefined}
   */
  async getAndroidAPPVersion(packageId) {
    // cache 12 hours
    '@cache|720';
    const resp = await this.http(
        'GET',
        `https://appwatch.themeparks.wiki/latest/${packageId}`,
        {},
    );
    return resp?.body?.version || undefined;
  }

  calculateTimezone(longitude, latitude) {
    return tz_lookup(longitude, latitude);
  }
}

export default Destination;
