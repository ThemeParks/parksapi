import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';

// guid lib
import {v4 as uuidv4} from 'uuid';

import * as cheerio from 'cheerio';

import moment from 'moment-timezone';

export class LotteWorld extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Asia/Seoul';
    options.name = options.name || 'Lotte World';

    // Android package ID for this destination's app
    options.appID = options.appID || 'com.lotteworld.android.lottemagicpass';

    options.baseURL = options.baseURL || '';

    // call super() with our options object
    super(options);

    if (!this.config.baseURL) {
      throw new Error('Missing baseURL');
    }

    // setup some API hooks
    //  we can automatically auth/react to any http requests without having to constantly rewrite the same login logic
    const baseURLHostname = new URL(this.config.baseURL).hostname;

    // intercept requests to setup a cookie jar
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      // add our JSESSIONID cookie to all requests
      if (options?.skipCookies) {
        // if we have a skipCookies flag, don't add our cookie
        //  this is usually for requests that are setting up our cookie
        return;
      }

      // make sure we're registered
      await this._registerDevice();

      const cookie = await this.cache.get('sessionid');
      if (!cookie) {
        console.error('Missing JSESSIONID cookie for Lotte World');
        return;
      }

      // add our cookie to the request
      options.headers = options.headers || {};
      options.headers['Cookie'] = `JSESSIONID=${cookie}`;

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
      // gather any JSESSIONID cookies from the response and store them
      const cookies = response.headers['set-cookie'];
      if (!cookies) {
        return response;
      }

      // find our JSESSIONID cookie
      const sessionCookie = cookies.find(cookie => cookie.startsWith('JSESSIONID='));
      if (!sessionCookie) {
        return response;
      }

      // extract the token from our header by finding JSESSIONID= and then the next ;
      const token = sessionCookie.match(/JSESSIONID=([^;]+)/)[1];
      if (!token) {
        return response;
      }
      await this.cache.set('sessionid', token, 1000 * 60 * 60 * 3); // 3 hours

      return response;
    });
  }

  /**
   * Get the current version of the Android app for Lotte World
   */
  async _getAppVersion() {
    '@cache|1d'; // cache for 1 day
    const version = await this.getAndroidAPPVersion(this.config.appID || '3.0.32');
    return version;
  }

  /**
   * Register a device with the Lotte World API
   * This generates our JSESSIONID cookie
   */
  async _registerDevice() {
    // check if we have a JSESSIONID cookie cached
    const cookie = await this.cache.get('sessionid');
    if (cookie) {
      return;
    }

    // generate a random GUID for our device ID
    const deviceID = uuidv4();

    const deviceData = {
      appVerNm: await this._getAppVersion(),
      deviceNm: 'Galaxy Z',
      deviceOsVerNm: '14',
      langCd: 'en',
      appDivCd: 'ZM200001',
      deviceId: deviceID,
      osDivCd: 'ZM100002',
    };

    // make a request to register our device
    await this.http('POST', `${this.config.baseURL}/app/mps/GetDevice.do`, deviceData, {
      // make sure we don't try and recursively call this function
      skipCookies: true,
    });

    // set session locale to English
    await this.http('POST', `${this.config.baseURL}/app/mps/RegisterLocale.do`, {
      ...deviceData,
      locale: 'EN', // in capitals here because we're angry now or something
    }, {
      // make sure we don't try and recursively call this function
      skipCookies: true,
    });
  }

  /**
   * Fetch the rides page from the Lotte World website
   * @returns {string} HTML page content
   */
  async _fetchRidesPage() {
    '@cache|1m'; // cache for 1 minute
    const response = await this.http('GET', `${this.config.baseURL}/app/mps/mpsResvPage.do`);
    return response?.body;
  }

  /**
   * Parse rides page into JSON
   */
  async _parseRidesPage() {
    const html = await this._fetchRidesPage();
    const $ = cheerio.load(html);

    const rides = [];

    // find all the ride cards
    $('.roundBox').each((index, element) => {
      const $element = $(element);
      // get attraction id from the a element onclick attribute, eg. fnVwDet('2286');
      const onclick = $element.find('a').attr('onclick');
      if (!onclick) {
        return;
      }
      // extract the attraction ID from the onclick attribute
      const attractionId = onclick.match(/fnVwDet\('(\d+)'\)/)[1];
      if (!attractionId) {
        return;
      }

      // ride name is a -> div.inner -> strong.tit
      const nameEl = $element.find("a div.inner strong.tit");
      if (!nameEl) {
        return;
      }
      const name = nameEl.text();

      const rideObj = {
        _id: attractionId,
        name: name,
        statusTxt: 'OPEN', // default to OPEN
        waitTimeTxt: '',
      };

      // status text
      const statusEl = $element.find("a div.status2 span.state");
      if (statusEl) {
        rideObj.statusTxt = statusEl.text();
      }

      // wait time text
      const waitTimeEl = $element.find("a div.status1 span.state");
      if (waitTimeEl) {
        rideObj.waitTimeTxt = waitTimeEl.text();
      }

      rides.push(rideObj);
    });

    return rides;
  }

  /**
   * Try to parse a wait time from a string
   * @param {string} inStr 
   */
  _tryParseWaitTimeFromString(inStr) {
    if (!inStr || inStr == '') {
      return null;
    }

    // different possible wait time strings
    //  Within 30 minutes
    //  30 to 60 minutes
    //  More than 90 minutes
    // test each option
    const withinRegex = /Within (\d+) minutes/;
    const toRegex = /(\d+) to (\d+) minutes/;
    const moreThanRegex = /More than (\d+) minutes/;

    let waitTime = null;
    let matches = inStr.match(withinRegex);
    if (matches) {
      waitTime = parseInt(matches[1]);
    } else {
      matches = inStr.match(toRegex);
      if (matches) {
        waitTime = parseInt(matches[2]);
      } else {
        matches = inStr.match(moreThanRegex);
        if (matches) {
          waitTime = parseInt(matches[1]);
        }
      }
    }

    return waitTime;
  }

  /**
   * Helper function to build a basic entity document
   * Useful to avoid copy/pasting
   * @param {object} data 
   * @returns {object}
   */
  buildBaseEntityObject(data) {
    const entity = Destination.prototype.buildBaseEntityObject.call(this, data);
    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    const doc = {};
    return {
      ...this.buildBaseEntityObject(doc),
      _id: 'lotteworld',
      slug: 'lotteworld',
      name: this.config.name,
      entityType: entityType.destination,
      location: {
        latitude: 37.511360,
        longitude: 127.099768,
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
        _id: 'lotteworldpark',
        _destinationId: 'lotteworld',
        _parentId: 'lotteworld',
        name: this.config.name,
        entityType: entityType.park,
        location: {
          latitude: 37.511360,
          longitude: 127.099768,
        },
      }
    ];
  }

  /**
   * Fetch the attraction page for a specific attraction
   * @param {string} attractionId 
   * @returns 
   */
  async _fetchAttractionPage(attractionId) {
    // TODO - any useful data on this page?
    const response = await this.http('GET', `${this.config.baseURL}/app/mps/mpsResvDetView.do?shopSysCd=${attractionId}`);
    return response?.body;
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const rideData = await this._parseRidesPage();

    return rideData.map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        _id: x._id,
        _destinationId: 'lotteworld',
        _parentId: 'lotteworldpark',
        _parkId: 'lotteworldpark',
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
        name: x.name,
        // all locations get the same location for now
        //  we should/will override this in the API database if there is demand for it
        // the app doesn't provide location data for attractions
        //  instead, we get a coordinate of the location on a "play map" that doesn't have any real-world coordinates
        location: {
          latitude: 37.511360,
          longitude: 127.099768,
        },
      };
    });
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    return [];
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
    const rideData = await this._parseRidesPage();

    return rideData.map((x) => {
      if (!x._id) {
        return null;
      }

      const liveDataObj = {
        _id: x._id,
        status: x.statusTxt == 'OPEN' ? statusType.operating : statusType.closed,
      };

      const time = this._tryParseWaitTimeFromString(x.waitTimeTxt);
      if (time != null) {
        liveDataObj.queue = {
          [queueType.standBy]: {
            waitTime: time,
          }
        };
      }

      return liveDataObj;
    }).filter((x) => !!x);
  }

  /**
   * Fetch schedule data for a specific date.
   * Date must be a string in format YYYYMMDD
   * @param {string} date Date in string format YYYYMMDD
   */
  async _fetchSchedulePageForDate(date) {
    '@cache|1d'; // cache for 1 day
    const response = await this.http('GET', `https://adventure.lotteworld.com/eng/usage-guide/service/index.do?oprtDt=${date}`);
    return response.body;
  }

  /**
   * Get schedule data for a specific date
   * @param {string} date Date in format YYYYMMDD
   * @returns 
   */
  async getScheduleForDate(date) {
    const body = await this._fetchSchedulePageForDate(date);
    const $ = cheerio.load(body);

    const timeController = $('div.timeVisArea');

    let time0 = timeController.attr('data-strt-si');
    const time1 = timeController.attr('data-strt-mi');
    let time2 = timeController.attr('data-end-si');
    const time3 = timeController.attr('data-end-mi');

    if (!time0 || !time1 || !time2 || !time3) {
      return null;
    }

    if (time0 == '00')

    if (time0.length == 1) {
      time0 = `0${time0}`;
    }
    if (time2.length == 1) {
      time2 = `0${time2}`;
    }

    // parse the times into integers and convert to datetimes
    //  opening time is time0:time1
    //  closing time is time2:time3
    const openingTimeStr = `${date}T${time0}:${time1}`;
    const closingTimeStr = `${date}T${time2}:${time3}`;

    // build moment objects
    const openingTime = moment.tz(openingTimeStr, 'YYYYMMDDTHHmm', this.config.timezone);
    const closingTime = moment.tz(closingTimeStr, 'YYYYMMDDTHHmm', this.config.timezone);

    return {
      date: openingTime.format('YYYY-MM-DD'),
      openingTime: openingTime.format(),
      closingTime: closingTime.format(),
      type: scheduleType.operating,
    };
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const scheduleData = [];

    const now = this.getTimeNowMoment();
    const endDate = now.clone().add(40, 'days');

    for (const date = now.clone(); date.isBefore(endDate); date.add(1, 'day')) {
      const schedule = await this.getScheduleForDate(date.format('YYYYMMDD'));
      if (schedule) {
        scheduleData.push(schedule);
      }
    }

    return [
      {
        _id: 'lotteworldpark',
        schedule: scheduleData,
      }
    ];
  }
}
