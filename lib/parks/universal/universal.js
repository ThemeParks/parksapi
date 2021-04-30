import moment from 'moment-timezone';
import crypto from 'crypto';

import Resort from '../resort.js';
import {attractionType, entityType, queueType, scheduleType, statusType, tagType, returnTimeState} from '../parkTypes.js';

const wantedDiningTypes = [
  'CasualDining',
  'FineDining',
];

const wantedLiveDataPOITypes = [
  'Rides',
];

export class UniversalResortBase extends Resort {
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

    const baseURLHostname = new URL(this.config.baseURL).hostname;

    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      options.headers['X-UNIWebService-ApiKey'] = this.config.appKey;
      if (!options.loginRequest) {
        const token = await this.getServiceToken();
        options.headers['X-UNIWebService-Token'] = token;
      }
    });

    // listen to unauthorised responses, to generate a new token
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
        loginRequest: true,
        json: true,
      });

      // remember the expiration time
      const expireTime = resp.body.TokenExpirationUnix * 1000;
      tokenExpiration = Math.max(+new Date() + (1000 * 60 * 60), expireTime - (+new Date()) - (1000 * 60 * 60 * 12));

      return resp.body.Token;
    }, () => {
      return tokenExpiration;
    });
  }

  async _getParks() {
    // cache for 3 hours
    '@cache|180';
    const resp = await this.http('GET', `${this.config.baseURL}/venues?city=${this.config.city}`);
    return resp.body.Results.filter((x) => {
      return x.AdmissionRequired;
    });
  }

  /**
   * Get POI data from API for this resort
   * @returns {Object}
   */
  async getPOI() {
    // cache for 3 hours
    '@cache|180';
    const resp = await this.http('GET', `${this.config.baseURL}/pointsofinterest?city=${this.config.city}`);
    return resp.body;
  }

  /**
   * Build the resort entity representing this resort
   */
  async buildResortEntity() {
    return {
      ...this.buildBaseEntityObject(),
      _id: `universalresort_${this.config.city}`,
      name: this.config.name,
      entityType: entityType.resort,
      slug: this.config.resortSlug,
    };
  }

  /**
   * Build the park entities for this resort
   */
  async buildParkEntities() {
    const parks = await this._getParks();

    return parks.map((x) => {
      //console.log(x);
      //process.exit(0);
      return {
        ...this.buildBaseEntityObject(x),
        _id: x.Id.toString(),
        _parentId: `universalresort_${this.config.city}`,
        _contentId: x.ExternalIds.ContentId.slice(0, x.ExternalIds.ContentId.indexOf('.venues.')),
        name: x.MblDisplayName,
        entityType: entityType.park,
      };
    });
  }

  /**
   * Build the attraction entities for this resort
   */
  async buildAttractionEntities() {
    return (await this.getPOI()).Rides.map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        _id: x.Id.toString(),
        _parkId: x.VenueId.toString(),
        _parentId: x.VenueId.toString(),
        name: x.MblDisplayName,
        entityType: entityType.attraction,
        // TODO
        attractionType: attractionType.unknown,
      };
    });
  }

  /**
   * Build the show entities for this resort
   */
  async buildShowEntities() {
    return [];
    // TODO - filter out meet & greets and street entertainment
    return (await this.getPOI()).Shows.map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        _id: x.Id.toString(),
        _parkId: x.VenueId.toString(),
        _parentId: x.VenueId.toString(),
        name: x.MblDisplayName,
        entityType: entityType.show,
      };
    });
  }

  /**
   * Build the restaurant entities for this resort
   */
  async buildRestaurantEntities() {
    return (await this.getPOI()).DiningLocations.filter((x) => {
      if (!x.DiningTypes) return false;
      return !!x.DiningTypes.find((type) => {
        return wantedDiningTypes.indexOf(type) >= 0;
      });
    }).map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        _id: x.Id.toString(),
        _parkId: x.VenueId.toString(),
        _parentId: x.VenueId.toString(),
        name: x.MblDisplayName,
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
    const resp = await this.http('GET', `${this.config.baseURL}/pointsofinterest/rides/waittimes`, {
      city: this.config.city,
      pageSize: 'All',
    });
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

    // find and return the earliest appointment time available
    const earliestTime = res.body.AppointmentTimes.reduce((p, x) => {
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

    return earliestTime;
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

    const poiData = await this.getPOI();
    const poiTypes = {};
    Object.keys(poiData).forEach((type) => {
      poiData[type].forEach((x) => {
        poiTypes[`${x.Id}`] = type;
      });
    });

    return Promise.all(waittime.Results.filter((x) => {
      return wantedLiveDataPOITypes.indexOf(poiTypes[`${x.Key}`]) >= 0;
    }).map(async (ride) => {
      let queue = queueType.standBy;
      let status = statusType.operating;
      let postWaitTime = Math.max(0, ride.Value);
      switch (ride.Value) {
        case -50:
          // wait time unknown
          //  app just displays nothing for the ride status when -50
          postWaitTime = null;
          break;
        case -9:
          // this is a virtual line update, so bail out
          queue = queueType.returnTime;
          break;
        case -8:
          // not open yet
          status = statusType.closed;
          postWaitTime = null;
          break;
        case -7:
          // "ride now"
          break;
        case -6:
        case -5:
          // "closed inside of operating hours", not sure what that means, but it's closed
          status = statusType.closed;
          postWaitTime = null;
          break;
        case -4:
        case -3:
          // bad weather
          status = statusType.down;
          postWaitTime = null;
          break;
        case -1:
        // not open yet (too early)
        case -2:
          // "delayed", but expected to open
          status = statusType.closed;
          postWaitTime = null;
          break;
      }

      const data = {
        _id: ride.Key,
        status,
      };

      data.queue = {};
      if (queue == queueType.standBy) {
        data.queue[queueType.standBy] = {
          waitTime: postWaitTime,
        };
      }

      if (queue == queueType.returnTime && !!vQueueData) {
        // look for vqueue data for this attraction
        const vQueue = vQueueData.find((x) => x.QueueEntityId === ride.Key);

        if (vQueue && vQueue.IsEnabled) {
          // hurray! we found some vqueue data in the state object
          //  and it's enabled!

          // get details about this queue
          const nextSlot = await this._fetchVirtualQueueStateForRide(vQueue.Id);

          data.queue[queueType.returnTime] = {
            returnStart: nextSlot === undefined ? null : nextSlot.startTime,
            returnEnd: nextSlot === undefined ? null : nextSlot.endTime,
            // TODO - can we tell the difference between temporarily full and finished for the day?
            state: nextSlot === undefined ? returnTimeState.temporarilyFull : returnTimeState.available,
          };
        }
      }

      return data;
    }).filter((x) => !!x));
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

    super(options);
  }
}
