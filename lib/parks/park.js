import promiseRetry from 'promise-retry';
import ConfigBase from '../configBase.js';
import needle from 'needle';
import moment from 'moment-timezone';
import randomUseragent from 'random-useragent';
import Cache from '../cache/scopedCache.js';
import * as tags from './tags.js';
import HarWriter from '../har.js';
import sift from 'sift';
import {URL} from 'url';
import {reusePromise, reusePromiseForever} from '../reusePromises.js';

// quick helper function to wait x milliseconds as a Promise
const delay = (milliseconds) => {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

/** Generate a random Android user agent for making network requests */
export function generateRandomAndroidUseragent() {
  randomUseragent.getRandom((ua) => {
    return (ua.osName === 'Android');
  });
}

// start our har writer (if debugging)
const harWriter = process.env['THEMEPARKS_HAR'] ?
  new HarWriter({filename: `${process.env['THEMEPARKS_HAR']}.har`}):
  null;

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
    this.hasRunUpdate = false;

    this._attractions = [];

    // any HTTP injections that have been setup
    //  allows parks to automatically intercept HTTP requests and add auth headers etc.
    this._httpInjections = [];

    // track the park's current date
    //  we'll fire an event whenever this changes
    this._currentDate = null;
  }

  /**
   * Get a globally unique ID for this park
   * @return {string}
   */
  getParkUniqueID() {
    // by default, return the class name
    return this.constructor.name.toLowerCase();
  }

  /**
   * Return the current time for this park in its local timezone
   * @return {moment}
   */
  getTimeNowMoment() {
    return moment().tz(this.config.timezone);
  }

  /**
   * Return the current time for this park in its local timezone
   * @return {string}
   */
  getTimeNow() {
    return this.getTimeNowMoment().format();
  }

  /**
   * Get park's human-friendly name string
   * @return {string}
   */
  get name() {
    return this.config.name;
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
    return reusePromiseForever(this, this._runInit);
  }

  /**
   * Run all the internal stages of the init process
   * @private
   */
  async _runInit() {
    try {
      await this._init();
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
    } catch (e) {
      console.error('Error initialising park', e);
    }
  }

  /**
   * Awaits until park is initalised and has run at least one update.
   * @return {Promise}
   */
  async ensureReady() {
    await this.init();

    if (!this.hasRunUpdate) {
      await this.update();
    }
  }

  /**
   * Build an object representing an attraction from sourced data
   * This object should not contain any "state" data, just static information about the attraction
   * @param {string} attractionID Unique Attraction ID
   * @return {object} Object containing at least 'name'.
   * Also accepts 'type', which is an {@link attractionType}
   */
  async _buildAttractionObject(attractionID) {
    throw new Error('Missing _buildAttractionObject Implementation', this.constructor.name);
  }

  /**
   * Get data about a attraction from its ID
   * @param {string} attractionID Unique Attraction ID
   * @return {object} The attraction object for the given ID, or undefined
   */
  async findAttractionByID(attractionID) {
    // build a unique attraction ID by prefixing the park's unique ID
    const uniqueAttractionID = `${this.getParkUniqueID()}_${attractionID}`;

    // search our existing store for this attraction
    const attraction = this._attractions.find((attr) => attr.id == uniqueAttractionID);
    if (attraction) {
      return attraction;
    }

    // attraction wasn't found, try and add one to our store
    const newAttraction = {
      id: uniqueAttractionID,
      rideId: attractionID, // unique attraction ID without the park prefix
      name: undefined,
      type: null,
      status: {
        status: null,
        lastUpdated: null,
        lastChanged: null,
      },
      queue: {},
      tags: [],
    };

    // list of fields we want to accept from the park class
    //  we don't want the park to add random fields to our attraction object
    //  park-specific data should be added using "tags" instead, so our object structure is the same for all parks
    const fieldsToCopyFromParkClass = [
      'name',
      'type',
    ];

    // TODO - restore stored live attraction data from a cache
    //  restore from cache *before* we build the actual attraction data
    //  this will allow the park API to fill in any out-of-date fields with live data

    // ask the park implementation to supply us with some basic attraction information (name, type, etc.)
    //  we'll then inject this into our attraction object, assuming it returns successfully
    try {
      const builtAttractionObject = await this._buildAttractionObject(attractionID);
      if (builtAttractionObject !== undefined && !!builtAttractionObject.name) {
        // copy fields we're interested in into our new attraction object
        fieldsToCopyFromParkClass.forEach((key) => {
          if (builtAttractionObject[key] !== undefined) {
            newAttraction[key] = builtAttractionObject[key];
          }
        });

        // add to our attractions array
        this._attractions.push(newAttraction);

        // we also manually accept the "tags" field
        //  add each tag to the attraction after it's added to our object above
        if (builtAttractionObject.tags) {
          await Promise.allSettled(builtAttractionObject.tags.map((tag) => {
            return this.setAttractionTag(attractionID, tag.key, tag.type, tag.value);
          }));
        }

        return newAttraction;
      }
    } catch (e) {
      console.error('Error building attraction object:', e);
    }

    return undefined;
  }

  /**
   * Remove a tag from a given attraction ID
   * @param {string} attractionID
   * @param {string} key
   * @param {tagType} type
   */
  async removeAttractionTag(attractionID, key, type) {
    const attraction = await this.findAttractionByID(attractionID);
    if (!attraction) return;

    const existingTag = attraction.tags.findIndex((t) => t.key === key && t.type === type);
    if (existingTag >= 0) {
      attraction.tags.splice(existingTag, 1);
    }
  }

  /**
   * Set a toggle tag for an attraction.
   * This is different from more complex tags that expect a data structure.
   * Use this for tags that don't have any actual value, but are just present. Eg. FastPass as a feature.
   * @param {string} attractionID
   * @param {tagType} type
   * @param {boolean} value
   */
  async toggleAttractionTag(attractionID, type, value) {
    if (!value) {
      // if value is false, remove the key
      const newTag = tags.getValidTagObject(null, type, null);
      await this.removeAttractionTag(attractionID, newTag.key, type);
    } else {
      // otherwise, add our tag
      await this.setAttractionTag(attractionID, null, type, null);
    }
  }

  /**
   * Set an attraction tag
   * Used for metadata on rides, such as location, thrill level, fastpass availability etc.
   * @param {string} attractionID Attraction ID to update
   * @param {string} key Tag key to set
   * @param {tagType} type Tag type to use
   * @param {*} value Tag value to set
   * @return {boolean} True if tag was stored successfully
   */
  async setAttractionTag(attractionID, key, type, value) {
    // validate tag value
    const newTag = tags.getValidTagObject(key, type, value);
    if (newTag === undefined) {
      return false;
    }

    // find attraction and apply tag to it
    const attraction = await this.findAttractionByID(attractionID);
    if (attraction) {
      const existingTag = attraction.tags.findIndex((t) => t.key === newTag.key && t.type === newTag.type);
      if (existingTag < 0) {
        // push our new tag onto our attraction
        attraction.tags.push(newTag);
      } else {
        // update existing tag entry
        attraction.tags[existingTag] = newTag;
      }
    }
  }

  /**
   * Update an attraction state
   * @param {string} attractionID Unique Attraction ID
   * @param {statusType} status New Attraction state
   */
  async updateAttractionState(attractionID, status) {
    if (attractionID === undefined) return;

    const existingRide = await this.findAttractionByID(attractionID);
    if (existingRide) {
      // if we found a matching attraction, update its "state" property with our new data
      const now = this.getTimeNow();

      // last updated is always kept up-to-date, regardless of whether the data changed
      existingRide.status.lastUpdated = now;

      // only update "lastChanged" if the status has changed
      const previousStatus = existingRide.status.status;
      if (previousStatus !== status || existingRide.status.lastChanged === null) {
        existingRide.status.status = status;
        existingRide.status.lastChanged = now;

        // broadcast updated ride event
        //  try to make sure we have updated everything before we fire this event
        this.emit('attractionStatus', existingRide, previousStatus);
      }

      // TODO - write updated attraction data to cache
    }
  }

  /**
   * Update the queue status for an attraction
   * @param {string} attractionID Attraction ID to update
   * @param {number} waitTime Updated Wait Time in minutes, or null if wait time doesn't exist or isn't valid
   * @param {queueType} queueType Type of queue to update (standup, virtual, fastpass etc.)
   */
  async updateAttractionQueue(attractionID, waitTime = -1, queueType = queueType.standBy) {
    if (attractionID === undefined) return;

    const existingRide = await this.findAttractionByID(attractionID);
    if (existingRide) {
      if (!existingRide.queue) {
        existingRide.queue = {};
      }
      if (!existingRide.queue[queueType]) {
        existingRide.queue[queueType] = {
          waitTime: null,
          lastUpdated: null,
          lastChanged: null,
        };
      }

      const queueData = existingRide.queue[queueType];

      const now = this.getTimeNow();
      // wait times must be a positive number (in minutes)
      //  if wait time is unknown (because it is not tracker or there is some issue), waitTime should be null
      const newWaitTime = (isNaN(waitTime) || waitTime < 0) ? null : waitTime;
      const previousWaitTime = queueData.waitTime;

      // store last updated time
      queueData.lastUpdated = now;

      if (newWaitTime !== previousWaitTime || queueData.lastChanged === null) {
        queueData.waitTime = newWaitTime;
        queueData.lastChanged = now;

        // broadcast updated ride event
        //  try to make sure we have updated everything before we fire this event
        this.emit('attractionQueue', existingRide, queueType, previousWaitTime);
      }

      // TODO - write updated attraction data to cache
    }
  }

  /**
   * Called after each successful update, handle any clean-up or extra work here
   * @private
   */
  async postUpdate() {
    // check if our date has changed
    await this._checkDate();
  }

  /**
   * Update this park
   * This is automatically called for you unless disableParkUpdate is set to false
   */
  async update() {
    return reusePromise(this, this._runUpdate);
  }

  /**
   * Internal method to actually run our update
   * @private
   */
  async _runUpdate() {
    // wait and catch the update Promise
    try {
    // start the _update call in a retry loop
      await promiseRetry({
        retries: 5,
      }, (retryFn) => {
        return this._update().catch(retryFn);
      });
    } catch (e) {
      // TODO - record park API error somewhere and continue
      console.error(e);
    }

    this.hasRunUpdate = true;

    await this.postUpdate();
  }

  /**
   * Called when the park's date changes
   * Eg. when passing midnight in the park's local timezone
   *  or if late opening hours finish the morning after (eg. open until 2am, will be called just after 2am)
   * @param {string} newDate Current Park Date
   * @param {string} oldDate The previous date for this park before the update (can be null if park just initialised)
   * @abstract
   */
  async _dateRefresh(newDate, oldDate) {}

  /**
   * Check if the park's "active date" has changed
   */
  async _checkDate() {
    const todaysDate = await this.getActiveParkDate();
    if (this._currentDate !== todaysDate) {
      // store the previous date and update the current date immediately
      //  this makes sure the park object is in the correct state before firing the newDate events
      const originalDate = this._currentDate;
      this._currentDate = todaysDate;

      // broadcast event when the park's day changes
      //  we can use this to update ride schedules etc.
      await this._dateRefresh(todaysDate, originalDate);
      this.emit('newDate', todaysDate, originalDate);
    }
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
   * Given a moment date, return an array of opening hours for this park, or undefined
   * Each entry should contain openingTime, closingTime, and type (of scheduleType)
   * @param {moment} date
   * @private
   * @abstract
   */
  async _getOperatingHoursForDate(date) {
    // implementation should be setup in child classes
    throw new Error('_getOperatingHoursForDate() needs an implementation', this.constructor.name);
  }

  /**
   * Get Operating Calendar for this park
   * @return{object} Object keyed to dates in YYYY-MM-DD format.
   * Each date entry will contain an array of operating hours.
   */
  async getCalendar() {
    // make sure the park is initialised before continuing
    await this.init();

    // cache the full calendar to avoid recalculating it constantly
    return this.cache.wrap('calendar', async () => {
      // populate from yesterday onwards (if the API even gives us yesterday)
      //  try to catch weird edge-cases where we're just past midnight but the park is still open
      const yesterday = moment().tz(this.config.timezone).subtract(1, 'days');
      // populate forward up to 60 days
      const endFillDate = yesterday.clone().add(60 + 1, 'days');

      const dates = {};
      // get calendar by looping over each date
      for (let date = yesterday; date.isSameOrBefore(endFillDate); date.add(1, 'day')) {
        const hours = await this._getOperatingHoursForDate(date);
        if (hours !== undefined) {
          dates[date.format('YYYY-MM-DD')] = hours;
        }
      }

      return dates;
    }, 1000 * 60 * 60 * 6); // cache for 6 hours
  }

  /**
   * Return the number of milliseconds until the next time the park is open.
   * Will return 0 if park is already open.
   * @return{number} Milliseconds until the park is open
   */
  async getNextOpeningTime() {
    const todaysOpeningTimes = await this.getCalendarForToday();
    const now = this.getTimeNowMoment();
    const isParkOpen = todaysOpeningTimes.find((time) => {
      return (now.isBetween(moment(time.openingTime), moment(time.closingTime)));
    });
    // we're inside existing hours!
    if (isParkOpen !== undefined) {
      return 0;
    }

    const getSoonestOpeningTime = (times) => {
      return todaysOpeningTimes.reduce((p, time) => {
        const msUntilOpening = moment(time.openingTime).diff(now);
        if (msUntilOpening > 0 && msUntilOpening < p) {
          return msUntilOpening;
        }
      }, Number.MAX_SAFE_INTEGER);
    };

    // otherwise, check if today's opening times are in the future...
    const nextOpeningTimeToday = getSoonestOpeningTime(todaysOpeningTimes);
    if (nextOpeningTimeToday < Number.MAX_SAFE_INTEGER) {
      // we're opening soon today!
      return nextOpeningTimeToday;
    }

    // still not found the next time... try tomorrow
    const tomorrowsOpeningTimes = await this.getCalendarForTomorrow();
    const nextOpeningTimeTomorrow = getSoonestOpeningTime(tomorrowsOpeningTimes);
    if (nextOpeningTimeTomorrow < Number.MAX_SAFE_INTEGER) {
      // we're opening again tomorrow!
      return nextOpeningTimeTomorrow;
    }

    // otherwise, return null
    return null; // couldn't determine next opening time
  }

  /**
   * Return the time until the park is open.
   * @return{momentDuration} Time until park opens as a Moment Duration.
   * Zero if already open, or null if unable to find time
   */
  async getNextOpeningTimeMomentDuration() {
    const ms = await this.getNextOpeningTime();

    if (ms === null) return null;
    return moment.duration(ms, 'milliseconds');
  }

  /**
   * Get the current park date, taking into consideration park hours past midnight etc.
   * Eg. if the park is open past midnight, return yesterday's date.
   * @return{moment} Park's "active date" as a Moment object
   */
  async getActiveParkDateMoment() {
    const calendar = await this.getCalendar();

    const nowInPark = moment(this.getTimeNow()).tz(this.config.timezone);
    // check yesterday, today, and tomorrow to find any park hours that we're currently in
    //  (including any extra hours etc.)
    //  we will fall-back to the current date if none of these match
    const isInParkHours = [
      nowInPark.clone().add(-1, 'day'),
      nowInPark,
      nowInPark.clone().add(1, 'day'),
    ].map((date) => {
      // build array of our park calendar entries
      return {
        date,
        data: calendar[date.format('YYYY-MM-DD')],
      };
    }).filter((parkHours) => {
      // filter out any park hours that doesn't include the current time
      if (!parkHours.data) return false;
      const isInAnyParkHours = parkHours.data.find((hours) => {
        return (nowInPark.isBetween(moment(hours.openingTime), moment(hours.closingTime)));
      });
      return !!isInAnyParkHours;
    });

    if (isInParkHours.length === 0) {
      // just return today's calendar
      return nowInPark;
    }
    // otherwise return the hours that we currently match
    return isInParkHours[0].date;
  }

  /**
   * Get the current park date, taking into consideration park hours past midnight etc.
   * Eg. if the park is open past midnight, return yesterday's date.
   * @return{string} Date in YYYY-MM-DD format
   */
  async getActiveParkDate() {
    return (await this.getActiveParkDateMoment()).format('YYYY-MM-DD');
  }

  /**
   * Get the park opening hours for today
   */
  async getCalendarForToday() {
    const todaysDate = await this.getActiveParkDate();
    const calendar = await this.getCalendar();
    return calendar[todaysDate];
  }

  /**
   * Get the park opening hours for tomorrow
   */
  async getCalendarForTomorrow() {
    const todaysDate = await this.getActiveParkDate();
    const tomorrow = moment(todaysDate, 'YYYY-MM-DD').add(1, 'day');
    const calendar = await this.getCalendar();
    return calendar[tomorrow.format('YYYY-MM-DD')];
  }

  /**
   * Register a new injection for a specific domain
   * @param {object} filter Mongo-type query to use to match a URL
   * @param {function} func Function to call with needle request to inject extra data into.
   * Function will take arguments: (method, URL, data, options)
   */
  async injectForDomain(filter, func) {
    // add to our array of injections, this is processing by http()
    this._httpInjections.push({
      filter: sift(filter),
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
      if (injection.filter(new URL(url))) {
        await injection.func(method, url, data, options);
      }
    }

    const startMs = +new Date();
    const startTime = moment(startMs).toISOString();

    return needle(method, url, data, options).then(async (resp) => {
      // console.log(resp.req);
      // intercept response to write to our .har file
      if (harWriter) {
        const timeTaken = (+new Date()) - startMs;

        const objToArr = (obj) => {
          return Object.keys(obj).map((header) => {
            return {name: header, value: obj[header].toString()};
          });
        };

        const entry = {
          startedDateTime: startTime,
          time: timeTaken,
          request: {
            method: method,
            url: url,
            httpVersion: `HTTP/${resp.httpVersion}`, // this is actually the response, TODO
            cookies: [],
            headers: objToArr(options.headers), // not the actual headers needle sends - TODO, how to get these?
            queryString: method === 'GET' ? objToArr(data) : [], // TODO - parse from needle's .path
            postData: {
              mimeType: options.json ? 'application/json' : (options.headers['content-type'] || ''),
              params: method !== 'GET' ? [] : [],
              text: '',
            },
            headersSize: -1,
            bodySize: -1,
          },
          response: {
            status: resp.statusCode,
            statusText: resp.statusMessage,
            httpVersion: `HTTP/${resp.httpVersion}`,
            cookies: [],
            headers: objToArr(resp.headers),
            content: {
              size: resp.raw.length || -1,
              mimeType: resp.headers['content-type'],
              text: resp.raw.toString('base64'),
              encoding: 'base64',
            },
            redirectURL: '',
            headersSize: -1,
            bodySize: -1,
          },
          cache: {},
          timings: {
            send: -1,
            wait: -1,
            receive: -1,
          },
        };
        await harWriter.recordEntry(entry);
      }

      return resp;
    });
  }
}

export default Park;
