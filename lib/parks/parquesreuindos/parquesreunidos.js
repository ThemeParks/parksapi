import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import * as cheerio from 'cheerio';
import moment from 'moment-timezone';

// cultures in a rough priority order
//  destinations can override the default culture
//  by setting the preferredCulture property
const cultures = [
  'en',
  'nl',
  'de',
  'fr',
  'es',
  'it',
];

export class ParcsReunidosDestination extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Europe/Brussels';

    // options.apiKey = options.apiKey || '';
    options.appId = options.appId || '';
    options.baseURL = options.baseURL || 'https://api-manager.stay-app.com';
    options.authToken = options.authToken || '';
    options.stayEstablishment = options.stayEstablishment || '';
    options.calendarURL = options.calendarURL || '';

    options.preferredCulture = options.preferredCulture || cultures[0];

    // allow all stayapp destinations to share the same config
    options.configPrefixes = ['STAYAPP'];

    super(options);

    // if (!this.config.apiKey) throw new Error('Missing apiKey');
    if (!this.config.appId) throw new Error('Missing appId');
    if (!this.config.authToken) throw new Error('Missing authToken');
    if (!this.config.stayEstablishment) throw new Error('Missing stayEstablishment');
    if (!this.config.calendarURL) throw new Error('Missing calendarURL');

    const baseURLHostname = new URL(this.config.baseURL).hostname;
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      // inject our auth token into all requests to this domain
      options.headers = options.headers || {};

      const token = await this.getAuthToken();
      if (!token) {
        throw new Error('Error getting API key');
      }

      options.headers['Authorization'] = 'Bearer ' + token;
      options.headers['Stay-Establishment'] = this.config.stayEstablishment;
    });
  }


  /** Get the auth token needed for the API */
  async getAuthToken() {
    return this.config.authToken;
  }

  /** Helper function to get the preferred culture from an object of translated strings */
  _getPreferredCulture(obj, fallback = '') {
    // if obj is string, return it
    if (typeof obj === 'string') {
      return obj;
    }

    if (obj[this.config.preferredCulture]) {
      return obj[this.config.preferredCulture];
    }

    for (const culture of cultures) {
      if (obj[culture]) {
        return obj[culture];
      }
    }

    return fallback;
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
      entity._id = `${data.id}`;

      entity.name = this._getPreferredCulture(data.translatableName, 'unknown_' + entity.id);

      if (data.place && data.place.point) {
        entity.location = {
          latitude: data.place.point.latitude,
          longitude: data.place.point.longitude,
        }
      }
    }

    // fill in entity heirarchy
    entity._destinationId = this._getDestinationID();
    entity._parkId = this._getParkID();
    entity._parentId = this._getParkID();

    entity.timezone = this.config.timezone;

    return entity;
  }

  _getDestinationID() {
    return 'parquesreunidos_' + this.config.appId;
  }

  _getParkID() {
    return 'parquesreunidos_' + this.config.appId + '_park';
  }

  async _getParkLocation() {
    const parkData = await this._fetchParkInfo();

    if (parkData.coordinates && parkData.coordinates.latitude && parkData.coordinates.longitude) {
      return {
        latitude: parkData.coordinates.latitude,
        longitude: parkData.coordinates.longitude,
      };
    }
    return undefined;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    const parkData = await this._fetchParkInfo();

    const destinationObj = {
      _id: this._getDestinationID(),
      // remove any non-alphanumeric characters
      slug: parkData.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(),
      name: parkData.name,
      entityType: entityType.destination,
      timezone: this.config.timezone,
      location: await this._getParkLocation(),
    };

    return destinationObj;
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    const parkData = await this._fetchParkInfo();

    return [
      {
        _id: this._getParkID(),
        _destinationId: this._getDestinationID(),
        _parentId: this._getDestinationID(),
        name: parkData.name,
        entityType: entityType.park,
        timezone: this.config.timezone,
        location: await this._getParkLocation(),
      }
    ];
  }

  async _fetchParkInfo() {
    '@cache|12h'; // cache for 12 hours
    const resp = await this.http('GET', `${this.config.baseURL}/api/v1/establishment/${this.config.appId}`);

    return resp.body.data;
  }

  async _fetchAttractions() {
    '@cache|1m'; // cache for 1 minute
    const resp = await this.http('GET', `${this.config.baseURL}/api/v1/service/attraction`);

    return resp.body.data;
  }

  async _fetchRestaurants() {
    '@cache|12h'; // cache for 12 hours
    const resp = await this.http('GET', `${this.config.baseURL}/api/v1/service/restaurant`);

    return resp.body.data;
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const poiData = await this._fetchAttractions();

    return poiData.filter((x) => {
      // filter out any attractions we don't want
      return true;
    }).map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
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
    const attractionData = await this._fetchAttractions();

    return attractionData.filter((x) => {
      // filter out any attractions we don't want
      return true;
    }).map((x) => {
      if (x.waitingTime === undefined) {
        return null;
      }

      const liveData = {
        _id: `${x.id}`,
        status: statusType.operating,
      };

      if (x.waitingTime < 0) {
        if (x.waitingTime === -2) {
          liveData.status = statusType.down;
        } else if (x.waitingTime === -3) {
          liveData.status = statusType.closed;
        } else {
          // unknown status, assume closed if < 0
          liveData.status = statusType.closed;
        }
      } else {
        liveData.queue = {
          [queueType.standBy]: {
            waitTime: x.waitingTime,
          }
        };
      }

      return liveData;
    }).filter((x) => {
      return !!x;
    });
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async fetchCalendarHTML() {
    '@cache|1d'; // cache for 1 day
    const resp = await this.http('GET', this.config.calendarURL);
    return resp.body;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    // TODO
    return [];
  }
}

export class MovieParkGermany extends ParcsReunidosDestination {
  constructor(options = {}) {
    options.name = options.name || 'Movie Park Germany';
    options.timezone = options.timezone || 'Europe/Berlin';
    options.calendarURL = options.calendarURL || 'https://www.movieparkgermany.de/en/oeffnungszeiten-und-preise/oeffnungszeiten';

    super(options);
  }
}
