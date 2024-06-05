import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import moment from 'moment-timezone';
import Destination from '../destination.js';
import sift from 'sift';

const parkData = {
  tdl: {
    name: 'Tokyo Disneyland',
    slug: 'tokyodisneyland',
  },
  tds: {
    name: 'Tokyo DisneySea',
    slug: 'tokyodisneysea',
  },
};

/**
 * TokyoDisneyResortPark Object
 */
export class TokyoDisneyResort extends Destination {
  /**
   * Create a new TokyoDisneyResortPark object
   * @param {object} options
   */
  constructor(options = {}) {
    options.name = options.name || 'Tokyo Disney Resort';
    options.timezone = options.timezone || 'Asia/Tokyo';

    options.apiKey = options.apiKey || '';
    options.apiAuth = options.apiAuth || '';
    options.apiOS = options.apiOS || '';
    options.apiBase = options.apiBase || '';
    options.apiVersion = options.apiVersion || '';
    options.parkIds = options.parkIds || ['tdl', 'tds'];
    options.fallbackDeviceId = options.fallbackDeviceId || null;

    // set cache version
    options.cacheVersion = options.cacheVersion || '2';

    // any custom environment variable prefixes we want to use for this park (optional)
    options.configPrefixes = ['TDR'].concat(options.configPrefixes || []);

    super(options);

    if (!this.config.apiKey) throw new Error('Missing TDR apiKey');
    if (!this.config.apiAuth) throw new Error('Missing TDR apiAuth');
    if (!this.config.apiOS) throw new Error('Missing TDR apiOS');
    if (!this.config.apiBase) throw new Error('Missing TDR apiBase');
    if (!this.config.apiVersion) throw new Error('Missing TDR apiVersion');
    if (!this.config.parkIds) throw new Error('Missing TDR parkIds');

    // some convenience strings
    // TODO
    // this.config.parkIdLower = this.config.parkId.toLowerCase();
    // this.config.parkIdUpper = this.config.parkId.toUpperCase();

    this.http.injectForDomain({
      hostname: new URL(this.config.apiBase).hostname,
    }, async (method, url, data, options) => {
      const appVersion = (await this.fetchLatestVersion()) || this.config.apiVersion;

      options.headers['user-agent'] = `TokyoDisneyResortApp/${appVersion} Android/${this.config.apiOS}`;
      options.headers['x-api-key'] = this.config.apiKey;
      options.headers['X-PORTAL-LANGUAGE'] = 'en-US';
      options.headers['X-PORTAL-OS-VERSION'] = `Android ${this.config.apiOS}`;
      options.headers['X-PORTAL-APP-VERSION'] = appVersion;
      options.headers['X-PORTAL-DEVICE-NAME'] = 'OnePlus5';
      options.headers.connection = 'keep-alive';
      options.headers['Accept-Encoding'] = 'gzip';
      options.headers.Accept = 'application/json';
      options.headers['Content-Type'] = 'application/json';

      if (!options.ignoreDeviceID) {
        const deviceID = await this.fetchDeviceID();
        if (!deviceID) {
          options.headers['X-PORTAL-DEVICE-ID'] = this.config.fallbackDeviceId;
        } else {
          options.headers['X-PORTAL-DEVICE-ID'] = deviceID;
        }
        options.headers['X-PORTAL-AUTH'] = this.config.apiAuth;
      }

      // we handle auth/500 errors ourselves for TDR
      options.ignoreErrors = true;
    });

    this.http.injectForDomainResponse({
      hostname: new URL(this.config.apiBase).hostname,
    }, async (resp) => {
      if (resp.statusCode === 400) {
        console.log('TDR version invalid, fetch again...');
        // force a store version update if we get a 400 error
        await this.cache.set('tdr_appversion', undefined, -1);
        return undefined;
      }

      if (resp.statusCode === 503) {
        const maintenance = resp.body.errors.find((x) => x.code === 'error.systemMaintenance');
        if (maintenance) {
          // down for maintenance!
          const now = this.getTimeNowMoment();
          if (now.isBetween(maintenance.startAt, maintenance.endAt)) {
            const endsIn = now.diff(maintenance.endAt, 'minutes');
            this.log(`Tokyo Disney Resort API in maintenance. Ends in ${Math.abs(endsIn)} minutes`);
            // return original response to avoid refetching again and again and again
            return resp;
          }
        } else {
          this.emit('error', new Error(`Invalid response from TDR ${JSON.stringify(resp.body)}`));
        }
      }

      return resp;
    });
  }

