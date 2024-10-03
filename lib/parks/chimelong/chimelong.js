import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';

export class Chimelong extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Asia/Shanghai';

    options.baseURL = options.baseURL || '';

    options.parkIds = options.parkIds || [
      "ZH56", // Chimelong Ocean Kingdom
    ];

    options.destinations = [
      {
        id: 'chimelongguangzhou',
        name: 'Guangzhou Chimelong Tourist Resort',
        location: {
          "latitude": 23.005,
          "longitude": 113.327,
        },
        parkIds: [],
      },
      {
        id: 'chimelongzhuhai',
        name: 'Chimelong International Ocean Tourist Resort',
        location: {
          "latitude": 22.101,
          "longitude": 113.533
        },
        parkIds: [
          "ZH56", // Chimelong Ocean Kingdom
        ],
      }
    ];

    super(options);

    if (!this.config.baseURL) throw new Error('Missing baseURL');

    // build a map of park IDs to destination IDs for easy lookup
    //  [parkId: string] => destinationId: string
    this.parksToDestinations = {};
    // build an array of all parks and their destination IDs
    //  [{parkId: string, destinationId: string}]
    this.parks = [];
    this.config.destinations.forEach((destination) => {
      destination.parkIds.forEach((parkId) => {
        this.parksToDestinations[parkId] = destination.id;

        this.parks.push({
          parkId: parkId,
          destinationId: destination.id,
        });
      });
    });

    const baseURLHostname = new URL(this.config.baseURL).hostname;
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      if (!options) {
        options = {};
      }

      // all requests can be compressed
      options.compress = true;

      // convert data to a string, not an actual JSON object
      if (data) {
        data = JSON.stringify(data);
        if (!options.headers) options.headers = {};
        options.headers = {
          channelcode: 'ONLINE',
          devicetype: 'APP_ANDROID',
          'content-type': 'text/plain; charset=ISO-8859-1',
        };
      }

      return {
        method,
        url,
        data,
        options,
      };
    });
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

    // return array of destinations
    return this.config.destinations.map((destination) => {
      return {
        ...this.buildBaseEntityObject(doc),
        _id: destination.id,
        slug: destination.id,
        name: destination.name,
        entityType: entityType.destination,
        location: destination.location,
      };
    });
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    return this.parks.map((park) => {
      return {
        ...this.buildBaseEntityObject(null),
        _id: `park_${park.parkId}`,
        _destinationId: park.destinationId,
        _parentId: park.destinationId,
        name: park.parkId, // TODO - get park name
        entityType: entityType.park,
      };
    });
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    // fetch live data for each park, these contain attraction IDs and names
    const attractions = await this._fetchLiveDataForAllParks();

    return attractions.map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        _id: `attraction_${x.code}`,
        _parentId: `park_${x.parkId}`,
        _parkId: `park_${x.parkId}`,
        _destinationId: this.parksToDestinations[x.parkId],
        name: x.name,
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
   * Fetch live data for a specific park
   * @param {object} options 
   * @param {string} options.parkId 
   * @returns 
   */
  async _fetchLiveDataForPark({
    parkId = null,
  }) {
    '@cache|1'; // cache for 1 minute
    if (!parkId) {
      return [];
    }

    const resp = await this.http(
      'POST',
      `${this.config.baseURL}/v2/miniProgram/scenicFacilities/findWaitTimeList`,
      {
        code: parkId,
      });

    return resp.body;
  }

  /**
   * Fetch live data for all parks
   * @returns 
   */
  async _fetchLiveDataForAllParks() {
    // fetch live data for all parks
    const parkIds = this.config.parkIds;

    const data = await Promise.all(parkIds.map(async (park) => {
      const parkData = await this._fetchLiveDataForPark({
        parkId: park,
      });

      if (!parkData || !parkData.data) return [];

      return parkData.data.map((x) => {
        return {
          ...x,
          parkId: park,
          destinationId: this.parksToDestinations[park],
        };
      });
    }));

    return data.reduce((acc, val) => acc.concat(val), []);
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {

    const liveData = await this._fetchLiveDataForAllParks();

    return liveData.map((x) => {
      // try and parse the waittime time
      let waitTime = null;
      try {
        waitTime = parseInt(x.waitingTime);
      } catch (e) {
        // do nothing
      }

      if (isNaN(waitTime)) {
        waitTime = null;
      }

      const liveData = {
        _id: `attraction_${x.code}`,
        status: statusType.operating,
      };

      if (waitTime !== null) {
        liveData.queue = {
          [queueType.standBy]: {
            waitTime: waitTime,
          }
        };
      } else {
        liveData.status = statusType.closed;
      }

      return liveData;
    });
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
