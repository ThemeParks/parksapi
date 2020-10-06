import {Park} from '../park.js';
import {attractionType, statusType, queueType, tagType, scheduleType, returnTimeState} from '../parkTypes.js';
import moment from 'moment-timezone';
import crypto from 'crypto';
import {URL} from 'url';

/**
 * Sample Park Object
 */
export class UniversalParkBase extends Park {
  /**
   * Create a new Sample Park object
   * @param {object} options
   */
  constructor(options = {}) {
    options.name = options.name || 'Universal Park';
    options.timezone = options.timezone || 'America/New_York';

    options.secretKey = options.secretKey || '';
    options.appKey = options.appKey || '';
    options.venueID = options.venueID || '';
    options.city = options.city || '';
    options.vQueueURL = options.venueID || '';
    options.baseURL = options.baseURL || '';
    options.contentID = options.contentID || '';

    // any custom environment variable prefixes we want to use for this park (optional)
    options.configPrefixes = ['UNIVERSALSTUDIOS'].concat(options.configPrefixes || []);

    super(options);

    // here we can validate the resulting this.config object
    if (!this.config.secretKey) throw new Error('Missing Universal secretKey');
    if (!this.config.appKey) throw new Error('Missing Universal appKey');
    if (!this.config.venueID) throw new Error('Missing Universal venueID');
    this.config.venueID = Number(this.config.venueID);
    if (!this.config.city) throw new Error('Missing Universal city');
    if (!this.config.vQueueURL) throw new Error('Missing Universal vQueueURL');
    if (!this.config.baseURL) throw new Error('Missing Universal baseURL');
    if (!this.config.contentID) throw new Error('Missing Universal contentID');

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

  /**
   * @inheritdoc
   */
  async _init() {
  }

  /**
   * Get all park POI data
   */
  async getPOI() {
    return await this.cache.wrapGlobal(`universalstudios_${this.config.city}_poi`, async () => {
      const data = await this.http('GET', `${this.config.baseURL}/pointsOfInterest`, {
        city: this.config.city,
      });
      if (!data?.body?.Rides) {
        throw new Error('Unable to fetch Universal POI data');
      }
      return data.body.Rides;
    }, 1000 * 60 * 60 * 12); // 12 hours
  }

  /**
   * @inheritdoc
   */
  async _buildAttractionObject(attractionID) {
    const data = await this.getPOI();
    const ride = data.find((x) => `${x.Id}` === attractionID && x.VenueId === this.config.venueID);
    if (ride === undefined) return undefined;

    const tags = [];

    if (ride.Longitude && ride.Latitude) {
      tags.push({
        key: 'location',
        type: tagType.location,
        value: {
          longitude: ride.Longitude,
          latitude: ride.Latitude,
        },
      });
    }

    if (ride.MinHeightInInches) {
      tags.push({
        key: 'minimumHeight',
        type: tagType.minimumHeight,
        value: {
          unit: 'in',
          height: ride.MinHeightInInches,
        },
      });
    }
    if (ride.MaxHeightInInches) {
      tags.push({
        key: 'maximumHeight',
        type: tagType.maximumHeight,
        value: {
          unit: 'in',
          height: ride.MaxHeightInInches,
        },
      });
    }

    tags.push({
      type: tagType.singleRider,
      value: !!ride.HasSingleRiderLine,
    });

    tags.push({
      type: tagType.fastPass,
      value: !!ride.ExpressPassAccepted,
    });

    tags.push({
      type: tagType.childSwap,
      value: !!ride.HasChildSwap,
    });

    return {
      name: ride.MblDisplayName,
      type: attractionType.ride,
      tags,
    };
  }

  /**
   * Get the current state of virtual queues for the resort
   */
  async getVirtualQueueStates() {
    return await this.cache.wrap(`universalstudios_${this.config.city}_vqueuestate`, async () => {
      const virtualData = await this.http('GET', `${this.config.baseURL}/Queues`, {
        city: this.config.city,
        page: 1,
        pageSize: 'all',
      });
      return virtualData.body;
    }, 1000 * 60); // 1 minute
  }

  /**
   * Get current state for a virtual queue
   * @param {number} queueId
   * @return {object} Object containing startTime and endTime as a moment object.
   * Or undefined if there are no times available.
   */
  async getVirtualQueueTimeForRide(queueId) {
    return await this.cache.wrap(`vqueue_${queueId}`, async () => {
      const todaysDate = (await this.getActiveParkDateMoment()).format('MM/DD/YYYY');
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
    }, 1000 * 60); // 1 minute
  }

  /**
   * Fetch raw waiting times data
   */
  async getWaitingTimes() {
    return await this.cache.wrapGlobal(`universalstudios_${this.config.city}_waittimes`, async () => {
      const resp = await this.http('GET', `${this.config.baseURL}/pointsofinterest/rides/waittimes`, {
        city: this.config.city,
        pageSize: 'All',
      });
      return resp.body;
    }, 1000 * 60); // cache for 1 minute
  }

  /**
   * @inheritdoc
   */
  async _update() {
    const data = await this.getWaitingTimes();

    await Promise.allSettled(data.Results.filter(
        (x) => x.ContentId.indexOf(this.config.contentID) === 0,
    ).map(async (ride) => {
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

      await this.updateAttractionState(ride.Key, status);
      if (queue == queueType.standBy) {
        await this.updateAttractionQueue(ride.Key, postWaitTime, queueType.standBy);
      } else {
        await this.updateAttractionQueue(ride.Key, undefined, queueType.standBy);
      }
    }));

    // also fetch virtual lines status
    const virtualData = await this.getVirtualQueueStates();
    const vResults = virtualData?.Results;
    if (vResults !== undefined) {
      await Promise.allSettled(vResults.map(async (ride) => {
      // check the right this virtual queue is for is in this park
        const actual = await this.findAttractionByID(ride.QueueEntityId);
        if (actual === undefined) return;

        if (ride.IsEnabled) {
        // get next available slot
          const nextSlot = await this.getVirtualQueueTimeForRide(ride.Id);

          // update return time queue with slot data
          await this.updateAttractionQueue(ride.QueueEntityId, {
            returnStart: nextSlot === undefined ? null : nextSlot.startTime,
            returnEnd: nextSlot === undefined ? null : nextSlot.endTime,
            // TODO - can we tell the difference between temporarily full and finished for the day?
            state: nextSlot === undefined ? returnTimeState.temporarilyFull : returnTimeState.available,
          }, queueType.returnTime);
        } else {
        // virtual queue not enable, ensure return time queue type is not shown
          await this.updateAttractionQueue(ride.QueueEntityId, undefined, queueType.returnTime);
        }
      }));
    } else {
      // virtual queue system is down, unset all virtual queues for this park
      const toUpdate = this._attractions.map((x) => x.rideId);
      for (let i=0; i<toUpdate.length; i++) {
        await this.updateAttractionQueue(toUpdate[i], undefined, queueType.returnTime);
      }
    }
  }

  /**
   * Get the latest raw opening hours for this park
   */
  async getLatestOpeningHours() {
    return await this.cache.wrap('calendar_data', async () => {
      const now = this.getTimeNowMoment();
      const cal = await this.http('GET', `${this.config.baseURL}/venues/${this.config.venueID}/hours`, {
        endDate: now.clone().add(120, 'days').format('MM/DD/YYYY'),
      });
      return cal.body;
    }, 1000 * 60 * 60 * 24); // 1 day
  }

  /**
   * @inheritdoc
   */
  async _getOperatingHoursForDate(date) {
    const cal = await this.getLatestOpeningHours();
    const dateFormatted = date.format('YYYY-MM-DD');
    const todaysCal = cal.find((x) => x.Date === dateFormatted);
    if (todaysCal === undefined) return undefined;

    if (todaysCal.VenueStatus === 'Closed') return undefined;

    const ret = [];
    ret.push({
      openingTime: todaysCal.OpenTimeString,
      closingTime: todaysCal.CloseTimeString,
      type: scheduleType.operating,
    });

    if (todaysCal.EarlyEntryString) {
      // extra hours
      ret.push({
        openingTime: todaysCal.EarlyEntryString,
        closingTime: todaysCal.OpenTimeString,
        type: scheduleType.extraHours,
      });
    }

    // TODO - handle todaysCal.SpecialEntryString (when these exist)
    if (todaysCal.SpecialEntryString) {
      this.emit('error', new Error(`Unknown Universal SpecialEntryString ${todaysCal.SpecialEntryString}`));
    }

    return ret;
  }
}

export default UniversalParkBase;

/**
 * Universal Studios Florida Park
 */
export class UniversalStudiosFlorida extends UniversalParkBase {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.name = 'Universal Studios Florida';
    options.venueID = 10010;
    options.city = 'orlando';
    options.contentID = 'com.uo.usf';

    super(options);
  }
}

/**
 * Islands Of Adventure Park
 */
export class UniversalIslandsOfAdventure extends UniversalParkBase {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.name = 'Universal\'s Islands Of Adventure';
    options.venueID = 10000;
    options.city = 'orlando';
    options.contentID = 'com.uo.ioa';

    super(options);
  }
}

/**
 * Volcano Bay
 */
export class UniversalVolcanoBay extends UniversalParkBase {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.name = 'Universal\'s Volcano Bay';
    options.venueID = 13801;
    options.city = 'orlando';
    options.contentID = 'com.uo.vb';

    super(options);
  }
}

/**
 * Universal Studios Hollywood
 */
export class UniversalStudios extends UniversalParkBase {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.name = 'Universal Studios';
    options.venueID = 13825;
    options.city = 'hollywood';
    options.contentID = 'com.uo.us';

    super(options);
  }
}
