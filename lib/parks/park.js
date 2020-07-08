const delay = (seconds) => {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
};

/**
 * Base Park Object
 */
export default class Park {
  /**
   * Create a new park object
   * @param {object} options
   */
  constructor(options = {}) {
    this.setupComplete = false;

    this.initialised = false;
    this.pendingInitialisedRequests = [];
  }

  /**
   * @private
   * Is this a Park object?
   * Used for internal reflection system
   * @return {boolean}
   */
  static isParkObject() {
    return true;
  }

  /**
     * Get all Park classes that are loaded by require()
     */
  static async GetAllParkClasses() {
    // wait a single exec tick so we don't cause circular require() chains if this is requested on module load
    await delay(0);

    // gather all loaded node modules
    const modules = Object.keys(require.cache).filter((f) => f !== __filename).map(require);

    // filter out all classes that don't have the isParkObject function defined (and any that return false)
    const classes = modules.filter((obj) => {
      try {
        return obj && obj.isParkObject && obj.isParkObject() && obj !== Park;
      } catch (e) {
        return false;
      }
    });

    return classes;
  }

  /**
   * Get Park Wait Times
   */
  async getWaitTimes() {
    await this.waitForParkInitialised();

    // TODO - return park wait times
    return {
      wait_times: [
        {
          id: 'heidepark_1',
          name: {
            en: 'Test Coaster',
          },
          standby_time: 5,
          single_rider_time: 5,
          fastpass: false,
          virtual_queue: [],
        },
      ],
    };
  }

  /**
   * Waits until the park has finished initialisation
   */
  async waitForParkInitialised() {
    if (this.initialised) {
      return true;
    }

    return new Promise((resolve) => {
      this.pendingInitialisedRequests.push(resolve);
    });
  }

  /**
   * Setup the park for use
   */
  async setup() {
    // TODO - setup the park ready for use
    // eg. download any large data-sets, calendars etc.

    this.setupComplete = true;
  }

  /** The master Update function, called every 5 minutes or so to update park state */
  async update() {
    // TODO - run park update
    await delay(2);

    // we have finished a successful Update() call
    //  if we were not initialised before, mark ourselves as such as call any pending waits
    if (!this.initialised) {
      this.initialised = true;
      this.pendingInitialisedRequests.forEach((fn) => {
        fn();
      });
      this.pendingInitialisedRequests = [];
    }
  }
}

if (!module.parent) {
  const P = new Park();

  P.setup();

  P.getWaitTimes().then((a) => {
    console.log(a);
  });
}
