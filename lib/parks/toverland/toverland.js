import moment from 'moment';
import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';

export class Toverland extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Europe/Amsterdam';

    options.name = options.name || 'Attractiepark Toverland';
    options.apiBase = options.apiBase || '';
    options.calendarUrl = options.calendarUrl || '';
    options.authToken = options.authToken || '';
    options.languages = options.languages || ['en', 'nl', 'de'];

    options.cacheVersion = options.cacheVersion || 'v1';

    super(options);

    if (!this.config.apiBase) throw new Error('Missing apiBase');
    if (!this.config.authToken) throw new Error('Missing authToken');
    if (!this.config.calendarUrl) throw new Error('Missing calendarUrl');

    // add our auth token into any API requests
    const baseURLHostname = new URL(this.config.apiBase).hostname;
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      options.headers = {
        ...(options.headers || {}),
        // inject auth token
        'authorization': `Bearer ${this.config.authToken}`,
      };
    });
  }

  /**
   * Fetch Toverland ride live data and names etc.
   * These are in the same endpoint
   */
  async fetchRideData() {
    '@cache|1'; // cache for 1 minute
    const response = await this.http('GET', `${this.config.apiBase}park/ride/operationInfo/list`);
    return response.body;
  }

  /**
   * Fetch Toverland show data
   */
  async fetchShowData() {
    '@cache|240'; // cache for 4 hours
    const response = await this.http('GET', `${this.config.apiBase}park/show/operationInfo/list`);
    return response.body;
  }

  /**
   * Fetch Toverland dining data
   */
  async fetchDiningData() {
    '@cache|480'; // cache for 8 hours
    const response = await this.http('GET', `${this.config.apiBase}park/foodAndDrinks/operationInfo/list`);
    return response.body;
  }

  /**
   * Helper function to get a preferred translation of a string or object
   * @param {object|string} obj 
   */
  getLocString(obj) {
    if (typeof obj === 'object') {
      // look for localised strings in order of the languages in config
      const lang = this.config.languages.find((x) => {
        return !!obj[lang];
      });
      if (lang) return obj[lang];

      // if failed, return first language found
      return obj[Object.keys(obj)[0]];
    }
    return obj;
  }

  /**
   * Helper function to build a basic entity document
   * Useful to avoid copy/pasting
   * @param {object} data 
   * @returns {object}
   */
  buildBaseEntityObject(data) {
    const entity = Destination.prototype.buildBaseEntityObject.call(this, data);

    if (data.id) {
      entity._id = `${data.id}`;
    }

    if (data.name) {
      entity.name = this.getLocString(data.name);
    }

    if (data.longitude && data.latitude) {
      entity.location = {
        longitude: Number(data.longitude),
        latitude: Number(data.latitude),
      };
    }

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    return {
      ...this.buildBaseEntityObject({}),
      _id: 'toverlandresort',
      slug: 'toverlandresort',
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
        ...this.buildBaseEntityObject({}),
        _id: 'toverland',
        _destinationId: 'toverlandresort',
        _parentId: 'toverlandresort',
        name: this.config.name,
        slug: 'toverland',
        entityType: entityType.park,
        location: {
          latitude: 51.3982068,
          longitude: 5.9838255
        }
      }
    ];
  }

  async _buildEntityList(fetchFn, attributes = {}, id_prefix = '') {
    const rides = await fetchFn();
    return rides.map((x) => {
      return {
        ...this.buildBaseEntityObject({
          ...x,
          id: `${id_prefix}${x.id}`,
        }),
        _parentId: 'toverland',
        _destinationId: 'toverlandresort',
        _parkId: 'toverland',
        ...attributes,
      };
    });
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    return await this._buildEntityList(this.fetchRideData.bind(this), {
      entityType: entityType.attraction,
      attractionType: attractionType.ride,
    });
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    return await this._buildEntityList(this.fetchShowData.bind(this), {
      entityType: entityType.show,
    }, 'show_');
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    return await this._buildEntityList(this.fetchDiningData.bind(this), {
      entityType: entityType.restaurant,
    }, 'dining_');
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const rides = await this.fetchRideData();
    return rides.map((x) => {
      const status = x?.last_status?.status?.name?.en;
      if (!status) return null;

      // other statuses include "Variable schedule", which we will leave as "operating"
      let rideStatus = statusType.operating;
      if (status.startsWith('Closed')) {
        rideStatus = statusType.closed;
      } else if (status.startsWith('Open')) {
        rideStatus = statusType.operating;
      } else if (status.startsWith('Maintenance')) {
        rideStatus = statusType.refurbishment;
      } else if (status.startsWith('Disorder')) {
        rideStatus = statusType.down;
      }

      const waitTime = x?.last_waiting_time?.waiting_time;
      if (waitTime === undefined) return null;

      return {
        _id: `${x.id}`,
        status: rideStatus,
        queue: {
          [queueType.standBy]: {
            waitTime: Number(waitTime),
          }
        }
      };
    }).filter((x) => !!x);
  }

  /**
   * Fetch a week of calendar entries from a given date
   * @param {string} date Date in YYYY-MM-DD format
   */
  async _fetchWeekCalendar(month, year) {
    '@cache|1440'; // cache for 24 hours
    const url = `${this.config.calendarUrl}?month=${month}&year=${year}`;
    const resp = await this.http('GET', url);
    return resp.body;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const startDate = this.getTimeNowMoment().clone().startOf('month');
    const endDate = startDate.clone().add(6, 'months').endOf('month');

    // fetch data by month
    const datesToFetch = [];
    for(let i = startDate.clone(); i.isBefore(endDate); i.add(1, 'month')) {
      datesToFetch.push({
        month: i.month() + 1,
        year: i.year(),
      });
    }

    // collect all data together...
    const calendarData = [];
    for (const date of datesToFetch) {
      calendarData.push(await this._fetchWeekCalendar(date.month, date.year));
    }

    // smush data into a single array
    const data = calendarData.reduce((acc, x) => {
      return acc.concat(x.days.map((day) => {
        return {
          ...day,
          month: x.month,
          year: x.year,
        };
      }));
    }, []).filter((x) => {
      // ignore dates missing any colour data (assume closed)
      return x.openingHoursFrom && x.openingHoursTo && x.openingHoursFrom !== '00:00:00' && x.openingHoursTo !== '00:00:00';
    });

    return [
      {
        _id: 'toverland',
        schedule: data.map((x) => {
          const date = `${x.year}-${x.month.toString().padStart(2, '0')}-${x.dayNr.toString().padStart(2, '0')}`;
          return {
            date: date,
            type: "OPERATING",
            openingTime: moment(`${date}T${x.openingHoursFrom}`, 'YYYY-MM-DDTHH:mm:ss').tz(this.config.timezone, true).format(),
            closingTime: moment(`${date}T${x.openingHoursTo}`, 'YYYY-MM-DDTHH:mm:ss').tz(this.config.timezone, true).format(),
          };
        }).filter((x) => !!x),
      },
    ];
  }
}
