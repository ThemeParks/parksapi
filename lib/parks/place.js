import ConfigBase from '../configBase.js';
import moment from 'moment-timezone';

/**
 * A super-class that Parks/Resorts/etc. inherit from.
 * Handles general logic for objects that are a place.
 */
export class Place extends ConfigBase {
  /**
   * Construct a new Place
   * @param {object} options
   */
  constructor(options = {}) {
    // offline mode, never request any data, rely on manually serialised data to run
    options.offline = options.offline || false;

    super(options);

    if (!options.name) {
      throw new Error(`Missing name for constructed place object ${this.constructor.name}`);
    }

    if (!options.timezone) {
      throw new Error(`Missing timezone for constructed place object ${this.constructor.name}`);
    }
    if (moment.tz.names().indexOf(options.timezone) < 0) {
      throw new Error(`Place object ${this.constructor.name} gives an invalid timezone: ${options.timezone}`);
    }
  }

  /**
   * Is this object operating offline?
   */
  get offline() {
    return !!this.config.offline;
  }
}

export default Place;