  /**
   * Fetch the current app version on the Google Play store
   * @return {string}
   */
  async fetchLatestVersion() {
    // cache 2 hours
    '@cache|120';
    return this.getAndroidAPPVersion('jp.tokyodisneyresort.portalapp');
  }

  /**
   * Return or fetch a device ID to use for API calls
   */
  async fetchDeviceID() {
    // cache 2 weeks
    '@cache|20160';
    try {
      const resp = await this.http(
        'POST',
        `${this.config.apiBase}/rest/v1/devices`,
        undefined,
        {
          ignoreDeviceID: true,
          retries: 0,
        },
      );

      return resp.body.deviceId;
    } catch (e) {
      if (this.config.fallbackDeviceId) {
        this.log(`Failed to fetch device ID, using fallback: ${this.config.fallbackDeviceId}`);
        return this.config.fallbackDeviceId;
      }
      // otherwise, rethrow error
      throw e;
    }
  }

  /**
   * Get the latest facilities data for the entire resort
   */
  async fetchAllFacilitiesData() {
    // cache 20 hours
    '@cache|1200';
    const headers = {};
    const lastModifiedTime = await this.cache.get('tdr_facilities_last_modified');
    if (lastModifiedTime !== undefined) {
      headers['If-Modified-Since'] = lastModifiedTime;
    }

    const resp = await this.http('GET', `${this.config.apiBase}/rest/v4/facilities`, undefined, {
      headers,
    });

    // store in a separate long-term cache so we can keep using it if the server data hasn't changed
    if (resp.statusCode !== 304) {
      // transform data into an array with "facilityType", rather than a nested object
      const data = [];
      Object.keys(resp.body).forEach((key) => {
        resp.body[key].forEach((x) => {
          data.push({
            facilityType: key,
            ...x,
          });
        });
      });

      await this.cache.set('tdr_facilities_data', data, Number.MAX_SAFE_INTEGER);
      await this.cache.set(
        'tdr_facilities_last_modified',
        resp.headers['Last-Modified'],
        Number.MAX_SAFE_INTEGER,
      );
      return data;
    }

    return await this.cache.get('tdr_facilities_data');
  }

  /**
   * Get facilities data for this park
   */
  async fetchFacilitiesData() {
    // cache 1 hour
    '@cache|60';
    const parkIdsUpper = this.config.parkIds.map((x) => x.toUpperCase());
    const resortData = await this.fetchAllFacilitiesData();
    return resortData.filter((x) => parkIdsUpper.indexOf(x.parkType) >= 0);
  }

  /**
   * @inheritdoc
   */
  async _buildAttractionObject(attractionID) {
    const facilityData = await this.fetchFacilitiesData();
    const attr = facilityData.find((x) => x.facilityCode == attractionID);
    if (attr === undefined) return undefined;

    const tags = [];

    tags.push({
      type: tagType.fastPass,
      value: !!attr.fastpass,
    });

    tags.push({
      type: tagType.singleRider,
      value: !!attr.filters.find((x) => x.type === 'SINGLE_RIDER'),
    });

    const heightUppper = attr.restrictions.find((x) => x.type === 'LOWER_HEIGHT');
    if (heightUppper !== undefined) {
      const heightMin = /(\d+)\s*cm/.exec(heightUppper.name);
      if (heightMin) {
        tags.push({
          key: 'minimumHeight',
          type: tagType.minimumHeight,
          value: {
            unit: 'cm',
            height: Number(heightMin[1]),
          },
        });
      }
    }

    const heightLower = attr.restrictions.find((x) => x.type === 'UPPER_HEIGHT');
    if (heightLower !== undefined) {
      const heightMax = /(\d+)\s*cm/.exec(heightLower.name);
      if (heightMax) {
        tags.push({
          key: 'maximumHeight',
          type: tagType.maximumHeight,
          value: {
            unit: 'cm',
            height: Number(heightMax[1]),
          },
        });
      }
    }

    tags.push({
      type: tagType.unsuitableForPregnantPeople,
      value: attr.filters.find((x) => x === 'EXPECTANT_MOTHER') === undefined,
    });

    return {
      name: attr.nameKana,
      type: attr.facilityType === 'attractions' ? attractionType.ride : attractionType.other,
      tags,
    };
  }

