import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import {v4 as uuidv4} from 'uuid';
import * as cheerio from 'cheerio';
import moment from 'moment-timezone';

export class ResortsWorldSentosa extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Asia/Singapore';

    options.resortId = options.resortId || 'resortsworldsentosa';
    options.parkId = options.parkId || 'universalstudiossingapore';
    options.secretKey = options.secretKey || '';
    options.baseURL = options.baseURL || 'https://ama.rwsentosa.com';
    options.language = options.language || 1; // 1 = English, 2 = Chinese
    options.name = options.name || 'Resorts World Sentosa';
    options.parkName = options.parkName || 'Universal Studios Singapore';
    options.resortLatitude = options.resortLatitude || 1.259525;
    options.resortLongitude = options.resortLongitude || 103.823773;
    options.parkLatitude = options.parkLatitude || 1.256685;
    options.parkLongitude = options.parkLongitude || 103.821208;

    super(options);

    if (!this.config.secretKey) throw new Error('Missing secretKey');
    if (!this.config.baseURL) throw new Error('Missing baseURL');
    if (!this.config.language) throw new Error('Missing language');
    if (!this.config.name) throw new Error('Missing name');
    if (!this.config.resortLatitude) throw new Error('Missing resortLatitude');
    if (!this.config.resortLongitude) throw new Error('Missing resortLongitude');

    this.http.useragent = 'Dart/3.5 (dart:io)';

    // inject for base API domain
    const baseURLHostname = new URL(this.config.baseURL).hostname;
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      const shouldFetchAuthToken = options && options.skipAuth !== true;
      if (shouldFetchAuthToken) {
        // inject our auth token into the request
        const token = await this._getLoginToken();
        if (!token) {
          throw new Error('Failed to get login token');
        }

        options.headers = options.headers || {};
        options.headers['Authorization'] = `Bearer ${token}`;
      }

      return {
        method,
        url,
        data,
        options,
      };
    });

    this.http.injectForDomainResponse({
      hostname: baseURLHostname,
    }, async (response) => {
      if (response.statusCode === 401) {
        this.log('Received 401 response, clearing auth token and trying again');
        // clear out our token and try again
        await this._clearFunctionCache('_getAuthToken');
        await this._clearFunctionCache('_getLoginToken');

        return response;
      }

      // otherwise, return the actual response
      return response;
    });
  }

  /**
   * Get the auth token to login to the API
   */
  async _getAuthToken() {
    // cache for 1 week
    '@cache|1w';

    const url = `${this.config.baseURL}/uniapi/api/v2/Authenticate/AuthenticateUser`;
    const resp = await this.http('POST', url, {
      SecretKey: this.config.secretKey,
    }, {
      json: true,
      skipAuth: true, // don't try to auth this request
      retries: 0,
    });

    return resp.body.Data.Token || undefined;
  }

  /**
   * Generate a random device ID
   * @returns {string}
   */
  async _generateDeviceID() {
    return uuidv4();
  }

  /**
   * Get the login token needed by most API requests
   */
  async _getLoginToken() {
    '@cache|4h'; // cache for 4 hours

    const token = await this._getAuthToken();
    if (!token) {
      throw new Error('Failed to get auth token');
    }

    // get a random device ID
    const deviceId = await this._generateDeviceID();

    // get latest app version
    const appVersion = await this.getAndroidAPPVersion("com.rwsentosa.UniversalSG");

    const url = `${this.config.baseURL}/uniapi/api/Login/WithoutLogin`;
    const body = {
      "deviceType": "1",
      "deviceId": deviceId,
      "appVersion": appVersion,
      "fcmToken": "",
      "isNotificationAlert": false,
      "languageId": 1,
      "IpAddress": "192.168.0.1"
    };

    const resp = await this.http('POST', url, body, {
      json: true,
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      skipAuth: true, // don't try to auth this request
    });

    // check StatusCode, if not 200, nuke the cache for our auth token
    if (resp.body.StatusCode !== 200) {
      this.log('Received non-200 response for login, clearing auth token and trying again');
      await this._clearFunctionCache('_getAuthToken');
    }

    return resp.body.Result.Token || undefined;
  }

  /**
   * Helper function to build a basic entity document
   * Useful to avoid copy/pasting
   * @param {object} data 
   * @returns {object}
   */
  buildBaseEntityObject(data) {
    const entity = Destination.prototype.buildBaseEntityObject.call(this, data);

    if (data) {
      if (data.AttractionId) {
        entity._id = `attraction_${data.AttractionId}`;
      }

      if (data.Title) {
        entity.name = data.Title;
      }

      if (data.LatLng) {
        // split string and parse to Number for lat/lng
        const [latitude, longitude] = data.LatLng.split(',').map(Number);
        entity.location = {
          latitude,
          longitude,
        };
      }
    }

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    return {
      ...this.buildBaseEntityObject(),
      _id: this.config.resortId,
      slug: this.config.resortId,
      name: this.config.name,
      entityType: entityType.destination,
      location: {
        latitude: this.config.resortLatitude,
        longitude: this.config.resortLongitude,
      },
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    return [
      {
        ...this.buildBaseEntityObject(null),
        _id: this.config.parkId,
        _destinationId: this.config.resortId,
        _parentId: this.config.resortId,
        name: this.config.parkName,
        entityType: entityType.park,
        location: {
          latitude: this.config.parkLatitude,
          longitude: this.config.parkLongitude,
        },
      }
    ];
  }

  /**
   * Helper function to fetch attraction list from app
   * @param {object} options
   * @param {number} options.poiCategory - 1 = rides, 2 = shows, 3 = meet and greets
   * @returns 
   */
  async _fetchAttractionList({
    poiCategory = 1,
    dateTimeString = this.getTimeNowMoment().format('YYYYMMDDHHmmss'),
  }) {
    const url = `${this.config.baseURL}/uniapi/api/v2/Transaction/GetAttractionList/${this.config.language}/${poiCategory}/${dateTimeString}`;

    const resp = await this.http('GET', url, null, {
      json: true,
    });

    return resp.body.Result || [];
  }

  /**
   * Fetch attraction data. Includes basic POI and wait time data
   */
  async _fetchAttractionData() {
    '@cache|1m'; // cache for 1 minute
    return this._fetchAttractionList({
      poiCategory: 1, // rides
    });
  }

  /**
   * Fetch show data. Includes basic POI data
   */
  async _fetchShowData() {
    '@cache|1m'; // cache for 1 minute
    return this._fetchAttractionList({
      poiCategory: 2, // shows
    });
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const attractions = await this._fetchAttractionData();

    return attractions.map((attraction) => {
      return {
        ...this.buildBaseEntityObject(attraction),
        _destinationId: this.config.resortId,
        _parentId: this.config.parkId,
        _parkId: this.config.parkId,
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
      };
    });
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    const shows = await this._fetchShowData();

    return shows.map((show) => {
      return {
        ...this.buildBaseEntityObject(show),
        _destinationId: this.config.resortId,
        _parentId: this.config.parkId,
        _parkId: this.config.parkId,
        entityType: entityType.show,
      };
    });
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    return [];
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const attractionData = await this._fetchAttractionData();
    const showData = await this._fetchShowData();

    return attractionData.map((attraction) => {
      // skip any attractions that don't have wait times
      if (!attraction.isWaitTimeEnable) {
        return null;
      }

      const liveData = {
        _id: `attraction_${attraction.AttractionId}`,
        status: statusType.operating,
      };

      // try to extract wait time
      //  usually sits as a string like "15 mins"
      const waitTimeMatch = attraction.WaitTime.match(/(\d+)\s+min/i);
      let waitTime = null;
      if (waitTimeMatch) {
        waitTime = parseInt(waitTimeMatch[1]);

        liveData.queue = {
          [queueType.standBy]: {
            waitTime,
          }
        };
      } else {
        // no wait time, mark as closed
        liveData.status = statusType.closed;

        // TODO - handle any other states
      }

      return liveData;
    }).concat(showData.map((show) => {
      // TODO - handle live show data
      return null;
    })).filter((x) => x !== null);
  }

  /**
   * Fetch the app's side menu content, which will tell us the ID for the park opening hours
   */
  async _fetchSideMenuContent() {
    // cache for 10 hours
    '@cache|10h';
    const url = `${this.config.baseURL}/uniapi/api/v2/Master/GetSideMenu/${this.config.language}`;
    const resp = await this.http('GET', url, null, {
      json: true,
    });

    return resp.body.Result || [];
  }

  /**
   * Fetch the content from the park hours page
   */
  async _fetchParkHoursContent() {
    // cache for 1 day
    '@cache|1d';
    // fetch the side menu content first to get the ID for the park hours
    const sideMenuContent = await this._fetchSideMenuContent();

    // find the object that has "Park Hours" as AttractionCategoryName or DefaultAttractionCategoryName
    let parkHoursObj = null;
    for (const sideMenuCategory of sideMenuContent) {
      for (const sideMenuItem of sideMenuCategory.MenuAttractionCategory) {
        if (sideMenuItem.AttractionCategoryName === 'Park Hours' || sideMenuItem.DefaultAttractionCategoryName === 'Park Hours') {
          parkHoursObj = sideMenuItem;
          break;
        }
      }
    }

    // fetch CMS content
    const parkDataURL = `${this.config.baseURL}/uniapi/api/v2/Transaction/GetCmsList/${this.config.language}`;
    const parkDataResp = await this.http('GET', parkDataURL, null, {
      json: true,
    });

    const result = parkDataResp.body.Result || [];
    return result.find((x) => {
      return x.AttractionCategoryId === parkHoursObj.AttractionCategoryId;
    });
  }

  async _parseParkHoursContent(cmsObject) {
    const html = cmsObject.CmsContent;
    const $ = cheerio.load(html);

    // find all <tr> elements in the table
    const rows = $('table tr');
    // for each row, determine if it's a month/year combo, or a date with opening hours
    const parkHours = [];
    let currentMonth = null;
    let currentYear = null;
    rows.each((index, row) => {
      const $row = $(row);
      const cells = $row.find('td');

      // if we have 1 cell, it's a month + year header
      if (cells.length === 1) {
        const monthYear = cells.eq(0).text().trim();
        const monthYearParts = monthYear.split(' ');
        currentMonth = monthYearParts[0];
        currentYear = monthYearParts[1];
      } else if (cells.length === 3) {
        // example:
        // <tr>\r\n\t\t\t<td>Wed</td>\r\n\t\t\t<td>1</td>\r\n\t\t\t<td>10:00AM - 8:00PM</td>\r\n\t\t</tr>
        const dayOfWeek = cells.eq(0).text().trim();
        const dayOfMonth = cells.eq(1).text().trim();
        const hours = cells.eq(2).text().trim();

        // parse the hours
        const hoursParts = hours.split(' - ');
        const openingTime = hoursParts[0];
        const closingTime = hoursParts[1];

        // parse the date
        const date = `${currentYear}-${currentMonth}-${dayOfMonth}`;
        const dateMoment = moment(date, 'YYYY-MMM-DD');
        
        // build opening and closing hours in our destination's timezone
        const openTime = moment.tz(dateMoment.format('YYYY-MM-DD') + 'T' + moment(openingTime, 'h:mma').format('HH:mm:ssZ'), this.config.timezone);
        const closeTime = moment.tz(dateMoment.format('YYYY-MM-DD') + 'T' + moment(closingTime, 'h:mma').format('HH:mm:ssZ'), this.config.timezone);

        parkHours.push({
          date: dateMoment.format('YYYY-MM-DD'),
          type: scheduleType.operating,
          openingTime: openTime.format(),
          closingTime: closeTime.format(),
        });
      }
    });

    return parkHours;
  }

  /**
   * Fetch the park hours for this destination
   */
  async _getParkHours() {
    // cache for 1 hour
    '@cache|1h';
    const parkHoursContent = await this._fetchParkHoursContent();
    return this._parseParkHoursContent(parkHoursContent);
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const parkHoursContent = await this._getParkHours();

    return [
      {
        _id: this.config.parkId,
        schedule: parkHoursContent,
      }
    ];
  }
}
