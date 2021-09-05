import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';

import {v4 as uuidv4} from 'uuid';

import sift from 'sift';
import moment from 'moment-timezone';

import cheerio from 'cheerio';

export class Phantasialand extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Europe/Berlin';

    options.apiBase = options.apiBase || '';

    super(options);

    if (!this.config.apiBase) throw new Error('Missing API Base URL (apiBase)');

    const baseURLHostname = new URL(this.config.apiBase).hostname;

    this.http.useragent = 'okhttp/3.12.1';

    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      const isLoginRequest = url.indexOf('app-users') >= 0;
      if (!isLoginRequest && method === 'GET') {
        // fetch our cached access token
        data.access_token = await this.fetchAccessToken();
      }
    });

    // similarly, we can also inject into HTTP responses
    //  if we detect an unauthorised response, we can unset our local auth tokens so they are refetched
    this.http.injectForDomainResponse({
      hostname: baseURLHostname,
    }, async (response) => {
      // look for 401 HTTP code (unauthorised)
      if (response.statusCode === 401) {
        // clear our access token on unauthorised responses
        await this._clearFunctionCache('fetchAccessToken');
        return undefined;
      }

      // otherwise, return the actual response
      return response;
    });
  }

  /**
   * Create or fetch existing user for app login
   */
  async createUser() {
    '@cache|481801'; // cache 11 months

    // generate login
    const username = `${uuidv4()}@android.com`;
    const password = uuidv4();

    // create our user
    const userCreationResp = await this.http(
      'POST',
      `${this.config.apiBase}app-users`,
      {
        "email": username,
        "language": "en",
        "password": password,
        "platform": "android"
      },
      {
        json: true,
      },
    );

    if (userCreationResp.body.email !== username) {
      return undefined;
    }

    return {
      "email": username,
      "password": password,
    };
  }

  /**
   * Fetch cached access token, or fetch new one if expired
   * @returns {string}
   */
  async fetchAccessToken() {
    '@cache|481801'; // cache 11 months

    // create user
    const user = await this.createUser();
    if (user === undefined) {
      return undefined;
    }

    // login and get access token
    const accessTokenResp = await this.http(
      'POST',
      `${this.config.apiBase}app-users/login`,
      {
        "email": user.email,
        "password": user.password,
        "ttl": 31556926, // 1 year, matching app behaviour
      },
      {
        json: true,
      },
    );

    this.log('Got new access token', accessTokenResp?.body?.id);

    // return our new access token
    return accessTokenResp?.body?.id;
  }

  /**
   * Get the POI data objects from the API
   * @returns {Array<Object>}
   */
  async getPOIData() {
    '@cache|360'; // cache 6 hours
    const POI = await this.http(
      'GET',
      `${this.config.apiBase}pois`,
      {
        'filter[where][seasons][like]': '%',
        compact: true,
      },
    );

    return POI.body;
  }

  /**
   * Helper function to build a basic entity document
   * Useful to avoid copy/pasting
   * @param {object} data 
   * @returns {object}
   */
  buildBaseEntityObject(data) {
    const entity = super.buildBaseEntityObject(data);

    if (data) {
      if (data.adminOnly) return undefined;

      // not on the map, ignore
      if (!data.poiNumber) {
        return undefined;
      }

      // if has no seasons, ignore
      if (!data.seasons || data.seasons.length === 0) {
        return undefined;
      }

      if (data.id !== undefined) {
        entity._id = `${data.id}`;
      }

      // entity name
      entity.name = data.title?.en || data._title?.en || data.title?.de || data._title?.de || undefined;

      // entity location
      const location = data.entrance?.world || data._entrance?.world;
      if (location) {
        entity.location = {
          longitude: location.lng,
          latitude: location.lat,
        };
      }
    }

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    const doc = {};
    return {
      ...this.buildBaseEntityObject(doc),
      _id: 'phantasialanddest',
      slug: 'phantasialand', // all destinations must have a unique slug
      name: 'Phantasialand',
      entityType: entityType.destination,
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    return [
      {
        ...this.buildBaseEntityObject(null),
        _id: 'phantasialand',
        _destinationId: 'phantasialanddest',
        _parentId: 'phantasialanddest',
        slug: 'phantasialandpark',
        name: 'Phantasialand',
        entityType: entityType.park,
      }
    ];
  }

  async _buildEntitiesFromCategory(filter, extraFields = {}) {
    const entities = await this.getPOIData();

    return entities.filter(sift(filter)).map((x) => {
      const ent = this.buildBaseEntityObject(x);
      if (!ent) return undefined;
      return {
        ...ent,
        _destinationId: 'phantasialanddest',
        _parentId: 'phantasialand',
        ...extraFields,
      };
    }).filter((x) => !!x);
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    return await this._buildEntitiesFromCategory({
      category: 'ATTRACTIONS',
    }, {
      entityType: entityType.attraction,
      attractionType: attractionType.ride,
    });
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    return await this._buildEntitiesFromCategory({
      category: {
        $or: ['SHOWS', 'THE_SIX_DRAGONS', 'THEATER'],
      },
    }, {
      entityType: entityType.show,
    });
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    return await this._buildEntitiesFromCategory({
      category: {
        $or: ['RESTAURANTS_AND_SNACKS', 'PHANTASIALAND_HOTELS_RESTAURANTS'],
      },
      tags: {
        $elemMatch: 'RESTAURANT',
      },
    }, {
      entityType: entityType.restaurant,
    });
  }

  /**
   * Get a random lat/lon position within this destination
   */
  getRandomLocation() {
    return {
      longitude: 6.878342628 + (Math.random() * (6.877570152 - 6.878342628)),
      latitude: 50.800659529 + (Math.random() * (50.799683077 - 50.800659529)),
    };
  }

  /**
   * Fetch live data from API
   */
  async fetchLiveData() {
    '@cache|1'; // cache 1 minute
    const randomLoc = this.getRandomLocation();

    const waitData = await this.http('GET',
      `${this.config.apiBase}signage-snapshots`,
      {
        loc: `${randomLoc.latitude},${randomLoc.longitude}`,
        compact: true,
      },
    );

    return waitData?.body;
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const liveData = await this.fetchLiveData();

    return liveData.map((x) => {
      const liveData = {
        _id: `${x.poiId}`,
        status: statusType.operating,
      };

      if (x.showTimes !== null) {
        liveData.status = x.showTimes.length > 0 ? statusType.operating : statusType.closed;
        liveData.showtimes = x.showTimes.map((x) => {
          return {
            type: "Performance Time",
            startTime: moment.tz(x, "YYYY-MM-DD HH:mm:ss", this.config.timezone).format(),
            // return null for endTime as we don't have a show length available
            endTime: null,
          };
        });
      }

      if (x.waitTime !== null) {
        liveData.status = x.open ? statusType.operating : statusType.closed;
        liveData.queue = {
          [queueType.standBy]: {
            waitTime: x.waitTime,
          },
        };
      }

      return liveData;
    }).filter((x) => !!x);
  }

  /**
   * Fetch calendar HTML data
   */
  async fetchCalendarData() {
    '@cache|120';
    const html = await this.http('GET', 'https://www.phantasialand.de/en/theme-park/opening-hours/');
    return html.body;
  }

  /**
   * Parse calendar data JSON from webpage
   */
  async getCalendarJSON() {
    const data = await this.fetchCalendarData();
    if (!data) return null;

    try {
      const $ = cheerio.load(data);
      const json = $('.phl-date-picker');
      const jsonData = JSON.parse(json.attr('data-calendar'));
      return jsonData;
    } catch (e) {
      return null;
    }
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const calendarData = await this.getCalendarJSON();

    if (!calendarData) return [];

    const parkSchedule = [];

    const hoursRegex = /([0-9]{1,2}):([0-9]{2}).*\s([0-9]{1,2}):([0-9]{2})/;

    calendarData.forEach((x) => {
      // skip closed entries
      if (x.title_en === 'Closed') return;

      if (!x.days_selected) return;

      const openingTimes = hoursRegex.exec(x.title);
      if (openingTimes) {
        const openingTime = moment.tz(`${openingTimes[1]}:${openingTimes[2]}`, 'HH:mm', this.config.timezone);
        const closingTime = moment.tz(`${openingTimes[3]}:${openingTimes[4]}`, 'HH:mm', this.config.timezone);

        x.days_selected.forEach((day) => {
          parkSchedule.push({
            "date": day,
            "type": "OPERATING",
            "openingTime": moment.tz(`${day} ${openingTime.format('HH:mm')}`, 'YYYY-MM-DD HH:mm', this.config.timezone).format(),
            "closingTime": moment.tz(`${day} ${closingTime.format('HH:mm')}`, 'YYYY-MM-DD HH:mm', this.config.timezone).format(),
          });
        });
      }
    });

    return [
      {
        _id: 'phantasialand',
        schedule: parkSchedule,
      },
    ];
  }
}
