import {Park} from '../park.js';
import {attractionType, statusType, queueType, tagType, scheduleType} from '../parkTypes.js';
import moment from 'moment-timezone';
import randomUseragent from 'random-useragent';

/**
 * TokyoDisneyResortPark Object
 */
export class TokyoDisneyResortPark extends Park {
  /**
   * Create a new TokyoDisneyResortPark object
   * @param {object} options
   */
  constructor(options = {}) {
    options.name = options.name || 'Tokyo Disney Resort Park';
    options.timezone = options.timezone || 'Asia/Tokyo';

    options.apiKey = options.apiKey || '';
    options.apiAuth = options.apiAuth || '';
    options.apiOS = options.apiOS || '';
    options.apiBase = options.apiBase || '';
    options.apiVersion = options.apiVersion || '';
    options.parkId = options.parkId || '';

    // any custom environment variable prefixes we want to use for this park (optional)
    options.configPrefixes = ['TDR'].concat(options.configPrefixes || []);

    super(options);

    if (!this.config.apiKey) throw new Error('Missing TDR apiKey');
    if (!this.config.apiAuth) throw new Error('Missing TDR apiAuth');
    if (!this.config.apiOS) throw new Error('Missing TDR apiOS');
    if (!this.config.apiBase) throw new Error('Missing TDR apiBase');
    if (!this.config.apiVersion) throw new Error('Missing TDR apiVersion');
    if (!this.config.parkId) throw new Error('Missing TDR parkId');

    // some convenience strings
    this.config.parkIdLower = this.config.parkId.toLowerCase();
    this.config.parkIdUpper = this.config.parkId.toUpperCase();

    this.injectForDomain({
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
        options.headers['X-PORTAL-DEVICE-ID'] = deviceID;
        options.headers['X-PORTAL-AUTH'] = this.config.apiAuth;
      }
    });

    this.http.injectForDomainResponse({
      hostname: new URL(this.config.apiBase).hostname,
    }, async (resp) => {
      if (resp.statusCode === 400) {
        console.log('TDR version invalid, fetch again...');
        // force a store version update if we get a 400 error
        await this.cache.setGlobal('tdr_appversion', undefined, -1);
        return undefined;
      }

      return resp;
    });
  }

  /**
   * Fetch the current app version on the Google Play store
   * @return {string}
   */
  async fetchLatestVersion() {
    let cacheTime = 1000 * 60 * 60 * 12; // 12 hours by-default
    return await this.cache.wrapGlobal('tdr_appversion', async () => {
      const ua = randomUseragent.getRandom((ua) => {
        return (ua.osName === 'Windows');
      });
      const resp = await this.http('GET',
          'https://play.google.com/store/apps/details',
          {
            id: 'jp.tokyodisneyresort.portalapp',
            hl: 'en',
          },
          {
            headers: {
              'User-Agent': ua,
            },
          },
      );

      const regexVersionNumber = /Current Version.*(\d+\.\d+\.\d+)<\/span>/;
      const match = regexVersionNumber.exec(resp.body);
      if (match && match[1]) {
        // update API version
        return match[1];
      }

      // if we didn't match, reduce the cache time so we can try again
      cacheTime = 1000 * 60 * 30; // 30 minutes
      return this.config.apiVersion;
    }, () => {
      return cacheTime;
    });
  }

  /**
   * Return or fetch a device ID to use for API calls
   */
  async fetchDeviceID() {
    return await this.cache.wrapGlobal('tdr_device_id', async () => {
      const resp = await this.http(
          'POST',
          `${this.config.apiBase}/rest/v1/devices`,
          undefined,
          {
            ignoreDeviceID: true,
          },
      );

      return resp.body.deviceId;
    }, 1000 * 60 * 60 * 24 * 10); // use for 10 days
  }

  /**
   * Get the latest facilities data for the entire resort
   */
  async fetchAllFacilitiesData() {
    return await this.cache.wrapGlobal('tdr_facilities', async () => {
      const headers = {};
      const lastModifiedTime = await this.cache.getGlobal('tdr_facilities_last_modified');
      if (lastModifiedTime !== undefined) {
        headers['If-Modified-Since'] = lastModifiedTime;
      }

      const resp = await this.http('GET', `${this.config.apiBase}/rest/v2/facilities`, undefined, {
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

        await this.cache.setGlobal('tdr_facilities_data', data, Number.MAX_SAFE_INTEGER);
        await this.cache.setGlobal(
            'tdr_facilities_last_modified',
            resp.headers['Last-Modified'],
            Number.MAX_SAFE_INTEGER,
        );
        return data;
      }

      return await this.cache.getGlobal('tdr_facilities_data');
    }, 1000 * 60 * 60 * 2); // check every 2 hours
  }

  /**
   * Get facilities data for this park
   */
  async fetchFacilitiesData() {
    return await this.cache.wrap('facilities', async () => {
      const resortData = await this.fetchAllFacilitiesData();
      return resortData.filter((x) => x.parkType === this.config.parkIdUpper);
    }, 1000 * 60 * 15); // cache each park's facility data for 15 minutes, to avoid filtering too often
  }

  /**
   * @inheritdoc
   */
  async _init() {
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
        `${this.config.apiBase}/rest/v2/facilities/conditions`,
    );

    const attractions = resp.body?.attractions;
    if (!attractions) {
      if (resp.body.errors) {
        const maintenance = resp.body.errors.find((x) => x.code === 'error.systemMaintenance');
        if (maintenance) {
          // down for maintenance!
          const now = this.getTimeNowMoment();
          if (now.isBetween(maintenance.startAt, maintenance.endAt)) {
            const endsIn = now.diff(maintenance.endAt, 'minutes');
            console.log(`Tokyo Disney Resort API in maintenance. Ends in ${Math.abs(endsIn)} minutes`);
          }
        } else {
          this.emit('error', new Error(`Invalid response from TDR ${JSON.stringify(resp.body)}`));
        }
      }
      return;
    }

    await Promise.allSettled(resp.body.attractions.map(async (attr) => {
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
    return await this.cache.wrapGlobal('tdr_calendar', async () => {
      const cal = await this.http(
          'GET',
          `${this.config.apiBase}/rest/v1/parks/calendars`,
      );

      return cal.body;
    }, 1000 * 60 * 60 * 12);
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
}

export default TokyoDisneyResortPark;

/**
 * Tokyo Disneyland
 */
export class TokyoDisneyland extends TokyoDisneyResortPark {
  /**
   * Construct new TokyoDisneyland Object
   * @param {object} options
   */
  constructor(options = {}) {
    options.name = 'Tokyo Disney Resort - Tokyo Disneyland';
    options.parkId = 'tdl';

    super(options);
  }
}

/**
 * Tokyo DisneySea
 */
export class TokyoDisneySea extends TokyoDisneyResortPark {
  /**
   * Construct new TokyoDisneySea Object
   * @param {object} options
   */
  constructor(options = {}) {
    options.name = 'Tokyo Disney Resort - Tokyo DisneySea';
    options.parkId = 'tds';

    super(options);
  }
}
