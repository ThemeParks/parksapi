import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import moment from 'moment-timezone';

export class PortAventuraWorld extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Europe/Madrid';

    // accept overriding the API base URL
    options.apiBase = options.apiBase || false;

    options.guestUsername = 'guest';
    options.guestPassword = options.guestPassword || "";

    options.waitTimeURL = options.waitTimeURL || "";

    super(options);

    if (!this.config.apiBase) throw new Error('Missing apiBase');
    if (!this.config.guestUsername) throw new Error('Missing guestUsername');
    if (!this.config.guestPassword) throw new Error('Missing guestPassword');
    if (!this.config.waitTimeURL) throw new Error('Missing waitTimeURL');

    this.destinationId = 'portaventuraworld';

    const baseURLHostname = new URL(this.config.apiBase).hostname;
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      // API always wants JSON
      options.json = true;

      if (!options.headers) options.headers = {};
      options.headers['User-Agent'] = 'okhttp/4.9.2';

      options.headers['X-App-Environment'] = 'production';
      options.headers['X-App-Platform'] = 'android';

      const appVersion = await this.getAndroidAPPVersion("portaventura.android", "4.17.0");
      options.headers['X-App-Version'] = appVersion;
    });

    const waitTimeHostname = new URL(this.config.waitTimeURL).hostname;
    this.http.injectForDomain({
      hostname: waitTimeHostname,
    }, async (method, url, data, options) => {
      // parse response as JSON
      options.json = true;

      // always use okhttp user agent
      if (!options.headers) options.headers = {};
      options.headers['User-Agent'] = 'okhttp/4.9.2';
    });
  }

  /**
   * Return core app config
   */
  async getAppConfig() {
    '@cache|1440'; // cache for 24 hours

    const resp = await this.http('GET', `${this.config.apiBase}ws/getUrlConfiguration/en`);

    return resp?.body;
  }

  /**
   * Map base URL
   * @returns {String}
   */
  async getMapURLBase() {
    const appConfig = await this.getAppConfig();
    return appConfig.find((x) => x.title === 'mapa')?.url;
  }

  async getParkData() {
    '@cache|1440'; // cache for 24 hours

    // get list of the parks in this destination
    const resp = await this.http('GET', `${this.config.apiBase}/api/parks?locale=en&populate[fields][0]=*&populate[sort][0]=name:asc&populate[park][fields][0]=name&populate[area][fields][0]=name&populate[images][fields][0]=formats&populate[logo][fields][0]=formats&populate[logo][fields][1]=url&populate[similar][fields][0]=id&populate[urls][fields][0]=*&populate[tags][fields][0]=name&populate[tags][fields][1]=customSlug&populate[tags][populate][filters][fields][0]=customSlug&pagination[start]=0&pagination[limit]=10000`);

    return resp?.body;
  }

  /**
   * Return the attraction POI data
   */
  async getAttractionData() {
    '@cache|1440'; // cache for 24 hours

    const resp = await this.http('GET', `${this.config.apiBase}/api/attractions?locale=en&populate[fields][0]=*&populate[sort][0]=name:asc&populate[park][fields][0]=name&populate[area][fields][0]=name&populate[images][fields][0]=formats&populate[logo][fields][0]=formats&populate[logo][fields][1]=url&populate[similar][fields][0]=id&populate[urls][fields][0]=*&populate[tags][fields][0]=name&populate[tags][fields][1]=customSlug&populate[tags][populate][filters][fields][0]=customSlug&pagination[start]=0&pagination[limit]=10000`);

    return resp?.body;
  }

  /**
   * Helper function to build a basic entity document
   * Useful to avoid copy/pasting
   * @param {object} data 
   * @returns {object}
   */
  buildBaseEntityObject(data) {
    const entity = Destination.prototype.buildBaseEntityObject.call(this, data);

    if (data?.id) {
      entity._id = `${data.id}`;
    }

    if (data?.attributes) {
      if (data.attributes.name) {
        entity.name = data.attributes.name;
      }

      if (data.attributes.latitude && data.attributes.longitude) {
        entity.location = {
          longitude: Number(data.attributes.longitude),
          latitude: Number(data.attributes.latitude),
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
      _id: this.destinationId,
      slug: this.destinationId,
      name: 'PortAventura World',
      entityType: entityType.destination,
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    const parks = await this.getParkData();
    return parks.data.map((x) => {
      return {
        ...this.buildBaseEntityObject(null),
        _id: `park_${x.id}`,
        _destinationId: this.destinationId,
        _parentId: this.destinationId,
        name: x.attributes.name,
        entityType: entityType.park,
        location: {
          latitude: 41.0986786,
          longitude: 1.151773
        }
      };
    });
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const parkData = await this.getParkData();
    const data = await this.getAttractionData();

    const parks = parkData.data.map((x) => {
      return {
        id: x.id,
        _id: `${x.id}`,
      };
    });

    return data.data.filter((ent) => {
      // TODO - filter out non-attractions
      return true;
    }).map((ent) => {
      if (!ent?.attributes?.park?.data?.id) return null;

      const entParkId = ent?.attributes?.park?.data?.id;
      const parkObj = parks.find((x) => x.id === entParkId);
      if (!parkObj) return null;

      return {
        ...this.buildBaseEntityObject(ent),
        _parentId: `park_${parkObj._id}`,
        _destinationId: this.destinationId,
        _parkId: `park_${parkObj._id}`,
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
      };
    }).filter((x) => !!x);
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

  async _fetchWaitTimes() {
    '@cache|5'; // cache for 5 minutes
    const resp = await this.http('GET', this.config.waitTimeURL);
    return resp?.body;
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const liveData = await this._fetchWaitTimes();
    const attractions = await this.getAttractionData();

    const returnData = [];

    const liveDataGrouped = liveData.reduce((acc, curr) => {
      if (!acc[curr.id]) acc[curr.id] = [];
      acc[curr.id].push(curr);
      return acc;
    }, {});

    Object.keys(liveDataGrouped).map((entry) => {
      // pick best (any non-null time) or just the first entry
      const nonNullEntries = liveDataGrouped[entry].filter((x) => x.queue !== null);
      if (nonNullEntries.length > 0) {
        return nonNullEntries[0];
      }
      return liveDataGrouped[entry][0];
    }).forEach((attraction) => {
      if (!attraction?.id) return;

      // find attraction
      const attractionData = attractions.data.find((x) => x?.attributes?.FTPName === attraction.id);
      if (!attractionData) return;

      const rideData = {
        _id: `${attractionData.id}`,
        // default to status: operating
        status: statusType.operating,
      };

      if (attraction.queue === null || attraction.queue === undefined || attraction.closed) {
        rideData.status = statusType.closed;
      }

      if (attraction.queue !== undefined && !attraction.closed) {
        rideData.queue = {
          [queueType.standBy]: {
            waitTime: attraction.queue,
          },
        };
      }

      returnData.push(rideData);
    });

    return returnData;
  }

  /**
   * Fetch calendar data
   * @returns {object}
   */
  async _fetchSchedule() {
    '@cache|1440'; // cache for 24 hours

    // get current date in local timezone
    const date = this.getTimeNowMoment().tz(this.config.timezone).format('YYYY-MM-DD');

    const resp = await this.http('GET', `${this.config.apiBase}/api/schedule-parks?filters[date][$gte]=${date}&populate[fields][0]=*&populate[sort][0]=date:desc&populate[park][fields][0]=name&pagination[start]=0&pagination[limit]=10000`);
    return resp?.body;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const dateData = await this._fetchSchedule();
    const parkData = await this.getParkData();

    return parkData.data.map((park) => {
      return {
        _id: `park_${park.id}`,
        schedule: dateData.data.filter((entry) => {
          // filter out entries that don't match this park
          return entry?.attributes?.park?.data?.id === park.id;
        }).map((x) => {
          if (!x?.attributes?.openingTime || !x?.attributes?.closingTime) return null;
          if (x?.attributes?.openingTime == "00:00:00" || x?.attributes?.closingTime == "00:00:00") return null;
          // if opening time equals closing time, assume closed
          if (x?.attributes?.openingTime === x?.attributes?.closingTime) return null;

          const openTime = moment(`${x.attributes.date}T${x.attributes.openingTime}`, 'YYYY-MM-DDTHH:mm:ss').tz(this.config.timezone, true);
          const closeTime = moment(`${x.attributes.date}T${x.attributes.closingTime}`, 'YYYY-MM-DDTHH:mm:ss').tz(this.config.timezone, true);

          return {
            date: x.attributes.date,
            type: "OPERATING",
            openingTime: openTime.format(),
            closingTime: closeTime.format(),
          };
        }).filter((x) => !!x),
      };
    });
  }
}
