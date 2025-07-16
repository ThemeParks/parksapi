import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import {URL} from 'url';
import moment from 'moment-timezone';

class PlopsaBase extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Europe/Brussels';

    options.clientId = options.clientId || '';
    options.clientSecret = options.clientSecret || '';
    options.baseURL = options.baseURL || '';
    options.baseLang = options.baseLang || '';
    options.destinationSlug = options.destinationSlug || '';
    options.parkSlug = options.parkSlug || '';
    options.parkLatitude = options.parkLatitude || '';
    options.parkLongitude = options.parkLongitude || '';
    options.configPrefixes = ['PLOPSA'];

    super(options);

    if (!this.config.clientId) throw new Error('Missing clientId');
    if (!this.config.clientSecret) throw new Error('Missing clientSecret');
    if (!this.config.baseURL) throw new Error('Missing baseURL');
    if (!this.config.destinationSlug) throw new Error('Missing destinationSlug');
    if (!this.config.parkSlug) throw new Error('Missing parkSlug');

    const baseURLHostname = new URL(this.config.baseURL).hostname;
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      // all our requests are JSON based
      options.json = true;

      // don't inject into the auth request
      if (options?.authRequest) {
        return;
      }

      const authToken = await this.getAuthToken();
      if (!authToken) {
        throw new Error('Could not get auth token');
      }

      // add access token to the request
      const urlObj = new URL(url);
      if (!urlObj.searchParams.has('access_token')) {
        urlObj.searchParams.set('access_token', authToken);
      }

      return {
        url: urlObj.toString(),
      }
    });
  }

  /**
   * Get the auth token for our API
   */
  async getAuthToken() {
    const cacheKey = `${this.config.destinationSlug}-auth-token`;

    const authToken = await this.cache.get(cacheKey);
    if (authToken) {
      return authToken;
    }

    const resp = await this.http('POST', `${this.config.baseURL}${this.config.baseLang}/api/v1.0/token/000`, {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    }, {
      authRequest: true,
      json: true,
    });

    if (!resp.body.accessToken) {
      throw new Error('Could not get auth token');
    }

    // expire 1 minute before the token expires
    const ttl = resp.body.expiresOn - Math.floor(+new Date() / 1000) - 60;
    await this.cache.set(cacheKey, resp.body.accessToken, ttl * 1000);

    console.log('Got auth token', resp.body.accessToken);

    return resp.body.accessToken;
  }

  /**
   * Get raw wait time data
   */
  async getWaitData() {
    '@cache|1'; // cache for 1 minute
    const resp = await this.http('GET', `${this.config.baseURL}${this.config.baseLang}/api/v1.0/waitingTime/${this.config.destinationSlug}/attraction`);
    return resp.body;
  }

  /**
   * Get raw attraction POI data
   */
  async getAttractionData() {
    '@cache|720'; // cache for 12 hours
    const resp = await this.http('GET', `${this.config.baseURL}${this.config.baseLang}/api/v1.0/details/all/${this.config.destinationSlug}/attraction`);
    return resp.body;
  }

  /**
   * Get raw dining POI data
   */
  async getDiningData() {
    '@cache|720'; // cache for 12 hours
    const resp = await this.http('GET', `${this.config.baseURL}${this.config.baseLang}/api/v1.0/details/all/${this.config.destinationSlug}/page`);
    return resp.body;
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
      if (data.id) {
        entity._id = `${data.id}`;
      }

      if (data.name) {
        entity.name = data.name;
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
      _id: this.config.destinationSlug,
      slug: this.config.destinationSlug, // all destinations must have a unique slug
      name: this.config.name,
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
        _id: this.config.parkSlug,
        _destinationId: this.config.destinationSlug,
        _parentId: this.config.destinationSlug,
        slug: this.config.parkSlug,
        name: this.config.name,
        entityType: entityType.park,
        location: {
          longitude: this.config.parkLongitude,
          latitude: this.config.parkLatitude,
        }
      }
    ];
  }

  /**
   * Merge data from multiple locales into a single object
   * Priorities languages in order
   */
  mergeLocaleData(obj, key, compFn = null) {
    const langs = [this.config.baseLang, 'en'];

    if (!compFn) {
      compFn = (baseObj, baseKey, existingResults) => {
        return (x, key) => {
          return baseObj.uniqueID === x.uniqueID;
        };
      };
    }

    const result = [];
    for (const lang of langs) {
      const data = obj[lang] ? obj[lang][key] : null;
      if (data) {
        const keys = Object.keys(data);
        for (const key of keys) {
          const ent = data[key];
          const comp = compFn(ent, key, result);
          const existingResult = result.find((entry) => {
            return comp(entry, entry.key);
          });
          if (!existingResult) {
            result.push({
              ...ent,
              key: key,
            });
          } else if (lang === 'en') {
            // take name from 'en' where possible
            if (ent.name) {
              existingResult.name = ent.name;
            }
          }
        }
      }
    }

    return result;
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const attractions = await this.getAttractionData();
    const data = this.mergeLocaleData(attractions, 'attraction');

    return data.map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
        _destinationId: this.config.destinationSlug,
        _parentId: this.config.parkSlug,
        _parkId: this.config.parkSlug,
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
    const restaurants = await this.getDiningData();
    const data = this.mergeLocaleData(restaurants, 'food');

    return data.map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        entityType: entityType.restaurant,
        _destinationId: this.config.destinationSlug,
        _parentId: this.config.parkSlug,
        _parkId: this.config.parkSlug,
      };
    });
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const liveData = await this.getWaitData();

    if (!liveData || !liveData[this.config.baseLang]) return [];

    // console.log(liveData);
    return liveData[this.config.baseLang].map((x) => {
      const data = {
        _id: x.id,
        status: statusType.closed,
      };

      if (x.showWaitingTime) {
        data.status = statusType.operating;
        const waitTime = parseInt(x.currentWaitingTime, 10);
        if (!isNaN(waitTime)) {
          data.queue = {
            [queueType.standBy]: {
              waitTime: waitTime,
            },
          };
        }
      }

      return data;
    }).filter((x) => !!x);
  }

  /**
   * Fetch raw calendar data
   */
  async fetchCalendarData() {
    // cache 12 hours
    '@cache|720';
    const resp = await this.http('GET', `${this.config.baseURL}${this.config.baseLang}/api/v1.0/calendar/${this.config.destinationSlug}`);
    return resp.body;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const scheduleData = await this.fetchCalendarData();

    const data = this.mergeLocaleData(scheduleData, 'months', (baseObj, baseKey) => {
      return (x) => {
        return x.key === baseKey;
      };
    }).reduce((arr, x) => {
      arr.push(...Object.keys(x.openOn).map((key) => {
        return {
          ...x.openOn[key],
          date: key,
        };
      }));
      return arr;
    }, []);

    const hourRegex = /([0-9]{1,2})[:\.]([0-9]{2}) - ([0-9]{1,2})[:\.]([0-9]{2})/;

    return [
      {
        _id: this.config.parkSlug,
        schedule: data.map((x) => {
          if (!x) return null;

          const match = hourRegex.exec(x.label);
          if (!match) return null;

          const date = x.date.substring(0, 10);
          const dateObj = moment.tz(date, 'YYYY-MM-DD', this.config.timezone);

          const openHours = dateObj.clone().hours(Number(match[1])).minutes(Number(match[2]));
          const closeHours = dateObj.clone().hours(Number(match[3])).minutes(Number(match[4]));

          return {
            date,
            type: 'OPERATING',
            openingTime: openHours.format(),
            closingTime: closeHours.format(),
          };
        }).filter((x) => !!x),
      }
    ];
  }
}

export class Plopsaland extends PlopsaBase {
  constructor(config = {}) {
    config.destinationSlug = 'plopsaland-de-panne';
    config.parkSlug = 'plopsaland';
    config.baseURL = 'https://www.old.plopsa.com/';
    config.baseLang = 'nl';
    config.name = 'Plopsaland De Panne';
    config.parkLatitude = 51.0808363;
    config.parkLongitude= 2.5957221;

    super(config);
  }
}

// Import and re-export the PlopsalandDeutschland class
export { PlopsalandDeutschland } from './plopsadeutschland.js';
