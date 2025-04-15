import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';

import {v4 as uuidv4} from 'uuid';

export class Futuroscope extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Europe/Paris';

    options.baseURL = options.baseURL || '';

    super(options);

    if (!this.config.baseURL) throw new Error('Missing baseURL');


    // inject into API calls
    const baseURLHostname = new URL(this.config.baseURL).hostname;
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      // if we're not the auth request, add our token
      if (!options._authRequest) {
        const token = await this._getAPIToken();

        if (!options.headers) {
          options.headers = {};
        }
        options.headers['token'] = token;
      }
    });
  }

  /**
   * Get or fetch our API token
   * @returns {string}
   */
  async _getAPIToken() {
    '@cache|30d';

    // generate a random 13 character token made up of 0-9a-f
    //  this is used to create a session
    const randomToken = Math.random().toString(16).slice(2, 15);
    const randomUUID = uuidv4();
    const url = `${this.config.baseURL}/api/sessions/create/${randomToken}`;

    const resp = await this.http('POST', url, {
      session: {
        language: "en",
        device_name: "web",
        device_version: "REL",
        os_name: "Android",
        app_version: "3.7.17",
        uid: randomUUID,
        push_token: "none",
      },
    }, {
      json: true,
      _authRequest: true,
    });

    return resp.body.token;
  }

  /**
   * Get the raw POI data from the API
   * @returns {object}
   */
  async getPOIData() {
    '@cache|12h';

    const url = `${this.config.baseURL}/api/poi`;
    const resp = await this.http('GET', url, null, {
      json: true,
    });
    return resp.body;
  }

  /**
   * Get latest realtime data
   * @returns {object}
   */
  async fetchLiveData() {
    '@cache|1m'; // cache for 1 minute
    const url = `${this.config.baseURL}/api/poi/get-realtime-datas`;
    const resp = await this.http('GET', url, null, {
      json: true,
    });
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

    if (data && data.id && data.title) {
      entity._id = data.id;

      if (data.title) {
        entity.name = data.title;
      }

      if (data.latitude && data.longitude) {
        entity.location = {
          latitude: data.latitude,
          longitude: data.longitude,
        };
      }

      entity._parkId = 'futuroscope';
      entity._destinationId = 'futuroscopedestination';
      entity._parentId = 'futuroscope';
    }

    entity.timezone = this.config.timezone;

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    const doc = {};
    return {
      ...this.buildBaseEntityObject(doc),
      _id: 'futuroscopedestination',
      slug: 'futuroscope', // all destinations must have a unique slug
      name: "Futuroscope",
      entityType: entityType.destination,
      location: {
        latitude: 46.667013,
        longitude: 0.367956,
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
        _id: 'futuroscope',
        _destinationId: 'futuroscopedestination',
        _parentId: 'futuroscopedestination',
        name: "Futuroscope",
        entityType: entityType.park,
        location: {
          latitude: 46.667013,
          longitude: 0.367956,
        },
      }
    ];
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const poiData = await this.getPOIData();

    const attractions = poiData.poi.filter((poi) => {
      return poi.type === 'attraction' && poi.theme != 'Shows';
    });
    const entities = attractions.map((attraction) => {
      return {
        ...this.buildBaseEntityObject(attraction),
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
      };
    });
    return entities.filter((attraction) => {
      return attraction._id && attraction.name;
    });
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    const poiData = await this.getPOIData();

    const shows = poiData.poi.filter((poi) => {
      return poi.type === 'attraction' && poi.theme == 'Shows';
    });
    const entities = shows.map((show) => {
      return {
        ...this.buildBaseEntityObject(show),
        entityType: entityType.show,
      };
    });
    return entities.filter((show) => {
      return show._id && show.name;
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
    // this function should return all the live data for all entities in this destination
    return [
      {
        // use the same _id as our entity objects use
        _id: 'internalId',
        status: statusType.operating,
        queue: {
          [queueType.standBy]: {
            waitTime: 10,
          }
        },
      },
    ];
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    return [
      {
        _id: 'internalId',
        schedule: [
          {
            "date": "2021-05-31",
            "type": "OPERATING",
            "closingTime": "2021-05-31T19:30:00+08:00",
            "openingTime": "2021-05-31T10:30:00+08:00",
          },
        ],
      }
    ];
  }
}
