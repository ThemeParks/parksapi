import promiseRetry from 'promise-retry';
import ConfigBase from '../configBase.js';
import needle from 'needle';
import domainMatch from 'domain-match';
import moment from 'moment-timezone';
import randomUseragent from 'random-useragent';
import Cache from '../cache/scopedCache.js';

// quick helper function to wait x milliseconds as a Promise
const delay = (milliseconds) => {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

export const ParkConstants = {
  // different queue types rides can have
  QUEUE_STANDBY: 'STANDBY',
  QUEUE_SINGLERIDER: 'SINGLE_RIDER',
  QUEUE_VIRTUALQUEUE: 'VIRTUAL_QUEUE',
  QUEUE_FASTPASS: 'FAST_PASS',
  // attraction types
  ATTRACTION_RIDE: 'RIDE',
  ATTRACTION_SHOW: 'SHOW',
  ATTRACTION_TRANSPORT: 'TRANSPORT',
  ATTRACTION_PARADE: 'PARADE',
  ATTRACTION_MEET_AND_GREET: 'MEET_AND_GREET',
  // attraction statuses
  STATUS_OPERATING: 'OPERATING',
  STATUS_DOWN: 'DOWN',
  STATUS_CLOSED: 'CLOSED',
  STATUS_REFURBISHMENT: 'REFURBISHMENT',
};

/** Generate a random Android user agent for making network requests */
export function generateRandomAndroidUseragent() {
  randomUseragent.getRandom((ua) => {
    return (ua.osName === 'Android');
  });
}

/**
 * Base Park Object
 * @class
 */
export class Park extends ConfigBase {
  /**
   * Create a new park object
   * @param {object} options
   */
  constructor(options = {}) {
    // how often to wait between updates to run another update
    options.updateInterval = 1000 * 60 * 5; // 5 minutes
    // disable auto-update for this object
    //  set this if the update is being handled by an external system
    options.disableParkUpdate = false;

    // generate a random Android user-agent if we aren't supplied one
    options.useragent = options.useragent || generateRandomAndroidUseragent();

    super(options);

    if (!options.name) {
      throw new Error(`Missing name for constructed park object ${this.constructor.name}`);
    }

    if (!options.timezone) {
      throw new Error(`Missing timezone for constructed park object ${this.constructor.name}`);
    }
    // validate park timezone
    if (moment.tz.names().indexOf(options.timezone) < 0) {
      throw new Error(`Park object ${this.constructor.name} gives an invalid timezone: ${options.timezone}`);
    }

    // create a new cache object for this park
    this.cache = new Cache(this.constructor.name, this.config.cacheVersion || 0);

    this.initialised = false;

    this._attractions = [];

    // any HTTP injections that have been setup
    //  allows parks to automatically intercept HTTP requests and add auth headers etc.
    this._httpInjections = [];
  }

  /**
   * Get a globally unique ID for this park
   */
  getParkUniqueID() {
    throw new Error(`Missing getParkUniqueID() implementation for ${this.constructor.name}`);
  }

  /**
   * Get Park Attractions
   */
  async getAttractions() {
    // park must be initialised before returning any data
    await this.init();

    return this._attractions;
  }

  /**
   * Setup the park for use
   * Call to ensure the object has been initialised before accessing data
   */
  async init() {
    if (this.initialised) {
      return;
    }

    // setup the park ready for use
    //  eg. download any large data-sets, calendars etc.
    if (this._pendingSetupPromise) {
      return this._pendingSetupPromise;
    }

    // call our internal init and wait on it
    this._pendingSetupPromise = this._runInit();
    await this._pendingSetupPromise;
    this._pendingSetupPromise = null;

    this.initialised = true;

    if (!this.config.disableParkUpdate) {
      // start an update loop

      // use a separate function so we can quickly loop back around
      const scheduleUpdate = async () => {
        // pause for our updateInterval time
        await delay(this.config.updateInterval);

        // wait for Promise to resolve, grab any catches, then continue anyway
        this.update().then().catch().then(() => {
          // schedule another update
          setImmediate(scheduleUpdate.bind(this));
        });
      };

      // start the first loop timer
      scheduleUpdate();
    }
  }

  /**
   * Run all the internal stages of the init process
   * @private
   */
  async _runInit() {
    await this._init();

    // run an initial update so we're fully setup with data before init() returns
    return await this._update();
  }

  /**
   * Build an object representing an attraction from sourced data
   * This object should not contain any "state" data, just static information about the attraction
   * @param {string} attractionID Unique Attraction ID
   */
  async _buildAttractionObject(attractionID) {
    throw new Error('Missing _buildAttractionObject Implementation', this.constructor.name);
  }

  /**
   * Get data about a attraction from its ID
   * @param {string} attractionID Unique Attraction ID
   */
  async findAttractionByID(attractionID) {
    // search our existing store for this attraction
    const attraction = this._attractions.find((attr) => attr.id == attractionID);
    if (attraction) {
      return attraction;
    }

    // attraction wasn't found, try and add one to our store
    const newAttraction = await this._buildAttractionObject(attractionID);
    if (newAttraction) {
      // default to a "null" state
      //  meaning an attraction with no waiting times etc.
      newAttraction.state = null;

      // make a globally unique ID for this attraction by combining the park ID and attraction ID
      newAttraction._id = `${this.getParkUniqueID()}_${attractionID}`;

      this._attractions.push(newAttraction);

      return newAttraction;
    }

    return undefined;
  }

  /**
   * Update an attraction state
   * @param {string} attractionID Unique Attraction ID
   * @param {object} data New Attraction State Data
   */
  async _updateAttractionState(attractionID, data) {
    if (attractionID === undefined) return;

    const existingRide = await this.findAttractionByID(attractionID);
    if (existingRide) {
      // if we found a matching attraction, update its "state" property with our new data
      existingRide.state = data;

      // TODO - broadcast updated ride event
    }
  }

  /**
   * Update this park
   * This is automatically called for you unless disableParkUpdate is set to false
   */
  async update() {
    if (this._pendingUpdatePromise) {
      return this._pendingUpdatePromise;
    }

    // start the _update call in a retry loop
    this._pendingUpdatePromise = promiseRetry({
      retries: 5,
    }, (retryFn, retryAttempt) => {
      /* if (retryAttempt > 1) {
        console.error(`Making attempt ${retryAttempt} to call _update on ${this.constructor.name} class`);
      }*/
      return this._update().catch(retryFn);
    });

    // wait and catch the update Promise
    try {
      await this._pendingUpdatePromise;
    } catch (e) {
      // TODO - record park API error somewhere and continue
      console.error(e);
    }

    this._pendingUpdatePromise = null;
  }

  /**
   * Internal function
   * Called by init() to initialise the object
   * @private
   * @abstract
   */
  async _init() {
    // implementation should be setup in child classes
    throw new Error('_init() needs an implementation', this.constructor.name);
  }

  /**
   * Update function the park object calls on interval to update internal state
   * @private
   * @abstract
   */
  async _update() {
    // implementation should be setup in child classes
    throw new Error('_update() needs an implementation', this.constructor.name);
  }

  /**
   * Register a new injection for a specific domain
   * @param {string} domain Domain to inject for, accepts wildcards. See domain-match
   * @param {function} func Function to call with needle request to inject extra data into.
   * Function will take arguments: (method, URL, data, options)
   */
  async injectForDomain(domain, func) {
    // add to our array of injections, this is processing by http()
    this._httpInjections.push({
      domain,
      func,
    });
  }

  /**
   * Helper function to make an HTTP request for this park
   * Parks can automatically add in authentication headers etc. to requests sent to this function
   * @param {string} method HTTP method to use (GET,POST,DELETE, etc)
   * @param {string} url URL to request
   * @param {object} [data] data to send. Will become querystring for GET, body for POST
   * @param {object} [options] Object containing needle-compatible HTTP options
   */
  async http(method, url, data = {}, options = {}) {
    // always have a headers array
    if (!options.headers) {
      options.headers = {};
    }

    // inject custom standard user agent (if we have one)
    //  do this before any custom injections so parks can optionally override this for each domain
    if (this.config.useragent) {
      options.headers['user-agent'] = this.config.useragent;
    }

    // check any hostname injections we have setup
    for (let injectionIDX=0; injectionIDX<this._httpInjections.length; injectionIDX++) {
      const injection = this._httpInjections[injectionIDX];

      // check if the domain matches
      if (domainMatch(injection.domain, url)) {
        await injection.func(method, url, data, options);
      }
    }

    return needle(method, url, data, options);
  }
}

export default Park;
