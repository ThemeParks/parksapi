import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import moment from 'moment-timezone';

export class HansaPark extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Europe/Berlin';
    options.resortId = options.resortId || 'hansa-park-resort';
    options.baseURL = options.baseURL || 'https://www.hansapark.de/api';
    options.locale = options.locale || 'en';
    options.name = options.name || 'Hansa-Park';

    options.apiKey = options.apiKey || null;

    super(options);

    if (!this.config.resortId) throw new Error('Missing resortId');
    if (!this.config.baseURL) throw new Error('Missing baseURL');
    if (!this.config.locale) throw new Error('Missing locale');
    if (!this.config.apiKey) throw new Error('Missing apiKey');

    const baseURLHostname = new URL(this.config.baseURL).hostname;

    // add our API key to all requests
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      if (!data) data = {};

      // add locale to GET request as locale= (if not already present)
      if (method.toLowerCase() === 'get' && !url.includes('locale=')) {
        //url += `&locale=${this.config.locale}`;
        data.locale = this.config.locale;
      }

      // add api key to GET request as key= (if not already present)
      if (method.toLowerCase() === 'get' && !url.includes('key=')) {
        //url += `&key=${this.config.apiKey}`;
        data.key = this.config.apiKey;
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

    if (!entity?._id && data?.id) {
      entity._id = `${data.id}`;
    }

    if (!entity?.name && data?.name) {
      entity.name = data.name;
    }

    return entity;
  }

  /**
   * Fetch all the POI data for this destination
   * @returns {object}
   */
  async fetchPOIData() {
    '@cache|5m'; // cache for 5 minutes
    // this function also gets live wait times for attractions, so cache for a short time
    const response = await this.http.get(`${this.config.baseURL}/attractions/`);
    return response.body;
  }

  /**
   * Fetch the POI data for this destination's attractions
   * @returns {object}
   */
  async getAttractionPOIData() {
    '@cache|2h'; // cache for 2 hours

    const poi = await this.fetchPOIData();

    // filter for entities with categories that include "Attractions"
    return poi.data.filter((x) => {
      if (!x?.categories) return false;
      const isAttraction = !!(x.categories.find((cat) => {
        return cat?.name === 'Attractions';
      }));
      const isShow = !!(x.categories.find((cat) => {
        return cat?.name === 'Shows';
      }));

      return isAttraction && !isShow;
    });
  }

  async getShowPOIData() {
    '@cache|2h'; // cache for 2 hours

    const poi = await this.fetchPOIData();

    // filter for entities with categories that include "Shows"
    return poi.data.filter((x) => {
      if (!x?.categories) return false;
      const isShow = !!(x.categories.find((cat) => {
        return cat?.name === 'Shows';
      }));

      return isShow;
    });
  }

  async getDiningPOIData() {
    '@cache|2h'; // cache for 2 hours

    const poi = await this.fetchPOIData();

    // filter for entities with categories that include "Restaurants"
    return poi.data.filter((x) => {
      if (!x?.categories) return false;
      const isDining = !!(x.categories.find((cat) => {
        return cat?.name === 'Restaurants';
      }));

      return isDining;
    });
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    const doc = {};
    return {
      ...this.buildBaseEntityObject(doc),
      _id: 'hansa-park-resort',
      slug: 'hansa-park-resort',
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
        _id: 'hansa-park',
        _destinationId: 'hansa-park-resort',
        _parentId: 'hansa-park-resort',
        slug: 'hansa-park',
        name: this.config.name,
        entityType: entityType.park,
      }
    ];
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const poi = await this.getAttractionPOIData();

    return poi.map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        _destinationId: 'hansa-park-resort',
        _parentId: 'hansa-park',
        _parkId: 'hansa-park',
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
      };
    });
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    const poi = await this.getShowPOIData();

    return poi.map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        _destinationId: 'hansa-park-resort',
        _parentId: 'hansa-park',
        _parkId: 'hansa-park',
        entityType: entityType.show,
      };
    });
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    const poi = await this.getDiningPOIData();

    return poi.map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        _destinationId: 'hansa-park-resort',
        _parentId: 'hansa-park',
        _parkId: 'hansa-park',
        entityType: entityType.restaurant,
      };
    });
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const poi = await this.fetchPOIData();
    const attractions = await this.getAttractionPOIData();

    const liveData = poi.data.filter((x) => {
      return (x && x.waitingTime && x.waitingTime.prefix && x.categories && x.categories.find((cat) => {
        // only include attractions in the "Ride Attractions" category
        return cat.name === 'Ride Attractions';
      }));
    }).map((x) => {
      // figure out operating status
      let status = statusType.operating;
      if (!x.isOpen) {
        status = statusType.closed;
      }
      if (x.outOfOrder || x.isOutOfOrder) {
        status = statusType.down;
      }

      const liveObj = {
        _id: `${x.id}`,
        status: status,
      };

      // include wait time if the attraction is operating
      if (liveObj.status == statusType.operating) {
        liveObj.queue = {
          [queueType.standBy]: {
            waitTime: x.waitingTime.minutes !== undefined ? x.waitingTime.minutes : null,
          },
        };
      }

      return liveObj;
    });

    return liveData;
  }

  async fetchSeasonData() {
    '@cache|1d'; // cache for 1 day

    const response = await this.http.get(`${this.config.baseURL}/seasons/`);
    return response.body;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const startDate = this.getTimeNowMoment();
    const endDate = this.getTimeNowMoment().add(6, 'months');

    const seasonData = await this.fetchSeasonData();
    const seasons = seasonData.data.filter((x) => {
      return (x.seasonStart && x.seasonEnd && !x.isParkClosed && x.showOpeningHoursInCalendar);
    }).map((x) => {
      // seasonStart and seasonEnd are unix timestamps in seconds
      return {
        seasonStart: moment(x.seasonStart * 1000).tz(this.config.timezone),
        seasonEnd: moment(x.seasonEnd * 1000).tz(this.config.timezone),
        openingHours: x.parkOpeningHoursFrom,
        closingHours: x.parkOpeningHoursTo,
      };
    });

    const dates = [];
    for (let m = startDate.clone(); m.isBefore(endDate); m.add(1, 'days')) {
      // find the season that matches this date
      const season = seasons.find((x) => {
        return m.isBetween(x.seasonStart, x.seasonEnd, null, '[]');
      });
      if (season) {
        const openTimeStr = `${m.format('YYYY-MM-DD')}T${season.openingHours}:00`;
        const closeTimeStr = `${m.format('YYYY-MM-DD')}T${season.closingHours}:00`;
        const openTime = moment.tz(openTimeStr, this.config.timezone);
        const closeTime = moment.tz(closeTimeStr, this.config.timezone);
        // add the date to the list of dates
        dates.push({
          date: m.format('YYYY-MM-DD'),
          openingTime: openTime.format(),
          closingTime: closeTime.format(),
          type: scheduleType.operating,
        });
      }
    }

    return [
      {
        _id: 'hansa-park',
        schedule: dates,
      }
    ];
  }
}
