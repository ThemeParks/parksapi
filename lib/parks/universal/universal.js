import moment from 'moment-timezone';
import crypto from 'crypto';

import Destination from '../destination.js';
import {attractionType, entityType, queueType, scheduleType, statusType, tagType, returnTimeState} from '../parkTypes.js';

// TODO - move POI to new API

// only return restaurants using these dining types
const wantedDiningTypes = [
  'CasualDining',
  'FineDining',
];

// only return live data for entities in these POI categories (see getPOI)
const wantedLiveDataPOITypes = [
  'Rides',
];

const ignoreShowTypes = [
  'Character',
  'Music',
];

export class UniversalResortBase extends Destination {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.timezone = options.timezone || 'America/New_York';

    options.secretKey = options.secretKey || '';
    options.appKey = options.appKey || '';
    options.city = options.city || '';
    options.vQueueURL = options.vQueueURL || '';
    options.baseURL = options.baseURL || '';
    options.resortSlug = options.resortSlug || '';

    options.assetsBase = options.assetsBase || '';
    options.resortKey = options.resortKey || '';

    // any custom environment variable prefixes we want to use for this park (optional)
    options.configPrefixes = ['UNIVERSALSTUDIOS'].concat(options.configPrefixes || []);

    super(options);

    // here we can validate the resulting this.config object
    if (!this.config.name) throw new Error('Missing Universal resort name');
    if (!this.config.secretKey) throw new Error('Missing Universal secretKey');
    if (!this.config.appKey) throw new Error('Missing Universal appKey');
    if (!this.config.city) throw new Error('Missing Universal city');
    if (!this.config.vQueueURL) throw new Error('Missing Universal vQueueURL');
    if (!this.config.baseURL) throw new Error('Missing Universal baseURL');
    if (!this.config.resortSlug) throw new Error('Missing Universal resortSlug');

    if (!this.config.assetsBase) throw new Error('Missing Universal assetsBase');
    if (!this.config.resortKey) throw new Error('Missing Universal resortKey');

    const baseURLHostname = new URL(this.config.baseURL).hostname;

