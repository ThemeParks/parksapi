import promiseRetry from 'promise-retry';
import Entity from './entity.js';
import moment from 'moment-timezone';
import Cache from '../cache/scopedCache.js';
import * as tags from './tags.js';
import {reusePromise, reusePromiseForever} from '../reusePromises.js';
import {queueType} from './parkTypes.js';

// quick helper function to wait x milliseconds as a Promise
const delay = (milliseconds) => {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

/**
 * Base Park Object
 * @class
 */
export class Park extends Entity {
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

    super(options);

    // create a new cache object for this park
    this.cache = new Cache(this.constructor.name, this.config.cacheVersion || 0);

    this.initialised = false;
    this.hasRunUpdate = false;
    this._pendingTags = {};

    this._attractions = [];

    // track the park's current date
    //  we'll fire an event whenever this changes
    this._currentDate = null;

    // make attractions and calendar functions work offline
    this.registerOfflineFunction('getAttractions');
    this.registerOfflineFunction('getCalendar');
  }

  /**
   * Call this to shutdown the park object.
   * This is an async call, so wait until it has resolved to continue.
   */
  async shutdown() {
    // disable any park updates
    this.config.disableParkUpdate = true;
  }

  /**
   * Get a globally unique ID for this park
   * @return {string}
   */
  getParkUniqueID() {
    return this.getUniqueID();
  }

  /**
   * Get Park Attractions
   */
  async getAttractions() {
    await this.ensureReady();

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
   * @inheritdocs
   */
  async _postOfflineLoad() {
    await this.postUpdate();
  }

  /**
   * Run all the internal stages of the init process
   * @private
   */
  async _runInit() {
    // skip init if we're offline
    if (this.offline) {
      this.initialised = true;
      this.hasRunUpdate = true;
      return;
    }

    try {
      await this._init();
      this.initialised = true;

      if (!this.config.disableParkUpdate && !this.offline) {
        // start an update loop

        // use a separate function so we can quickly loop back around
        const scheduleUpdate = async () => {
          // pause for our updateInterval time
          await delay(this.config.updateInterval);

          // if our udpates get disabled during our timer, then skip and exit our
          if (this.config.disableParkUpdate) return;

          // wait for Promise to resolve, grab any catches, then continue anyway
          this.update().then().catch().then(() => {
            if (this.config.disableParkUpdate) return;

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

    await this.ensureHasOfflineData();
  }

  /**
   * Cache an attraction
   * @param {string} attractionID ID of the attraction to be cached
   */
  async cacheAttractionObject(attractionID) {
    // find our attraction
    //  don't call the standard "find" function, as this will also create the object
    //  we don't want to actually create ths attraction if it doesn't exist, just ignore it
    const uniqueAttractionID = `${this.getParkUniqueID()}_${attractionID}`;
    const attraction = this._attractions.find((attr) => attr.id == uniqueAttractionID);
    if (attraction !== undefined) {
      await this.cache.set(uniqueAttractionID, attraction, Number.MAX_SAFE_INTEGER);
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
   * Get the attraction object for a given ID (skips all generation/safety checks etc,)
   * @param {string} attractionID
   * @return {object}
   * @private
   */
  _getAttractionByIDInternal(attractionID) {
    // search our existing store for this attraction
    const attraction = this._attractions.find((attr) => attr.rideId == attractionID);
    if (attraction) {
      return attraction;
    }
    return undefined;
  }

  /**
   * Get data about a attraction from its ID
   * @param {string} attractionID Unique Attraction ID
   * @return {object} The attraction object for the given ID, or undefined
   */
  async findAttractionByID(attractionID) {
    // wrap our actual function so multiple calls will return the same object
    return await reusePromise(this, this._findAttractionByID, `${attractionID}`);
  }

  /**
   * Get data about a attraction from its ID
   * @param {string} attractionID Unique Attraction ID
   * @return {object} The attraction object for the given ID, or undefined
   * @private
   */
  async _findAttractionByID(attractionID) {
    // search our existing store for this attraction
    const attraction = this._getAttractionByIDInternal(attractionID);
    if (attraction) {
      return attraction;
    }

    // build a unique attraction ID by prefixing the park's unique ID
    const uniqueAttractionID = `${this.getParkUniqueID()}_${attractionID}`;

    // attraction wasn't found, try and add one to our store
    const newAttraction = {
      id: uniqueAttractionID,
      // TODO - rename to attractionID
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

    // restore stored live attraction data from a cache
    //  restore from cache *before* we build the actual attraction data
    //  this will allow the park API to fill in any out-of-date fields with live data
    const cachedAttraction = await this.cache.get(uniqueAttractionID);
    if (cachedAttraction !== undefined) {
      Object.keys(cachedAttraction).forEach((key) => {
        // TODO - do we need to do anyhting special here for sub-fields?
        if (key === 'tags') {
          // TODO - re-validate tags
        }
        newAttraction[key] = cachedAttraction[key];
      });
    }

    // ask the park implementation to supply us with some basic attraction information (name, type, etc.)
    //  we'll then inject this into our attraction object, assuming it returns successfully
    try {
      const builtAttractionObject = {
        // clone the object, to ensure we don't mess with the original
        ...(await this._buildAttractionObject(attractionID)),
      };
      if (builtAttractionObject !== undefined && !!builtAttractionObject.name) {
        // clear out any _src data (if present)
        delete builtAttractionObject._src;

        // add to our attractions array once we've got a valid attraction (not undefined) from child class
        this._attractions.push(newAttraction);

        // copy fields we're interested in into our new attraction object
        fieldsToCopyFromParkClass.forEach((key) => {
          if (builtAttractionObject[key] !== undefined) {
            newAttraction[key] = builtAttractionObject[key];
          }
        });

        const tags = (this._pendingTags[attractionID] || []).concat(builtAttractionObject.tags || []);
        delete this._pendingTags[attractionID];

        // we also manually accept the "tags" field
        //  add each tag to the attraction after it's added to our object above
        await Promise.allSettled(tags.map((tag) => {
          return this.setAttractionTag(attractionID, tag.key, tag.type, tag.value);
        }));

        // cache attraction object so it can be restored quickly on future app intialisations
        await this.cacheAttractionObject(attractionID);

        return newAttraction;
      }
    } catch (e) {
      this.emit('error', e);
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
    const attraction = await this._getAttractionByIDInternal(attractionID);
    if (!attraction) return;

    const existingTag = attraction.tags.findIndex((t) => t.key === key && t.type === type);
    if (existingTag >= 0) {
      attraction.tags.splice(existingTag, 1);
      await this.cacheAttractionObject(attractionID);
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
    return await this.setAttractionTag(attractionID, null, type, value);
  }

  /**
   * Set an attraction tag
   * Used for metadata on rides, such as location, thrill level, fastpass availability etc.
   * @param {string|object} attractionID Attraction ID to update (or the actual object)
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

    // different path for simple tags that are being removed
    if (tags.isSimpleTagType(type) && !value) {
      // if value is false, remove the key
      return await this.removeAttractionTag(attractionID, newTag.key, type);
    }

    // find attraction and apply tag to it
    const attraction = await this._getAttractionByIDInternal(attractionID);
    if (attraction) {
      const existingTag = attraction.tags.findIndex((t) => t.key === newTag.key && t.type === newTag.type);
      if (existingTag < 0) {
        // push our new tag onto our attraction
        attraction.tags.push(newTag);
      } else {
        // update existing tag entry
        attraction.tags[existingTag] = newTag;
      }
      await this.cacheAttractionObject(attractionID);
      return true;
    } else {
      // attraction isn't valid. Push to our pending array to process when/if it does become valid
      this._pendingTags[attractionID] = [{key, type, value}].concat(
          this._pendingTags[attractionID] || [],
      );
    }

    return false;
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

      // write updated attraction data to cache
      await this.cacheAttractionObject(attractionID);
    }
  }

  /**
   * Update the queue status for an attraction
   * @param {string} attractionID Attraction ID to update
   * @param {number|object} queueValue Updated Wait Time in minutes, or null if wait time doesn't exist or isn't valid.
   * Set waitTime to undefined to remove this queue type from the attraction.
   * BoardingGroup and ReturnTime types expect an object containing queue details instead of a number
   * @param {queueType} type Type of queue to update (standup, virtual, fastpass etc.)
   */
  async updateAttractionQueue(attractionID, queueValue = undefined, type = type.standBy) {
    if (attractionID === undefined) return;

    const existingRide = await this.findAttractionByID(attractionID);
    if (existingRide) {
      if (!existingRide.queue) {
        existingRide.queue = {};
      }

      // edge-case, if we supply undefined, the queue has been removed
      //  (or never existed and we're just double-checking it's not present)
      if (queueValue === undefined) {
        if (existingRide.queue[type] !== undefined) {
          const previousWaitTime = existingRide.queue[type].waitTime;
          delete existingRide.queue[type];

          // fire event anyway, the queue has technically been updated (it's just not present at all now)
          this.emit('attractionQueue', existingRide, type, previousWaitTime);

          await this.cacheAttractionObject(attractionID);
        }

        // don't continue operations, early exit here
        return;
      }

      if (!existingRide.queue[type]) {
        existingRide.queue[type] = {
          waitTime: null,
          lastUpdated: null,
          lastChanged: null,
        };
      }

      const queueData = existingRide.queue[type];

      const now = this.getTimeNow();

      if (type == queueType.standBy || type == queueType.singleRider) {
        // wait times must be a positive number (in minutes)
        //  if wait time is unknown (because it is not tracker or there is some issue), waitTime should be null
        const newWaitTime = (isNaN(queueValue) || queueValue < 0) ? null : queueValue;
        const previousWaitTime = queueData.waitTime;

        // store last updated time
        queueData.lastUpdated = now;

        if (newWaitTime !== previousWaitTime || queueData.lastChanged === null) {
          queueData.waitTime = newWaitTime;
          queueData.lastChanged = now;

          // broadcast updated ride event
          //  try to make sure we have updated everything before we fire this event
          this.emit('attractionQueue', existingRide, type, previousWaitTime);
        }
      } else if (type == queueType.returnTime) {
        // TODO - handle return time style queues
        return;
      } else if (type == queueType.boardingGroup) {
        // TODO - handle baording group style queues
        return;
      }

      // write updated attraction data to cache
      await this.cacheAttractionObject(attractionID);
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
      // emit error and print to screen
      console.error('Error running _update()', e);
      this.emit('error', e);
      return;
    }

    this.hasRunUpdate = true;

    try {
      await this.postUpdate();
    } catch (e) {
      console.error('Error running postUpdate()', e);
      this.emit('error', e);
    }
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
   * Get the operating hours for the supplied date
   * Will return undefined if the park API cannot return data for this date
   *  (park is closed, too far in future, too far in past, etc.)
   * @param {moment} date A momentjs object
   * @return {object}
   */
  async getOperatingHoursForDate(date) {
    // cache each calendar date to avoid recalculating it all the time
    return this.cache.wrap(`calendar_${date.format('YYYY-MM-DD')}`, async () => {
      return await this._getOperatingHoursForDate(date);
    }, 1000 * 60 * 60 * 6); // cache for 6 hours
  }

  /**
   * Get Operating Calendar for this park
   * @return{object} Object keyed to dates in YYYY-MM-DD format.
   * Each date entry will contain an array of operating hours.
   */
  async getCalendar() {
    try {
      // make sure the park is initialised before continuing
      await this.init();

      // populate from yesterday onwards (if the API even gives us yesterday)
      //  try to catch weird edge-cases where we're just past midnight but the park is still open
      const yesterday = moment().tz(this.config.timezone).subtract(1, 'days');
      // populate forward up to 60 days
      const endFillDate = yesterday.clone().add(60 + 1, 'days');

      const now = this.getTimeNowMoment();

      const dates = {};
      // get calendar by looping over each date
      for (let date = yesterday; date.isSameOrBefore(endFillDate); date.add(1, 'day')) {
        const hours = await this.getOperatingHoursForDate(date);
        if (hours !== undefined) {
          if (!Array.isArray(hours)) {
            this.emit(
                'error',
                new Error(
                    // eslint-disable-next-line max-len
                    `Hours for ${this.name} date ${date.format('YYYY-MM-DD')} returned invalid non-Array ${JSON.stringify(hours)}`,
                ),
            );
            continue;
          }
          // ignore if we're not within the operating hours AND the date is in the past
          //  this will strip out yesterday once we've left that day's opening hours
          const isInsideAnyDateHours = hours.find((h) => {
            return now.isBetween(h.openingTime, h.closingTime);
          });
          if (now.isAfter(date, 'day') && isInsideAnyDateHours === undefined) {
            continue;
          }
          dates[date.format('YYYY-MM-DD')] = hours;
        }
      }

      return dates;
    } catch (err) {
      console.error('Error getting calendar', err);
      this.emit('error', err);
    }

    return undefined;
  }

  /**
   * Return the number of milliseconds until the next time the park is open.
   * Will return 0 if park is already open.
   * @return{number} Milliseconds until the park is open
   */
  async getNextOpeningTime() {
    const calendar = await this.getCalendar();
    const now = this.getTimeNowMoment();

    const dates = Object.keys(calendar);
    const nextOpeningTime = dates.reduce((p, date) => {
      return Math.min(p, calendar[date].reduce((p2, time) => {
        const msUntilOpening = moment(time.openingTime).diff(now);
        // if the opening time is in the past, is the closing time in the future?
        if (msUntilOpening <= 0) {
          if (moment(time.closingTime).diff(now) > 0) {
            return 0;
          } else {
            // otherwise this entire time block is in the past, ignore it
            return p2;
          }
        }
        return Math.min(p2, msUntilOpening);
      }, Number.MAX_SAFE_INTEGER));
    }, Number.MAX_SAFE_INTEGER);

    return nextOpeningTime === Number.MAX_SAFE_INTEGER ? null : nextOpeningTime;
  }

  /**
   * Return the number of milliseconds until closing time. Or 0 if already closed.
   * @return {number}
   */
  async getNextClosingTime() {
    const today = await this.getCalendarForToday();
    if (today !== undefined) {
      const now = this.getTimeNowMoment();
      const closingTime = today.reduce((p, hours) => {
        if (!now.isBetween(hours.openingTime, hours.closingTime)) {
          return 0;
        }

        return Math.max(moment(hours.closingTime).diff(now), p);
      }, 0);

      return closingTime;
    }
    return 0;
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
}

export default Park;
