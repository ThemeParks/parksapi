import ConfigBase from '../configBase.js';

// quick helper function to wait x milliseconds as a Promise
const delay = (milliseconds) => {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

export const constants = {
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
};

/**
 * Base Park Object
 * @class
 */
export default class Park extends ConfigBase {
  /**
   * Create a new park object
   * @param {object} options
   */
  constructor(options = {}) {
    super(options);

    this.initialised = false;
  }

  /**
   * Get Park Attractions
   */
  async getAttractions() {
    // park must be initialised before returning any data
    await this.init();

    // TODO - return park attractions with any attributes/wait times etc.
    return [
      {
        id: 1,
        type: constants.ATTRACTION_RIDE,
        queues: [
          {
            type: constants.QUEUE_STANDBY,
            waitTime: 15,
          },
        ],
      },
      {
        id: 2,
        type: constants.ATTRACTION_RIDE,
        queues: [
          {
            type: constants.QUEUE_STANDBY,
            waitTime: 25,
          },
          {
            type: constants.QUEUE_SINGLERIDER,
            waitTime: 5,
          },
        ],
      },
    ];
  }

  /**
   * Setup the park for use
   * Call to ensure the object has been initialised before accessing data
   */
  async init() {
    // setup the park ready for use
    //  eg. download any large data-sets, calendars etc.
    if (this.pendingSetupPromise) {
      return this.pendingSetupPromise;
    }

    // call our internal init and wait on it
    this.pendingSetupPromise = this._init();
    await this.pendingSetupPromise;

    this.initialised = true;

    // TODO - start update loop
  }

  /**
   * Internal function
   * Called by init() to initialise the object
   * @private
   */
  async _init() {
    // implementation should be setup in child classes
  }

  /** The master Update function, called every 5 minutes or so to update park state */
  async update() {
    // TODO - run park update
    await delay(2000);
  }
}
