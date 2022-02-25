import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import moment from 'moment-timezone';

export class HerschendDestination extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'America/New_York';

    // we have multiple Herschend parks, so we need to set the resortId
    options.destinationId = options.destinationId || '';
    // slug to use for this destination
    options.destinationSlug = options.destinationSlug || '';

    // base URL for live data API
    options.apiBase = options.apiBase || '';

    // base URL for the CRM API
    options.crmBaseURL = options.crmBaseURL || '';
    // auth credentials for accessing the CRM API
    options.crmAuth = options.crmAuth || '';
    // guid for this destination's calendar and POI data
    options.crmGUID = options.crmGUID || '';
    // categories for POI data
    options.crmAttractionsId = options.crmAttractionsId || '';
    options.crmDiningId = options.crmDiningId || '';
    options.crmShowId = options.crmShowId || '';

    // allow configuring all herschend parks with the HERSCHEND prefix env var
    options.configPrefixes = options.configPrefixes || ['HERSCHEND'];

    super(options);

    if (!this.config.destinationId) throw new Error('Missing destinationId');
    if (!this.config.destinationSlug) throw new Error('Missing destinationSlug');
    if (!this.config.apiBase) throw new Error('HerschendDestination requires an apiBase');
    if (!this.config.crmBaseURL) throw new Error('Missing crmBaseURL');
    if (!this.config.crmAuth) throw new Error('Missing crmAuth');
    if (!this.config.crmGUID) throw new Error('Missing crmGUID');
    if (!this.config.crmAttractionsId) throw new Error('Missing crmAttractionsId');
    if (!this.config.crmDiningId) throw new Error('Missing crmDiningId');
    if (!this.config.crmShowId) throw new Error('Missing crmShowId');

    this.config.parkId = this.config.parkId || `${this.config.destinationSlug}park`;

    // inject into CRM API requests
    const crmURLHostname = new URL(this.config.crmBaseURL).hostname;
    this.http.injectForDomain({
      hostname: crmURLHostname,
    }, async (method, url, data, options) => {
      // add our auth credentials to the request
      options.headers = {
        ...options.headers,
        authorization: `Basic ${this.config.crmAuth}`,
      };

      options.json = true;
    });
  }

  /**
   * Get raw wait times data
   */
  async getWaitTimes() {
    '@cache|1'; // cache for 1 minute
    const resp = await this.http(`${this.config.apiBase}waitTimes/${this.config.destinationId}`);
    return resp.body;
  }

  /**
   * Get raw food wait times data
   */
  async getFoodWaitTimes() {
    '@cache|1'; // cache for 1 minute
    const resp = await this.http(`${this.config.apiBase}foodServiceWaitTimes/${this.config.destinationId}`);
    return resp.body;
  }

  /**
   * Get raw train times data
   */
  async getTrainTimes() {
    '@cache|1'; // cache for 1 minute
    const resp = await this.http(`${this.config.apiBase}trainServiceSchedules/${this.config.destinationId}`);
    return resp.body;
  }

  /**
   * Get raw attraction POI data
   */
  async getPOIData() {
    // cache for 12 hours
    '@cache|720';
    const resp = await this.http(`${this.config.crmBaseURL}sitecore/api/hfe/hfedata/activitiesbypark/${this.config.crmGUID}`);
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
      entity._tags = [];

      if (data.id) {
        entity._id = data.id;
      }

      // geo location
      if (data.mapLocation && data.mapLocation.latitude && data.mapLocation.longitude) {
        entity.longitude = Number(data.mapLocation.longitude);
        entity.latitude = Number(data.mapLocation.latitude);
      }

      // entity name
      if (data.title) {
        entity.name = data.title;
      }

      if (data.heightRequirement && data.heightRequirement.minHeight > 0) {
        // convert from inches to cm
        const minHeightInCm = Math.floor(Number(data.heightRequirement.minHeight) * 2.54);

        entity._tags.push({
          id: 'minimumHeight',
          value: minHeightInCm,
        });
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
      slug: this.config.destinationSlug,
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
        _id: this.config.parkId,
        _destinationId: this.config.destinationSlug,
        _parentId: this.config.destinationSlug,
        name: this.config.name,
        slug: this.config.parkId,
        entityType: entityType.park,
      }
    ];
  }

  /**
   * Helper function to filter POI data for a chosen category GUID
   * @param {string} category 
   * @returns 
   */
  async getPOIForCategory(category, filterSeasonal = true) {
    const poiData = await this.getPOIData();

    const now = this.getTimeNowMoment();

    return poiData.activities.filter((x) => {
      if (x.activityListId !== category) return false;

      // check seasonality
      if (filterSeasonal) {
        if (x.seasonalStartDate) {
          const startDate = moment(x.seasonalStartDate);
          if (startDate.isAfter(now)) return false;
        }
        if (x.seasonalEndDate) {
          const endDate = moment(x.seasonalEndDate);
          if (endDate.isBefore(now)) return false;
        }
      }

      return true;
    });
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const attrs = await this.getPOIForCategory(this.config.crmAttractionsId, false);

    return attrs.map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
        _destinationId: this.config.destinationSlug,
        _parkId: this.config.parkId,
        _parentId: this.config.parkId,
      };
    });
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    return [];

    const attrs = await this.getPOIForCategory(this.config.crmShowId, true);

    return attrs.map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        entityType: entityType.show,
        _destinationId: this.config.destinationSlug,
        _parkId: this.config.parkId,
        _parentId: this.config.parkId,
      };
    });
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    const attrs = await this.getPOIForCategory(this.config.crmDiningId, false);

    return attrs.map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        entityType: entityType.restaurant,
        _destinationId: this.config.destinationSlug,
        _parkId: this.config.parkId,
        _parentId: this.config.parkId,
      };
    });
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    // get all the data we need
    const liveData = await this.getWaitTimes();
    const poiData = await this.getPOIData();

    return liveData.map((x) => {
      // find matching poiData for this live data
      const rideId = `${x.rideId}`;
      const poi = poiData.activities.find((y) => `${y.rideWaitTimeRideId}` === rideId);
      if (!poi) return null;

      const data = {
        _id: poi.id,
        status: statusType.closed,
        queue: {},
      };

      if (x.operationStatus === 'CLOSED' || x.operationStatus === 'UNKNOWN') {
        data.status = statusType.closed;
      } else if (x.waitTimeDisplay.includes('UNDER')) {
        // Wait time is not defined if text says "Under x minutes" - we'll set the ride time to x
        try {
          data.queue[queueType.standBy] = {
            waitTime: parseInt(x.waitTimeDisplay.split(' ')[1], 10),
          };
        } catch (e) {
          // fallback if formatting fails
          data.queue[queueType.standBy] = {
            waitTime: parseInt(x.waitTime, 10),
          };
        }
      } else {
        data.queue[queueType.standBy] = {
          waitTime: parseInt(x.waitTime, 10),
        };
      }

      return data;
    }).filter((x) => !!x);
  }

  /**
   * Fetch startdate and the following 4 days (total 5 days) of schedule data
   * @param {string} startDate 
   * @returns 
   */
  async fetchFiveDates(startDate) {
    // cache for 12 hours
    '@cache|720';
    const resp = await this.http(`${this.config.crmBaseURL}sitecore/api/hfe/hfedata/dailyschedulebytime?parkids=${this.config.crmGUID}&date=${startDate}&days=5`);
    return resp.body;
  }

  async fetchScheduleData(days = 90) {
    // cache for 12 hours
    '@cache|720';
    const now = this.getTimeNowMoment();
    const endDate = now.clone().add(days, 'days');
    const datesToFetch = [];
    while (now.isSameOrBefore(endDate, 'day')) {
      datesToFetch.push(now.format('YYYY-MM-DD'));
      now.add(5, 'day');
    }

    // fetch each date block
    const data = [];
    for (let i = 0; i < datesToFetch.length; i++) {
      const resp = await this.fetchFiveDates(datesToFetch[i]);
      data.push(...resp);
    }

    return data;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const parkHours = await this.fetchScheduleData();

    return [
      {
        _id: this.config.parkId,
        schedule: parkHours.map((x) => {
          // step 1: extract park hours from schedule data
          if (x?.schedule?.parkHours) {
            return x.schedule.parkHours.find((y) => {
              // step 2: filter out park hours that don't match our park ID
              return y.id === this.config.crmGUID;
            });
          }
          return null;
        }).filter((x) => {
          // step 3: filter out nulls
          return x !== null && x?.from !== null && x?.to !== null;
        }).map((x) => {
          // step 4: convert to our format
          const from = moment.tz(x.from, this.config.timezone);
          const to = moment.tz(x.to, this.config.timezone);
          return {
            date: from.format('YYYY-MM-DD'),
            type: "OPERATING",
            openingTime: from.format(),
            closingTime: to.format(),
          };
        }),
      }
    ];
  }
}

