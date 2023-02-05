import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import moment from 'moment';

export class Hersheypark extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'America/New_York';
    
    options.apiKey = options.apiKey || '';
    options.baseURL = options.baseURL || 'https://hpapp.hersheypa.com';
    
    super(options);

    if (!this.config.apiKey) throw new Error('Missing apiKey');

    // hook into the base API URL to add our api key
    const baseURLHostname = new URL(this.config.baseURL).hostname;
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      options.rejectUnauthorized = false;
      options.headers = {
        ...options.headers,
        'x-api-key': this.config.apiKey,
      };
    });
  }

  /**
   * Fetch the POI data for this destination
   * @returns 
   */
  async fetchPOIData() {
    // cache for 1 day
    '@cache|1d';
    // fetch the park data from the API
    const response = await this.http.get(`${this.config.baseURL}/v2/index`);
    // return the park data
    return response.body;
  }

  /**
   * Fetch the live data for all entities in this destination
   */
  async fetchStatusData() {
    '@cache|2m'; // cache for 2 minutes
    const response = await this.http.get(`${this.config.baseURL}/v2/status`);
    return response.body;
  }

  /**
   * Get the main park POI data
   */
  async getParkPOIData() {
    '@cache|6h'; // cache for 6 hours
    const poi = await this.fetchPOIData();

    const parkData = poi.explore.find((x) => x.isHersheyPark);
    if (!parkData) {
      throw new Error('Missing park data');
    }

    return parkData;
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
      entity.name = data.name || undefined;

      if (data.latitude && data.longitude) {
        entity.location = {
          latitude: data.latitude,
          longitude: data.longitude,
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
      ...this.buildBaseEntityObject(null),
      _id: 'hersheypark',
      slug: 'hersheypark',
      name: 'Hersheypark',
      entityType: entityType.destination,
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    const parkData = await this.getParkPOIData();

    return [
      {
        ...this.buildBaseEntityObject(parkData),
        _id: 'hersheyparkthemepark',
        _destinationId: 'hersheypark',
        _parentId: 'hersheypark',
        slug: 'hersheyparkthemepark',
        entityType: entityType.park,
      }
    ];
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const poi = await this.fetchPOIData();
    const entities = [];
    for(const ride of poi.rides) {
      entities.push({
        ...this.buildBaseEntityObject(ride),
        _id: `rides_${ride.id}`,
        _destinationId: 'hersheypark',
        _parentId: 'hersheyparkthemepark',
        _parkId: 'hersheyparkthemepark',
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
      });
    }
    return entities;
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
    const liveData = await this.fetchStatusData();

    return liveData.map((x) => {
      // only support live data for rides, update this to add support for other entities
      if (x.type !== 'rides') {
        return null;
      }

      const data = {
        _id: `${x.type}_${x.id}`,
        status: statusType.closed,
      };

      // statuses:
      //  3: park closed
      //  2: <unknown> (assumed down)
      //  1: open
      //  0: ride closed

      if (x.status === 2) {
        data.status = statusType.down;
      } else if (x.status === 1) {
        data.status = statusType.operating;

        if (x.wait !== null && x.wait !== undefined) {
          data.queue = {
            [queueType.standBy]: {
              waitTime: x.wait,
            },
          };
        }
      }

      return data;
    }).filter((x) => !!x);
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    // find park ID so we can grab schedule from exploreHours
    const parkData = await this.getParkPOIData();
    const parkId = parkData.id;

    const allPOIData = await this.fetchPOIData();

    const schedule = [];
    for(const date in allPOIData.exploreHours) {
      const hours = allPOIData.exploreHours[date];
      const parkHours = hours[parkId];
      if (!parkHours) {
        continue;
      }

      // parkHours is a string in the format: "10:00 AM - 10:00 PM"
      const [start, end] = parkHours.split(' - ');
      if (!start || !end) {
        continue;
      }

      const startTime = moment.tz(`${date} ${start}`, 'YYYY-MM-DD h:mma', this.config.timezone);
      const endTime = moment.tz(`${date} ${end}`, 'YYYY-MM-DD h:mma', this.config.timezone);

      schedule.push({
        date: date,
        openingTime: startTime.format(),
        closingTime: endTime.format(),
        type: 'OPERATING',
      });
    }

    return [
      {
        _id: 'hersheyparkthemepark',
        schedule,
      }
    ];
  }
}
