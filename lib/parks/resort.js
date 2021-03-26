import {entityType} from './parkTypes.js';
import {parseConfig} from '../configBase.js';

/**
 * The base Resort object
 */
export class Resort {
  /**
   * Construct a new empty Resort object
   * @param {object} options
   */
  constructor(options = {}) {
    this._resortEntityObject = null;

    // parse config from options + environment variables
    options.configPrefixes = [this.constructor.name].concat(
      options.configPrefixes || [],
    );
    this.config = parseConfig(options || {});
  }

  buildBaseEntityObject(data = {}) {
    return {
      timezone: this.config.timezone,
    };
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
   * @returns {Object}
   */
  async getResortEntity() {
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

  // TODO - live data API methods in resort
}

export default Resort;
