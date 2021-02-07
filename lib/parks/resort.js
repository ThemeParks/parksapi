import {entityType} from './parkTypes.js';

/**
 * The base Resort object
 */
export class Resort {
  /**
   * Construct a new empty Resort object
   * @param {object} options
   */
  constructor(options = {}) {
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
   * Get all entities belonging to this resort.
   */
  async getAllEntities() {
    // TODO - cache each of these calls for some time
    return [].concat(
        await this.buildResortEntity(),
        await this.buildParkEntities(),
        await this.buildAttractionEntities(),
        await this.buildRestaurantEntities(),
    );
  }

  /**
   * Get all park entities within this resort.
   */
  async getParkEntities() {
    const entities = await this.getAllEntities();
    return entities.filter((e) => e.type === entityType.park);
  }

  /**
   * Get all resort entities within this resort.
   */
  async getResortEntities() {
    const entities = await this.getAllEntities();
    return entities.filter((e) => e.type === entityType.resort);
  }
}

export default Resort;