  /**
   * @inheritdoc
   */
  async _update() {
    const resp = await this.http(
      'GET',
      `${this.config.apiBase}/rest/v6/facilities/conditions`,
    );

    const attractions = resp?.body?.attractions;
    if (!attractions) {
      return;
    }

    await Promise.allSettled(attractions.map(async (attr) => {
      let status = attr.standbyTime ? statusType.operating : statusType.closed;
      switch (attr.facilityStatus) {
        case 'CANCEL':
          status = statusType.closed;
          break;
        case 'CLOSE_NOTICE':
          status = statusType.down;
          break;
        case 'OPEN':
          status = statusType.operating;
          break;
      }

      await this.updateAttractionState(attr.facilityCode, status);
      await this.updateAttractionQueue(
        attr.facilityCode,
        status == statusType.operating ? attr.standbyTime : null,
        queueType.standBy,
      );
    }));
  }

  /**
   * Fetch the upcoming calendar
   */
  async fetchCalendar() {
    // cache 12 hours
    '@cache|720';
    const cal = await this.http(
      'GET',
      `${this.config.apiBase}/rest/v1/parks/calendars`,
    );

    return cal.body;
  }

  /**
   * @inheritdoc
   */
  async _getOperatingHoursForDate(date) {
    const cal = await this.fetchCalendar();

    if (!Array.isArray(cal)) return undefined;

    const dateString = date.format('YYYY-MM-DD');
    const targetDate = cal.find((x) => {
      return x.parkType === this.config.parkIdUpper &&
        x.closedDay === false &&
        x.undecided === false &&
        x.date === dateString;
    });
    if (targetDate) {
      const hours = [];
      const momentParseFormat = 'YYYY-MM-DDTHH:mm';

      hours.push({
        openingTime: moment.tz(
          `${dateString}T${targetDate.openTime}`,
          momentParseFormat,
          this.config.timezone).format(),
        closingTime: moment.tz(
          `${dateString}T${targetDate.closeTime}`,
          momentParseFormat,
          this.config.timezone).format(),
        type: scheduleType.operating,
      });

      // "sp" opening times, i.e, magic hours
      if (targetDate.spOpenTime && targetDate.spCloseTime) {
        hours.push({
          openingTime: moment.tz(
            `${dateString}T${targetDate.spOpenTime}`,
            momentParseFormat,
            this.config.timezone).format(),
          closingTime: moment.tz(
            `${dateString}T${targetDate.spCloseTime}`,
            momentParseFormat,
            this.config.timezone).format(),
          type: scheduleType.extraHours,
        });
      }

      return hours;
    }

    return undefined;
  }

  /**
   * Fetch the restaurant operating hours
   */
  async fetchRestaurantOperatingHours() {
    const resp = await this.http(
      'GET',
      `${this.config.apiBase}/rest/v6/facilities/conditions`,
    );

    return resp.body.restaurants.map((restaurant) => {
      // console.log(restaurant);
      if (!restaurant.operatings || restaurant.operatings.length === 0) {
        return {
          restaurantID: restaurant.facilityCode,
          openingTime: 0,
          closingTime: 0,
          status: statusType.closed,
        };
      }

      // TODO: restaurant.facilityStatus check needed?
      const momentParseFormat = 'YYYY-MM-DDTHH:mm';
      const schedule = restaurant.operatings[0];

      return {
        restaurantID: restaurant.facilityCode,
        openingTime: moment.tz(
          schedule.startAt,
          momentParseFormat,
          this.config.timezone).format(),
        closingTime: moment.tz(
          schedule.endAt,
          momentParseFormat,
          this.config.timezone).format(),
        status: statusType.operating,
      };
    });
  }

  /**
     * Return restaurant operating hours for the supplied date
     * @param {moment} date
     */
  async _getRestaurantOperatingHoursForDate(date) {
    const cal = await this.fetchRestaurantOperatingHours();
    if (!cal) return undefined;
    return cal;
  }