    // add out ApiKey to all API requests
    //  add our service token only if this is not the login request
    //  set options.loginRequest=true to skip adding the service token
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      options.headers['X-UNIWebService-ApiKey'] = this.config.appKey;
      if (!options.loginRequest) {
        const token = await this.getServiceToken();
        if (!token) {
          throw new Error('Failed to get service token for Universal API');
        }
        options.headers['X-UNIWebService-Token'] = token;
      }
    });

    // if our API ever returns 401, refetch our service token with a new login
    this.http.injectForDomainResponse({
      hostname: baseURLHostname,
    }, async (response) => {
      if (response.statusCode === 401) {
        // clear out our token and try again
        await this.cache.set('servicetoken', undefined, -1);
        return undefined;
      }

      return response;
    });
  }

  /**
   * Get a service auth token for Universal
   */
  async getServiceToken() {
    let tokenExpiration = null;
    return await this.cache.wrap('servicetoken', async () => {
      // create signature to get access token
      const today = `${moment.utc().format('ddd, DD MMM YYYY HH:mm:ss')} GMT`;
      const signatureBuilder = crypto.createHmac('sha256', this.config.secretKey);
      signatureBuilder.update(`${this.config.appKey}\n${today}\n`);
      // generate hash from signature builder
      //  also convert trailing equal signs to unicode. because. I don't know
      const signature = signatureBuilder.digest('base64').replace(/=$/, '\u003d');

      const resp = await this.http('POST', `${this.config.baseURL}?city=${this.config.city}`, {
        apikey: this.config.appKey,
        signature,
      }, {
        headers: {
          'Date': today,
        },
        // tell our HTTP injector to not add our (currently undefined) service token
        loginRequest: true,
        json: true,
      });

      // remember the expiration time
      const expireTime = resp.body.TokenExpirationUnix * 1000;
      tokenExpiration = Math.max(+new Date() + (1000 * 60 * 60), expireTime - (+new Date()) - (1000 * 60 * 60 * 12));

      return resp.body.Token;
    }, () => {
      // return ttl for cached service token based on data in the token response
      //  can define ttl as a function instead of a Number for dynamic cache timeouts
      return tokenExpiration;
    });
  }

  async _getParks() {
    // cache for 3 hours
    '@cache|180';
    const resp = await this.http('GET', `${this.config.baseURL}/venues?city=${this.config.city}`);
    return resp.body.Results.filter((x) => {
      // skip "parks" which don't require admission (i.e, CityWalk)
      return x.AdmissionRequired;
    });
  }

  /**
   * Get POI data from API for this resort
   * @returns {Object}
   */
  async getPOI() {
    // cache for 1 hour
    '@cache|60';
    const resp = await this.http('GET', `${this.config.baseURL}/pointsofinterest?city=${this.config.city}`);
    return resp.body;
  }

  /**
   * @inheritdoc
   */
  buildBaseEntityObject(data) {
    const entity = super.buildBaseEntityObject(data);

    if (data) {
      entity._tags = [];

      // add location data (if present)
      if (data.Longitude && data.Latitude) {
        entity.location = {
          longitude: data.Longitude,
          latitude: data.Latitude,
        };
      }

      // grab entity name from incoming data
      if (data.MblDisplayName) {
        entity.name = data.MblDisplayName;
      }

      // child swap tag
      if (data.HasChildSwap !== undefined) {
        if (!!data.HasChildSwap) {
          entity._tags.push({
            id: 'childSwap',
            value: true,
          });
        }
      }

      // min height tag
      if (data.MinHeightInInches && data.MinHeightInInches > 0) {
        // convert to CM
        const minHeightInCentimetres = Math.ceil(data.MinHeightInInches * 2.54);

        // add to tags
        entity._tags.push({
          id: 'minimumHeight',
          value: minHeightInCentimetres,
        });
      }
    }

    return entity;
  }

  /**
   * Build the destination entity representing this resort
   */
  async buildDestinationEntity() {
    return {
      ...this.buildBaseEntityObject(),
      _id: `universalresort_${this.config.city}`,
      name: this.config.name,
      entityType: entityType.destination,
      slug: this.config.resortSlug,
    };
  }

  /**
   * Build the park entities for this resort
   */
  async buildParkEntities() {
    const parks = await this._getParks();

    if (parks === undefined) throw new Error('Failed to fetch parks from Universal API');

    return parks.map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        // all IDs must be strings in ThemeParks.wiki
        _id: x.Id.toString(),
        _destinationId: `universalresort_${this.config.city}`,
        // parented to the resort
        _parentId: `universalresort_${this.config.city}`,
        _contentId: x.ExternalIds.ContentId.slice(0, x.ExternalIds.ContentId.indexOf('.venues.')),
        entityType: entityType.park,
        slug: x.MblDisplayName.replace(/[^a-zA-Z]/g, '').toLowerCase(),
      };
    });
  }

  /**
   * Build the attraction entities for this resort
   */
  async buildAttractionEntities() {
    return (await this.getPOI()).Rides.map((x) => {
      // what kind of attraction is this?
      let type = attractionType.ride; // default to "ride"
      // Hogwarts Express manually tag as "transport"
      if (x.Tags.indexOf('train') >= 0) {
        type = attractionType.transport;
      }

      // TODO - how to classify pool areas like Puka Uli Lagoon?

      return {
        ...this.buildBaseEntityObject(x),
        _id: x.Id.toString(),
        _destinationId: `universalresort_${this.config.city}`,
        _parkId: x.VenueId.toString(),
        _parentId: x.VenueId.toString(),
        entityType: entityType.attraction,
        attractionType: type,
      };
    });
  }

  /**
   * Helper function to filter out shows we don't want to show
   * @returns {Array} filtered list of shows
   */
  async _getFilteredShows() {
    return (await this.getPOI()).Shows.filter((show) => {
      // filter out meet & greets and street entertainment
      const matchAnyIgnoreType = show.ShowTypes.find((x) => {
        return ignoreShowTypes.indexOf(x) >= 0;
      });
      if (matchAnyIgnoreType) return false;

      return true;
    });
  }

  /**
   * Build the show entities for this resort
   */
  async buildShowEntities() {
    return (await this._getFilteredShows()).map((show) => {
      return {
        ...this.buildBaseEntityObject(show),
        _id: show.Id.toString(),
        _destinationId: `universalresort_${this.config.city}`,
        _parkId: show.VenueId.toString(),
        _parentId: show.VenueId.toString(),
        entityType: entityType.show,
      };
    });
  }

  /**
   * Build the restaurant entities for this resort
   */
  async buildRestaurantEntities() {
    return (await this.getPOI()).DiningLocations.filter((x) => {
      // only return dining locations that match our wantedDiningTypes list
      //  eg. CasualDining, FineDining - skip coffee carts
      if (!x.DiningTypes) return false;
      return !!x.DiningTypes.find((type) => {
        return wantedDiningTypes.indexOf(type) >= 0;
      });
    }).map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        _id: x.Id.toString(),
        _destinationId: `universalresort_${this.config.city}`,
        _parkId: x.VenueId.toString(),
        _parentId: x.VenueId.toString(),
        entityType: entityType.restaurant,
      };
    });
  }

  /**
   * Fetch wait time data
   * @private
   */
  async _fetchWaitTimes() {
    // cache for 1 minute
    '@cache|1';

    const resp = await this.http(
      'GET',
      `${this.config.assetsBase}/${this.config.resortKey}/wait-time/wait-time-attraction-list.json`,
    );

    return resp.body;
  }

  /**
   * Get the current state of virtual queues for the resort
   * @private
   */
  async _fetchVirtualQueueStates() {
    // cache for 1 minute
    '@cache|1';
    const virtualData = await this.http('GET', `${this.config.baseURL}/Queues`, {
      city: this.config.city,
      page: 1,
      pageSize: 'all',
    });
    return virtualData?.body?.Results;
  }

  /**
   * Fetch the virtual queue state for a specific ride
   * @private
   */
  async _fetchVirtualQueueStateForRide(queueId) {
    // cache for 1 minute
    '@cache|1';
    const todaysDate = (await this.getTimeNowMoment()).format('MM/DD/YYYY');
    const res = await this.http(
      'GET',
      `${this.config.baseURL}/${this.config.vQueueURL}/${queueId}`, {
      page: 1,
      pageSize: 'all',
      city: this.config.city,
      appTimeForToday: todaysDate,
    });

    return res.body;
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    // fetch standard wait times
    const waittime = await this._fetchWaitTimes();
    // fetch virtual lines state
    //  this returns all the virtual queues and if they are running
    const vQueueData = await this._fetchVirtualQueueStates();

    const returnLiveData = [];

    const findOrCreateLiveData = (id) => {
      let liveData = returnLiveData.find((x) => x._id === id);
      if (!liveData) {
        liveData = {
          _id: `${id}`,
          status: statusType.closed,
          queue: {},
        };
        returnLiveData.push(liveData);
      }
      return liveData;
    };

    // start with virtual queues
    for (const vQueue of vQueueData) {
      if (vQueue.IsEnabled) {
        // hurray! we found some vqueue data in the state object
        //  and it's enabled!

        // get details about this queue
        const vQueueFetchedData = await this._fetchVirtualQueueStateForRide(vQueue.Id);

        // find and return the earliest appointment time available
        const nextSlot = vQueueFetchedData.AppointmentTimes.reduce((p, x) => {
          const startTime = moment.tz(x.StartTime, this.config.timezone);
          if (p === undefined || startTime.isBefore(p.startTime)) {
            const endTime = moment.tz(x.EndTime, this.config.timezone);
            return {
              startTime,
              endTime,
            };
          }
          return p;
        }, undefined);

        const liveDataObject = findOrCreateLiveData(vQueue.QueueEntityId);

        liveDataObject.queue[queueType.returnTime] = {
          returnStart: nextSlot === undefined ? null : nextSlot.startTime.format(),
          returnEnd: nextSlot === undefined ? null : nextSlot.endTime.format(),
          // TODO - can we tell the difference between temporarily full and finished for the day?
          state: nextSlot === undefined ? returnTimeState.temporarilyFull : returnTimeState.available,
        };
      }
    }

    // loop over standby/single-rider queues
    waittime.forEach((attraction) => {
      if (!attraction || !attraction.queues) return;

      let attractionLiveDataObject = null;
      let attractionHasOperatingQueue = false;

      attraction.queues.forEach((queue) => {
        const rideIdObj = queue.alternate_ids.find((x) => {
          return x.system_name == 'POI';
        });

        if (!rideIdObj) return;
        const rideId = rideIdObj.system_id;

        if (!attractionLiveDataObject) {
          attractionLiveDataObject = findOrCreateLiveData(rideId);
        }

        switch (queue.queue_type) {
          case 'STANDBY':
            if (queue.status == 'OPEN') {
              // valid statuses: OPENS_AT, OPEN, CLOSED, ...
              attractionLiveDataObject.queue[queueType.standBy] = {
                waitTime: queue.display_wait_time,
              };

              // mark that we have a valid operating queue, so the attraction is open
              if (queue.status == 'OPEN') {
                attractionHasOperatingQueue = true;
              }
            }

            if (queue.status == 'OPENS_AT' && queue.opens_at) {
              // add operatingHours entry for this queue if we have it
              if (!attractionLiveDataObject.operatingHours) {
                attractionLiveDataObject.operatingHours = [];
              }
              // TODO - look for existing operating hours and merge them
              attractionLiveDataObject.operatingHours.push({
                type: "OPERATING",
                startTime: queue.opens_at,
                endTime: null,
              });
            }

            // DEBUG - gather various potential queue status types
            if (queue.status != 'OPEN' && queue.status != 'OPENS_AT' && queue.status != 'CLOSED' && queue.status != 'BRIEF_DELAY' && queue.status != 'N/A') {
              console.error("Unknown queue status", queue.status, "for", attraction.name, "queue", queue.queue_type, "status", queue.status, "wait", queue.display_wait_time, "rideId", rideId, "attractionLiveDataObject", attractionLiveDataObject, "attractionHasOperatingQueue", attractionHasOperatingQueue, "queue", queue);
              debugger;
            }

            break;
          case 'SINGLE':
            // valid statuses: CLOSED, AT_CAPACITY, ...
            if (queue.status == 'OPEN' && attraction.has_single_rider) {
              // single rider queues
              attractionLiveDataObject.queue[queueType.singleRider] = {
                // doesn't return actual wait times, but return something to show it's operating
                waitTime: null, //queue.wait_time, eg. 995 for Mummy
              };
              attractionHasOperatingQueue = true;
            } // ignore AT_CAPACITY, CLOSED

            break;
          default:
            this.log(`Unknown queue type ${queue.queue_type}`);
            break;
        }
      });

      // TODO - maintenance/refurb status?
      if (attractionLiveDataObject) {
        attractionLiveDataObject.status = attractionHasOperatingQueue ? statusType.operating : statusType.closed;
      }
    });

    // add show times
    const showtimes = await this._getFilteredShows();
    showtimes.forEach((show) => {
      const showEntry = findOrCreateLiveData(show.Id.toString());
      showEntry.status = statusType.operating;
      showEntry.showtimes = show.StartDateTimes.map((x) => {
        const timeObj = moment.tz(x, this.config.timezone);
        if (timeObj.isBefore(this.getTimeNowMoment())) {
          return null;
        }
        return {
          // TODO - filter out shows that were over an hour in the past?
          type: "Performance Time",
          startTime: timeObj.format(),
          endTime: timeObj.format(),
        };
      }).filter((x) => !!x);
    });

    return returnLiveData;
  }

  /**
   * Convert a time string from the API to a valid timestamp in our timezone
   * @param {string} time 
   * @returns {string}
   */
  _stringTimeToLocalTime(time) {
    return moment.tz(time, this.config.timezone).format();
  }

  /**
   * Get the latest raw opening hours for a given venue
   */
  async getLatestOpeningHoursForVenue(venueId) {
    // cache for 3 hours
    '@cache|180';
    const now = this.getTimeNowMoment();
    const cal = await this.http('GET', `${this.config.baseURL}/venues/${venueId}/hours`, {
      endDate: now.clone().add(190, 'days').format('MM/DD/YYYY'),
    });

    const ret = [];
    // loop over all hours data the API returns
    cal.body.forEach((todaysCal) => {
      // skip any Closed dates, just return nothing
      if (todaysCal.VenueStatus === 'Closed') return;

      ret.push({
        date: todaysCal.Date,
        openingTime: this._stringTimeToLocalTime(todaysCal.OpenTimeString),
        closingTime: this._stringTimeToLocalTime(todaysCal.CloseTimeString),
        type: scheduleType.operating,
      });

      if (todaysCal.EarlyEntryString) {
        // extra hours
        ret.push({
          date: todaysCal.Date,
          openingTime: this._stringTimeToLocalTime(todaysCal.EarlyEntryString),
          closingTime: this._stringTimeToLocalTime(todaysCal.OpenTimeString),
          type: scheduleType.extraHours,
        });
      }

      // TODO - handle todaysCal.SpecialEntryString (when these exist)
      if (todaysCal.SpecialEntryString) {
        this.emit('error', new Error(`Unknown Universal SpecialEntryString ${todaysCal.SpecialEntryString}`));
      }
    });

    return ret;
  }

  /**
   * @inheritdoc
   */
  async buildEntityScheduleData() {
    // get list of venues to fetch schedules for
    const venues = (await this.getParkEntities()).map((x) => {
      return x._id;
    });

    // loop over each venue and build up our return object
    const returnData = [];
    for (let i = 0; i < venues.length; i++) {
      const venueScheduleData = await this.getLatestOpeningHoursForVenue(venues[i]);
      returnData.push({
        _id: venues[i],
        schedule: venueScheduleData,
      });
    }
    return returnData;
  }
}

export class UniversalOrlando extends UniversalResortBase {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.name = options.name || 'Universal Orlando Resort';
    options.city = options.city || 'orlando';
    options.timezone = options.timezone || 'America/New_York';
    options.resortSlug = options.resortSlug || 'universalorlando';
    options.resortKey = options.resortKey || 'uor';

    super(options);
  }
}

export class UniversalStudios extends UniversalResortBase {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.name = options.name || 'Universal Studios';
    options.city = options.city || 'hollywood';
    options.timezone = options.timezone || 'America/Los_Angeles';
    options.resortSlug = options.resortSlug || 'universalstudios';
    options.resortKey = options.resortKey || 'ush';

    super(options);
  }
}