export class Dollywood extends HerschendDestination {
  constructor(options = {}) {
    options.timezone = "America/New_York";
    options.name = "Dollywood";
    options.destinationId = "1";
    options.destinationSlug = "dollywood";
    options.crmBaseURL = "https://www.dollywood.com/";

    options.crmGUID = "A8F3517D-4606-4387-B275-DC607DCD6DDE";
    options.crmAttractionsId = "0B00A5A0-8389-40CD-866F-5A7048FE248F";
    options.crmDiningId = "09E82561-D097-4612-BCCC-4E1F4E1AD0C6";
    options.crmShowId = "FA6C7A55-2AE1-4A27-9E95-94D46977BA1C";

    super(options);
  }
}

export class SilverDollarCity extends HerschendDestination {
  constructor(options = {}) {
    options.timezone = "America/Chicago";
    options.name = "Silver Dollar City";
    options.destinationId = "2";
    options.destinationSlug = "silverdollarcity";
    options.crmBaseURL = "https://www.silverdollarcity.com/";

    options.crmGUID = "988C96B2-ED23-4422-987B-4DAAC045E3BA";
    options.crmAttractionsId = "D69D844F-3D21-4E4E-8326-484AB575095C";
    options.crmDiningId = "54D38926-7D3B-4948-9676-AB6ECFAAAAE4";
    options.crmShowId = "2A28E900-9D3B-4939-B617-8B7B4D583421";

    super(options);
  }
}
