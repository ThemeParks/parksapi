import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';

import moment from 'moment-timezone';

// from IndoorPoiName class in Universal Studios Beijing app
const nameReplacements = {
  "\\{1\\}": "™",
  "\\{2\\}": "®",
  "\\{3\\}": "©",
};
function formatName(strIn) {
  // replace any special characters
  let str = strIn;
  for (const key in nameReplacements) {
    str = str.replace(new RegExp(key, 'g'), nameReplacements[key]);
  }
  return str;
}

function gemsStatusToTPW(gems_status) {
  switch (gems_status) {
    case '': // no status, assume open (e.g. cinema)
    case '1': // Open
    case '2': // Running
      return statusType.operating;
    case '3': // Closed
    case '5': // UnavailableToday
      return statusType.closed;
    case '4': // ClosedDueToWeather
    case '6': // UnavailableTemporarily
    case '7': // NotOperationa [sic]
      return statusType.down;
    case '8': // ClosedForRoutineMaintenance
      return statusType.refurbishment;
    default: // any unknown status, assume closed
      return statusType.closed;
  }
}

export class UniversalStudiosBeijing extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Asia/Shanghai';

    options.baseURL = options.baseURL || '';
    options.name = options.name || 'Universal Beijing Resort';
    options.destinationId = options.destinationId || 'universalbeijingresort';

    super(options);

    if (!this.config.baseURL) throw new Error('Missing Universal Studios Beijing baseURL');

    const baseURLHostname = new URL(this.config.baseURL).hostname;
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      options.headers['language'] = 'en';
      options.headers['IsInPark'] = '1';
      options.headers['OS'] = 'Android';
      options.headers['appversion'] = '3.6.1';
      options.headers['versioncode'] = '36';
      options.headers['USERAREA'] = 'other';
      options.headers['x-date'] = new Date().toUTCString();
      options.headers['lat'] = '39.9042';
      options.headers['lng'] = '116.4074';
      options.headers['user-agent'] = 'okhttp/3.12.1';
      options.compress = true;
    });
  }

  /** Fetch our attraction data and wait times */
  async _fetchAttractionData() {
    // cache for 1 minute
    '@cache|1';

    const url = `${this.config.baseURL}/map/attraction/list?type_id=&mode=list`;

    const response = await this.http(url);
    return response.body;
  }

  /** Fetch our show data */
  async _fetchShowData() {
    // cache for 3 hours
    '@cache|3h';

    const url = `${this.config.baseURL}/map/perform/list/v2?type_id=&mode=list&version=1`;

    const response = await this.http(url);
    return response.body;
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
      // basic id and name
      entity._id = data.id;
      if (data.title) {
        entity.name = formatName(data.title);
      }

      // geo location
      if (data.position && data.position.latitude && data.position.longitude) {
        entity.location = {
          latitude: Number(data.position.latitude),
          longitude: Number(data.position.longitude),
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
      _id: this.config.destinationId,
      slug: this.config.destinationId,
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
        _id: 'universalstudiosbeijing',
        _destinationId: this.config.destinationId,
        _parentId: this.config.destinationId,
        name: "Universal Studios Beijing",
        entityType: entityType.park,
      }
    ];
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const data = await this._fetchAttractionData();

    const attractions = data.data.list.map((attraction) => {
      return {
        ...this.buildBaseEntityObject(attraction),
        _destinationId: this.config.destinationId,
        // TODO - when second park is added, this will need to be updated
        _parentId: 'universalstudiosbeijing',
        _parkId: 'universalstudiosbeijing',
        entityType: entityType.attraction,
        // TODO - map attraction types
        attractionType: attractionType.ride,
      };
    });

    return attractions;
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    const data = await this._fetchShowData();

    const shows = data.data.list.map((show) => {
      return {
        ...this.buildBaseEntityObject(show),
        _destinationId: this.config.destinationId,
        _parentId: 'universalstudiosbeijing',
        _parkId: 'universalstudiosbeijing',
        entityType: entityType.show,
      };
    });

    return shows;
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
    const getOrCreateLiveData = (id) => {
      let live = liveData.find((l) => l._id === id);
      if (!live) {
        live = {
          _id: id,
          status: statusType.operating,
        };
        liveData.push(live);
      }
      return live;
    };

    // get attraction wait times
    const attractionData = await this._fetchAttractionData();
    const attractions = attractionData.data.list;
    attractions.forEach((attraction) => {
      const live = getOrCreateLiveData(attraction.id);

      live.status = gemsStatusToTPW(attraction.gems_status);
      if (attraction.is_closed) {
        live.status = statusType.closed;
      }

      // queue times
      if (live.status == statusType.operating && attraction.waiting_time && attraction.waiting_time >= 0) {
        live.queue = {
          [queueType.standBy]: {
            waitTime: attraction.waiting_time,
          },
        };
      }
    });

    // fetch show times
    const showData = await this._fetchShowData();
    const shows = showData.data.list;
    shows.forEach((show) => {
      const live = getOrCreateLiveData(show.id);

      live.status = gemsStatusToTPW(show.gems_status);
      if (show.is_closed) {
        live.status = statusType.closed;
      }

      if (show.show_time_arr) {
        // show times
        const todaysDateInBeiJing = this.getTimeNowMoment();
        const todayStr = todaysDateInBeiJing.format('YYYY-MM-DD');

        live.showtimes = show.show_time_arr.map((showtime) => {
          if (showtime && showtime.time) {
            const showTimeStr = `${todayStr}T${showtime.time}`;
            const showTimeMoment = moment.tz(showTimeStr, 'Asia/Shanghai');
            return {
              type: "Performance Time",
              startTime: showTimeMoment.format(),
              endTime: null,
            };
          }
        }).filter((x) => x);
      }
    });

    return liveData;
  }

  /**
   * Get the month overview data
   * Returns which day the park is open, skip fetching hours for closed days
   */
  async _fetchMonthScheduleOverview({
    year,
    month,
  }) {
    // cache for 12 hours
    '@cache|12h';

    // zero pad month
    const monthPadded = month.toString().padStart(2, '0');

    const url = `${this.config.baseURL}/event/calendar?date=${year}-${monthPadded}`;

    const response = await this.http(url);
    return response.body;
  }

  /**
   * Fetch schedule data for a specific date
   * @param {string} date Date in YYYY-MM-DD format
   * @returns {object}
   */
  async _fetchDailySchedule({
    date,
  }) {
    // cache for 1 day
    '@cache|1d';

    const url = `${this.config.baseURL}/event/calendar/${date}?meettype=meeting&version=1`;

    const response = await this.http(url);
    return response.body;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const monthsToFetch = [];

    // (attempt to) fetch next 90 days of schedule data
    // list the mont
    for (let i = 0; i < 90; i++) {
      const date = new Date();
      date.setDate(date.getDate() + i);

      const monthExist = monthsToFetch.find((m) => m.year === date.getFullYear() && m.month === date.getMonth() + 1);

      if (!monthExist) {
        monthsToFetch.push({
          year: date.getFullYear(),
          month: date.getMonth() + 1,
        });
      }
    }

    // find dates to fetch by loading the month overviews
    const datesToFetch = [];
    for (const month of monthsToFetch) {
      const monthData = await this._fetchMonthScheduleOverview(month);

      for (const day of monthData.data.date_list) {
        if (day.status) {
          datesToFetch.push(day.date);
        }
      }
    }

    // get daily schedule data
    const scheduleData = [];
    for (const date of datesToFetch) {
      const dateData = await this._fetchDailySchedule({
        date,
      });

      if (!dateData || !dateData.data || !dateData.data.service_time || !dateData.data.service_time.park) {
        continue;
      }

      const parkData = dateData.data.service_time.park;
      if (parkData.gems_status != '1' && parkData.gems_status != '2') {
        continue;
      }

      // construct opening and closing times
      const openStr = `${date}T${parkData.open}`;
      const closeStr = `${date}T${parkData.close}`;

      const openMoment = moment.tz(openStr, 'Asia/Shanghai');
      const closeMoment = moment.tz(closeStr, 'Asia/Shanghai');

      scheduleData.push({
        date,
        type: scheduleType.operating,
        openingTime: openMoment.format(),
        closingTime: closeMoment.format(),
      });
    }

    return [
      {
        _id: 'universalstudiosbeijing',
        schedule: scheduleData,
      }
    ];
  }
}

export default UniversalStudiosBeijing;
