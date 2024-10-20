import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import moment from 'moment-timezone';
//import URL from 'url';

export class PaultonsPark extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Europe/London';
    options.name = options.name || 'Paultons Park';

    options.apiKey = options.apiKey || '';
    options.apiBaseURL = options.apiBaseURL || '';
    options.bearerToken = options.bearerToken || '';

    super(options);

    if (!this.config.apiKey) throw new Error('Missing apiKey');
    if (!this.config.apiBaseURL) throw new Error('Missing apiBaseURL');
    if (!this.config.bearerToken) throw new Error('Missing bearerToken');

    // inject into API requests
    const baseURLHostname = new URL(this.config.apiBaseURL).hostname;
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      options.headers = options.headers || {};

      // add in our APP ID headers
      options.headers['x-requested-with'] = 'thrillseeker.app.paultons';
      options.headers['accept-language'] = 'en-GB,en-US;q=0.9,en;q=0.8';
      options.headers['origin'] = 'http://localhost';
      options.headers['referer'] = 'http://localhost/';
      options.headers['is-mobile'] = 'true';

      const urlObj = new URL(url);

      // check path of URL, if it starts with "/api" then we need to add our API key
      if (urlObj.pathname.startsWith('/api')) {
        // if URL starts with /api, we add our x-token
        options.headers['x-token'] = this.config.apiKey;
      } else if (!urlObj.pathname.startsWith('/assets')) {
        // otherwise, use our bearer token (unless we're requesting assets)
        // eg. /items/
        options.headers['authorization'] = `Bearer ${this.config.bearerToken}`;
      }
    });

    this.http.injectForDomainResponse({
      hostname: baseURLHostname,
    }, async (resp) => {
      // check for resp.body.data.force_update
      if (resp.body?.data?.force_update) {
        throw new Error('Paultons Park API is forcing an app update. Please update the parksapi codebase.');
      }

      return resp;
    });
  }

  async fetchPOIData() {
    '@cache|1440'; // cache for 24 hours
    const url = `${this.config.apiBaseURL}/items/points_of_interest`;
    // add qs
    const qs = {
      fields: [
        '*',
        'category_tags.category_tags_id.id',
        'images.directus_files_id.*',
        'timed_pois_list.timed_pois_list_id.id',
        'user_interest_tags.user_interest_tags_id.id',
        'filter_tags.filter_tags_id.id',
        'icon.*',
        'show.id',
      ],
      limit: 1000,
    };
    const resp = await this.http('GET', url, qs);
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

    if (!data) return entity;

    // location data
    if (data.entrance_location && data.entrance_location.type == 'Point') {
      entity.location = {
        latitude: data.entrance_location.coordinates[1],
        longitude: data.entrance_location.coordinates[0],
      };
    } else if (data.location && data.location.type == 'Point') {
      entity.location = {
        latitude: data.location.coordinates[1],
        longitude: data.location.coordinates[0],
      };
    }

    entity.name = data.title;

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    // get our destination entity data and return its object
    const doc = {};
    return {
      ...this.buildBaseEntityObject(doc),
      _id: 'paultonsparkresort',
      slug: 'paultonspark',
      name: "Paultons Park",
      location: {
        latitude: 50.948063,
        longitude: -1.552221
      },
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
        _id: 'paultonspark',
        _destinationId: 'paultonsparkresort',
        _parentId: 'paultonsparkresort',
        name: "Paultons Park",
        entityType: entityType.park,
        location: {
          latitude: 50.94821775877611,
          longitude: -1.5523016452789309,
        },
      }
    ];
  }

  async _getEntitiesOfTypes(types, extraData = {}) {
    const poi = await this.fetchPOIData();

    const ents = poi.data.filter((x) => types.includes(x.type));

    return ents.map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        _id: `${x.id}`, // force to string
        _destinationId: 'paultonsparkresort',
        _parentId: 'paultonspark',
        ...extraData,
      };
    });
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    // filter by type "ride"
    return this._getEntitiesOfTypes(['ride'], {
      entityType: entityType.attraction,
      attractionType: attractionType.ride,
    });
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    return this._getEntitiesOfTypes(['show'], {
      entityType: entityType.show,
    });
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    return this._getEntitiesOfTypes(['restaurant'], {
      entityType: entityType.restaurant,
    });
  }

  async fetchLiveData() {
    '@cache|1'; // cache for 1 minute
    const resp = await this.http('GET', `${this.config.apiBaseURL}/api/queue-times`);
    return resp.body;
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const liveData = await this.fetchLiveData();

    // this function should return all the live data for all entities in this destination
    return liveData.map((x) => {
      const liveObj = {
        // TODO - I think these are based on "orms_id" in the API data
        _id: `${x.rideId}`,
      };

      liveObj.status = !!x.statusOpen ? statusType.operating : statusType.closed;

      // TODO - opening times

      // TODO - queue time
      if (x.queueTime) {
        liveObj.queue = {
          [queueType.standBy]: {
            waitTime: x.queueTime,
          }
        };
      }

      // optionally add opening hours
      if (x.updatedAt && x.closingTime && x.openingTime) {
        // use the updatedAt time as the date, as this is the most recent time the ride was updated and will match the current opening hours
        const date = x.updatedAt.substring(0, 10);

        const openingTimeStr = `${date}T${x.openingTime}`;
        const closingTimeStr = `${date}T${x.closingTime}`;

        liveObj.operatingHours = [
          {
            type: scheduleType.operating,
            startTime: moment(openingTimeStr).tz(this.config.timezone).format(),
            endTime: moment(closingTimeStr).tz(this.config.timezone).format(),
          },
        ];
      }

      return liveObj;
    });
  }

  /**
   * Fetch current opening hours from today onwards
   * @returns {object}
   */
  async _fetchOpeningHours() {
    '@cache|1440'; // cache for 24 hours
    const date = this.getTimeNowMoment().format('YYYY-MM-DD');
    const resp = await this.http('GET', `${this.config.apiBaseURL}/api/opening-hours?&currentMonthInView=${date}T23:00:00.000Z`);
    return resp.body;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const openingHours = await this._fetchOpeningHours();

    if (!openingHours?.open?.park) return [];

    return [
      {
        _id: 'paultonspark',
        schedule: openingHours.open.park.map((x) => {
          const openTime = moment(x.start).tz(this.config.timezone);
          const closeTime = moment(x.end).tz(this.config.timezone);

          return {
            date: openTime.format('YYYY-MM-DD'),
            type: scheduleType.operating,
            openingTime: openTime.format(),
            closingTime: closeTime.format(),
          };
        }),
      }
    ];
  }
}
