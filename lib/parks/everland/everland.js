import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';

// Destination object for Everland Korea resorts
export class Everland extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Asia/Seoul';

    options.baseURL = options.baseURL || '';

    options.resortId = options.resortId || 'everlandresort';
    options.parkConfigs = options.parkConfigs || [
      {
        name: 'Everland',
        parkId: 'everland',
        parkKindCd: '01',
        timezone: 'Asia/Seoul',
        location: {
          latitude: 37.295206,
          longitude: 127.204360
        },
      },
      {
        name: 'Caribbean Bay',
        parkId: 'caribbeanbay',
        parkKindCd: '02',
        timezone: 'Asia/Seoul',
        location: {
          latitude: 37.296021,
          longitude: 127.203194
        },
      }
    ];

    super(options);

    if (!this.config.baseURL) throw new Error('Missing baseURL');

    const baseURLHostname = new URL(this.config.baseURL).hostname;
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      options.headers = options.headers || {};
      // always set a referer
      options.headers['Referer'] = "https://www.everland.com/";
      // accept JSON
      options.headers['Accept'] = "application/json, text/plain, */*"
      // API server accepts compressed connections
      options.compress = true;
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

    if (!data) return entity;

    // try and get English name, fall back on Korean
    entity.name = data.faciltNameEng || data.faciltName;

    if (data.locList) {
      if (data.locList.length > 1) {
        debugger;
      }
      entity.location = {
        latitude: Number(data.locList[0].latud),
        longitude: Number(data.locList[0].lgtud),
      };
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
      _id: this.config.resortId,
      slug: this.config.resortId,
      name: "Everland Resort",
      entityType: entityType.destination,
      location: {
        latitude: 37.295206,
        longitude: 127.204360
      },
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    return this.config.parkConfigs.map((parkConfig) => {
      return {
        ...this.buildBaseEntityObject(null),
        _id: parkConfig.parkId,
        _destinationId: this.config.resortId,
        _parentId: this.config.resortId,
        name: parkConfig.name,
        entityType: entityType.park,
        location: parkConfig.location,
      };
    });
  }

  /**
   * Fetch the park data for a specific park
   * @param {*} options
   * @param {*} options.parkId Park ID to fetch data for
   * @returns 
   */
  async _fetchAttractionData({
    parkId,
  }) {
    '@cache|1'; // cache for 1 minute (contains wait times)
    const url = `${this.config.baseURL}/api/v1/iam/facilities/kind`;//?faciltCateKindCd=01&parkKindCd=01&langCd=en&disabledCd=N&latud=&lgtud=&waitSortYn=N&courseSortYn=N&limitHeight=0&foodTypeCds=&perfrmSortYn=N`;
    const data = {
      faciltCateKindCd: '01',
      parkKindCd: parkId,
      langCd: 'en',
      disabledCd: 'N',
      latud: '',
      lgtud: '',
      waitSortYn: 'N',
      courseSortYn: 'N',
      limitHeight: 0,
      foodTypeCds: '',
      perfrmSortYn: 'N',
    };

    const response = await this.http('GET', url, data);
    return response.body?.faciltList || [];
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const attractionEntities = [];
    // loop through each park
    for (const parkConfig of this.config.parkConfigs) {
      const attractionData = await this._fetchAttractionData({
        parkId: parkConfig.parkKindCd,
      });

      for (const attraction of attractionData) {
        attractionEntities.push({
          ...this.buildBaseEntityObject(attraction),
          _id: attraction.faciltId,
          _destinationId: this.config.resortId,
          _parentId: parkConfig.parkId,
          entityType: entityType.attraction,
          attractionType: attractionType.ride,
        });
      }
    }
    return attractionEntities;
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