  /**
   * Helper function to build a basic entity document
   * Useful to avoid copy/pasting
   * @param {object} data
   * @return {object}
   */
  buildBaseEntityObject(data) {
    const entity = Destination.prototype.buildBaseEntityObject.call(this, data);

    entity.name = data?.name;
    if (data?.parkType) {
      entity._parkId = data.parkType.toLowerCase();
      entity._parentId = data.parkType.toLowerCase();
    }

    if (data?.latitude) {
      entity.location = {
        longitude: Number(data.longitude),
        latitude: Number(data.latitude),
      };
    }

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    return {
      ...this.buildBaseEntityObject(),
      _id: 'tdr',
      slug: 'tokyodisneyresort',
      name: this.config.name,
      entityType: entityType.destination,
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    return this.config.parkIds.map((x) => {
      return {
        ...this.buildBaseEntityObject(null),
        _id: x,
        _destinationId: 'tdr',
        _parentId: 'tdr',
        entityType: entityType.park,
        ...parkData[x],
      };
    });
  }

  /**
   * Return an array of entities given a filter function (sift-style)
   * @param {function} filterFn
   * @return {array<entity>}
   */
  async getEntitiesOfType(filterFn) {
    const poiData = await this.fetchFacilitiesData();

    if (!poiData) {
      return [];
      // throw error
      throw new Error('Failed to fetch POI data');
    }

    return poiData.filter(sift(filterFn)).map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        _id: `${x.facilityCode}`,
        _destinationId: 'tdr',
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
      };
    });
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    return this.getEntitiesOfType((x) => {
      // look for attractions that aren't a "dummy" entry
      //  ignore photoMapFlgs, unless facility has any hints the photoMapFlg tag is set incorrectly (i.e, Splash Mountain)
      return x.facilityType === 'attractions' && !x.dummyFacility && (!x.photoMapFlg || (x.filters && x.filters.indexOf('THRILL') >= 0) || !!x.fastPass);
    });
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    return this.getEntitiesOfType((x) => {
      return x.facilityType === 'entertainments' && !x.dummyFacility && !x.photoMapFlg;
    });
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    return [];
  }

  /**
   * Fetch live wait time data
   * @return {array<data>}
   */
  async _fetchWaitTimes() {
    '@cache|1';
    const resp = await this.http(
      'GET',
      `${this.config.apiBase}/rest/v6/facilities/conditions`,
    );

    const attractions = resp?.body?.attractions;
    return attractions;
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const waitTimes = await this._fetchWaitTimes();

    const livedata = [];
    for (let i = 0; i < waitTimes.length; i++) {
      const attr = waitTimes[i];
      const live = {
        _id: attr.facilityCode,
        status: attr.standbyTime ? statusType.operating : statusType.closed,
      };

      switch (attr.facilityStatus) {
        case 'CANCEL':
          live.status = statusType.closed;
          break;
        case 'CLOSE_NOTICE':
          live.status = statusType.down;
          break;
        case 'OPEN':
          live.status = statusType.operating;
          break;
      }

      live.queue = {
        [queueType.standBy]: {
          waitTime: live.status == statusType.operating ? attr.standbyTime : null,
        },
      };

      livedata.push(live);
    }

    return livedata;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @return {array<object>}
   */
  async buildEntityScheduleData() {
    const cal = await this.fetchCalendar();

    if (!Array.isArray(cal)) return undefined;

    const parksUpper = this.config.parkIds.map((x) => x.toUpperCase());
    const momentParseFormat = 'YYYY-MM-DDTHH:mm';

    const schedules = this.config.parkIds.map((x) => {
      return {
        _id: x,
        schedule: [],
      };
    });

    cal.forEach((entry) => {
      // skip if not for a park
      if (parksUpper.indexOf(entry.parkType) < 0) return;
      // skip if a closed or "undecided" (?!) schedule day
      if (entry.undecided || entry.closedDay) return;

      const scheduleObj = schedules.find((x) => x._id === entry.parkType.toLowerCase());

      scheduleObj.schedule.push({
        date: entry.date,
        openingTime: moment.tz(
          `${entry.date}T${entry.openTime}`,
          momentParseFormat,
          this.config.timezone).format(),
        closingTime: moment.tz(
          `${entry.date}T${entry.closeTime}`,
          momentParseFormat,
          this.config.timezone).format(),
        type: scheduleType.operating,
      });

      // "sp" opening times, i.e, magic hours
      if (entry.spOpenTime && entry.spCloseTime) {
        scheduleObj.schedule.push({
          date: entry.date,
          openingTime: moment.tz(
            `${entry.date}T${entry.spOpenTime}`,
            momentParseFormat,
            this.config.timezone).format(),
          closingTime: moment.tz(
            `${entry.date}T${entry.spCloseTime}`,
            momentParseFormat,
            this.config.timezone).format(),
          type: scheduleType.extraHours,
          description: 'Special Hours',
        });
      }
    });

    return schedules;
  }
}

export default TokyoDisneyResort;

/*
export class TokyoDisneyland extends TokyoDisneyResortPark {
  constructor(options = {}) {
    options.name = 'Tokyo Disney Resort - Tokyo Disneyland';
    options.parkId = 'tdl';

    super(options);
  }
}

export class TokyoDisneySea extends TokyoDisneyResortPark {
  constructor(options = {}) {
    options.name = 'Tokyo Disney Resort - Tokyo DisneySea';
    options.parkId = 'tds';

    super(options);
  }
}
*/
