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
          _parkId: parkConfig.parkId,
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
    const liveData = [];

    // fetch live data for each park
    for (const parkConfig of this.config.parkConfigs) {
      const attractionData = await this._fetchAttractionData({
        parkId: parkConfig.parkKindCd,
      });

      for (const attraction of attractionData) {
        const attrData = {
          _id: attraction.faciltId,
          status: statusType.closed,
        };

        // read operStatusCd, eg. "OVER"
        switch (attraction.operStatusCd) {
          case "OPEN":
          case "RSVP":
            attrData.status = statusType.operating;
            break;
          case "RAIN": // heavy rain
          case "SMMR": // "summer suspension"
          case "SNOW": // snow
          case "THUN": // thunderstorm
          case "WIND": // heavy wind
          case "LTMP": // low temperature
          case "HTMP": // high temperature
          case "PMCH": // PM inspection
          case "WNTR": // "winter suspension"
            attrData.status = statusType.down;
            break;
          case "CLOS":
          case "OVER":
          case "STND":
          case "PEND":
          case "RNTR": // "suspension by renting" (I think this means the attraction is closed for a private event)
          default: // default to clsoed
            attrData.status = statusType.closed;
            break;
          case "CONR":
            attrData.status = statusType.refurbishment;
            break;
          //default:
          //  debugger;
        }

        // if we have a wait time and open...
        if (attrData.status == statusType.operating && attraction.waitTime && !isNaN(attraction.waitTime)) {
          attrData.queue = {
            [queueType.standBy]: {
              waitTime: attraction.waitTime,
            },
          };
        }

        liveData.push(attrData);
      }
    }

    return liveData;
  }

  /**
   * Fetch schedule data for a specific park for a specific date
   * Date is in Moment format, so it can be formatted as needed for the API
   * @param {*} options
   * @param {string} options.parkId Park ID to fetch schedule data for
   * @param {string} options.date Date to fetch schedule data for YYYYMMDD
   */
  async _fetchScheduleForParkForDate({
    parkId,
    date,
  }) {
    '@cache|12h'; // cache for 12 hours

    const url = `${this.config.baseURL}/api/v1/iam/facilities/parkOpenTime`;
    const data = {
      salesDate: date,
      parkKindCd: parkId,
    };

    const response = await this.http('GET', url, data);
    if (response.body.length > 0) {
      return response.body.find((x) => {
        return x.openTime && x.closeTime;
      })
    }
    return null;
  }

  /**
    * Fetch schedule data for a specific park
    * @param {*} options
    * @param {string} options.parkId Park ID to fetch schedule data for
    * @param {number} options.daysToFetch Number of days to fetch schedule data for
    * @returns {array<object>}
    */
  async _fetchSchedulesForPark({
    parkId,
    daysToFetch = 30,
  }) {
    const today = this.getTimeNowMoment();
    const schedules = [];
    for (let i = 0; i < daysToFetch; i++) {
      const date = today.clone().add(i, 'days');
      const dateStr = date.format('YYYYMMDD');
      const schedule = await this._fetchScheduleForParkForDate({
        parkId,
        date: dateStr,
      });
      if (schedule && schedule.openTime && schedule.closeTime) {
        const openTime = date.clone().set({
          hour: Number(schedule.openTime.substring(0, 2)),
          minute: Number(schedule.openTime.substring(3, 5)),
          second: 0,
        });
        const closeTime = date.clone().set({
          hour: Number(schedule.closeTime.substring(0, 2)),
          minute: Number(schedule.closeTime.substring(3, 5)),
          second: 0,
        });

        schedules.push({
          date: date.format('YYYY-MM-DD'),
          openingTime: openTime.format(),
          closingTime: closeTime.format(),
          type: scheduleType.operating,
        });
      }
    }
    return schedules;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const schedules = [];

    for (const parkConfig of this.config.parkConfigs) {
      const schedule = await this._fetchSchedulesForPark({
        parkId: parkConfig.parkKindCd,
      });

      schedules.push({
        _id: parkConfig.parkId,
        schedule: schedule,
      });
    }

    return schedules;
  }
}
