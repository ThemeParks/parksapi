import {statusType, queueType, scheduleType, entityType, attractionType} from '../parkTypes.js';
import moment from 'moment-timezone';
import Destination from '../destination.js';

export class SeaworldDestination extends Destination {
  constructor(options = {}) {

    options.resortId = options.resortId || '';
    options.resortSlug = options.resortSlug || '';

    // seaworld resort ID
    options.resortIds = options.resortIds || [];
    // the Android App ID for this resort
    options.appId = options.appId || 'com.seaworld.mobile';

    // base URL for API requests
    options.baseURL = options.baseURL || '';

    options.configPrefixes = ['SEAWORLD'].concat(options.configPrefixes || []);

    super(options);

    if (!this.config.resortIds || this.config.resortIds.length <= 0) throw new Error('Missing resortIds');
    if (!this.config.resortId) throw new Error('Missing resortId');
    if (!this.config.resortSlug) throw new Error('Missing resortSlug');
    if (!this.config.appId) throw new Error('Missing appId');
    if (!this.config.name) throw new Error('Missing name');

    // setup API hooks
    const baseURLHostname = new URL(this.config.baseURL).hostname;
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      // add app version to headers
      const appVersion = await this.getAndroidAPPVersion(this.config.appId);

      if (!options) options = {};

      options.headers = {
        ...options.headers,
        'app_version': appVersion,
      };
    });
  }

  /**
   * Get the raw park data for a given park ID
   * @param parkId {string} the park ID
   * @returns {object} the park data
   */
  async getParkData(parkId) {
    // cache 12 hours
    '@cache|720';

    // get the park data
    return (await this.http(
      'GET',
      `${this.config.baseURL}v1/park/${parkId}`,
    ))?.body;
  }

  /**
   * Get park POI data
   * @param parkId {string} the park ID
   * @returns {object} the park POI data
   */
  async getParkPOI(parkId) {
    // cache 12 hours
    '@cache|720';

    const parkData = await this.getParkData(parkId);
    return parkData?.POIs;
  }

  /**
   * Helper function to build a basic entity document
   * Useful to avoid copy/pasting
   * @param {object} data 
   * @returns {object}
   */
  buildBaseEntityObject(data) {
    const entity = Destination.prototype.buildBaseEntityObject.call(this, data);

    entity._id = data?.Id;

    entity.name = data?.park_Name || data?.Name || undefined;
    if (data?.park_Name) {
      entity.slug = data.park_Name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    }

    // park location
    if (data?.map_center) {
      entity.location = {
        longitude: data.map_center.Longitude,
        latitude: data.map_center.Latitude,
      };
    }

    // entity location
    if (data?.Coordinate) {
      entity.location = {
        longitude: data.Coordinate.Longitude,
        latitude: data.Coordinate.Latitude,
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
      _id: this.config.resortId,
      slug: this.config.resortSlug,
      name: this.config.name,
      entityType: entityType.destination,
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    const parks = await Promise.all(this.config.resortIds.map(async (parkId) => {
      const parkData = await this.getParkData(parkId);

      return {
        ...this.buildBaseEntityObject(parkData),
        _destinationId: this.config.resortId,
        _parentId: this.config.resortId,
        entityType: entityType.park,
      };
    }));

    return parks;
  }

  /**
   * Get seaworld entity array based on parkId, poiType
   */
  async getEntitiesOfTypeForPark(parkId, poiTypes, entityData) {
    const parkData = await this.getParkData(parkId);
    if (!parkData?.POIs) return [];

    // some entities are in the wrong high-level group, so iterate through them all
    const pois = [].concat(...Object.keys(parkData.POIs).map((poiType) => {
      return parkData.POIs[poiType].filter((x) => {
        return poiTypes.includes(x.Type);
      });
    }));

    return pois.map((poi) => {
      return {
        ...this.buildBaseEntityObject(poi),
        _parentId: parkId,
        _parkId: parkId,
        _destinationId: this.config.resortId,
        ...entityData,
      };
    });
  }

  /**
   * Get all entities for this resort with the given poi type
   */
  async getEntitiesOfTypeForAllParks(poiTypes, entityData) {
    const parks = await Promise.all(this.config.resortIds.map((parkId) => {
      return this.getEntitiesOfTypeForPark(parkId, poiTypes, entityData);
    }));
    return [].concat(...parks);
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    return this.getEntitiesOfTypeForAllParks(['Rides', 'Slides'], {
      entityType: entityType.attraction,
      attractionType: attractionType.ride,
    });
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    return this.getEntitiesOfTypeForAllParks(['Shows'], {
      entityType: entityType.show,
    });
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    return this.getEntitiesOfTypeForAllParks(['Dining'], {
      entityType: entityType.restaurant,
    });
  }

  /**
   * Fetch waittime data for a given park
   */
  async fetchWaitTimeData(parkId) {
    // cache 1 minute
    '@cache|1';

    const waitTimeData = await this.http(
      'GET',
      `${this.config.baseURL}v1/park/${parkId}/availability/`,
    );

    if (!waitTimeData || !waitTimeData.body) return [];

    return [].concat(...Object.values(waitTimeData.body));
  }

  /**
   * Fetch wait time data for all parks
   */
  async fetchResortWaitTimes() {
    const data = await Promise.all(this.config.resortIds.map(this.fetchWaitTimeData.bind(this)));
    return [].concat(...data);
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const waitTimes = await this.fetchResortWaitTimes();

    const liveData = [];

    waitTimes.forEach((waitTime) => {
      // find or create live data entry
      let liveObj = liveData.find((x) => x._id === waitTime.Id);
      if (!liveObj) {
        liveObj = liveData[liveData.push({
          _id: waitTime.Id,
          // default to closed, override if we find any data
          status: statusType.closed,
        }) - 1];
      }

      // find any show times
      if (waitTime.ShowTimes !== undefined && waitTime.ShowTimes !== null) {
        liveObj.status = statusType.operating;
        liveObj.showtimes = waitTime.ShowTimes.map((time) => {
          return {
            startTime: moment(time.StartTime).tz(this.config.timezone).format(),
            endTime: moment(time.EndTime).tz(this.config.timezone).format(),
            type: 'Performance',
          };
        });
      }

      // wait times
      if (waitTime.Minutes !== undefined) {
        // TODO - detect down/refurbishment
        liveObj.status = statusType.operating;
        liveObj.queue = {
          [queueType.standBy]: {
            waitTime: waitTime.Minutes === undefined ? null : waitTime.Minutes,
          },
        };
      }
    });

    return liveData;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    // return park opening hours
    const parks = await Promise.all(this.config.resortIds.map(async (parkId) => {
      const parkData = await this.getParkData(parkId);
      if (!parkData?.open_hours) return null;

      return {
        _id: parkId,
        schedule: parkData.open_hours.map((open_hour) => {
          return {
            startTime: moment(open_hour.opens_at).tz(this.config.timezone).format(),
            endTime: moment(open_hour.closes_at).tz(this.config.timezone).format(),
            type: scheduleType.operating,
            date: moment(open_hour.opens_at).tz(this.config.timezone).format('YYYY-MM-DD'),
          };
        }),
      };
    }));

    return parks.filter((x) => !!x);
  }
}

export class SeaworldOrlando extends SeaworldDestination {
  constructor(options = {}) {
      options.resortIds = [
        // seaworld orlando
        "AC3AF402-3C62-4893-8B05-822F19B9D2BC",
        // aquatica orlando
        "4B040706-968A-41B4-9967-D93C7814E665",
        // discovery cove orlando
        // "1FB04DFC-B6C0-4918-BE36-EE6DD14FE741",
      ];

      options.timezone = 'America/New_York';

      // https://en.wikipedia.org/wiki/SeaWorld_Orlando
      //  "When combined with its neighbor Discovery Cove and Aquatica, it forms SeaWorld Parks and Resorts Orlando"
      options.name = 'SeaWorld Parks and Resorts Orlando';
      
      options.resortId = 'seaworldorlandoresort';
      options.resortSlug = 'seaworldorlandoresort';

      super(options);
  }
}
