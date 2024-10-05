import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';

import moment from 'moment-timezone';

export class Chimelong extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Asia/Shanghai';

    options.baseURL = options.baseURL || '';

    options.destinations = [
      {
        id: 'chimelongguangzhou',
        name: 'Guangzhou Chimelong Tourist Resort',
        location: {
          "latitude": 23.005,
          "longitude": 113.327,
        },
        parks: [
          {
            parkId: 'GZ51',
            name: 'Chimelong Paradise',
            calendarURL: 'https://www.chimelong.com/gz/chimelongparadise/',
          },
          {
            parkId: 'GZ52',
            name: 'Chimelong Safari Park',
            calendarURL: 'https://www.chimelong.com/gz/safaripark/?from=gz-park-paradise',
          },
          {
            parkId: 'GZ53',
            name: 'Chimelong Water Park',
            calendarURL: 'https://www.chimelong.com/gz/waterpark/',
          },
          {
            parkId: 'GZ54',
            name: 'Chimelong Birds Park',
            calendarURL: 'https://www.chimelong.com/gz/birdspark/',
          }
        ],
      },
      {
        id: 'chimelongzhuhai',
        name: 'Chimelong International Ocean Tourist Resort',
        location: {
          "latitude": 22.101,
          "longitude": 113.533
        },
        parks: [
          {
            parkId: 'ZH56',
            name: 'Chimelong Ocean Kingdom',
            calendarURL: 'https://www.chimelong.com/zh/oceankingdom/',
          },
          {
            parkId: 'ZH60',
            name: 'Chimelong Spaceship',
            calendarURL: 'https://www.chimelong.com/zh/zh-park-science/',
          }
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
    this.parkIds = [];
    this.config.destinations.forEach((destination) => {
      destination.parks.forEach((park) => {
        this.parksToDestinations[park.parkId] = destination.id;

        this.parkIds.push(park.parkId);

        this.parks.push({
          ...park,
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
    const data = await Promise.all(this.parkIds.map(async (park) => {
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

  async fetchActiveOpeningTimes({park}) {
    '@cache|1h'; // cache for 1 hour
    const calendarURL = park?.calendarURL;
    if (!calendarURL) return null;

    const resp = await this.http('GET', calendarURL);
    if (!resp.body) return null;

    // look for dates/times in format similar to:
    // 10月1日-10月3日：10:00-19:00

    const hoursTo24Format = (hours) => {
      let ret = hours;
      // if missing minutes, add :00
      if (ret.indexOf(':') === -1) ret += ':00';
      // left pad single digit hours with a 0
      if (ret.length === 4) ret = '0' + ret;
      return ret;
    };

    const regex = /(\d{1,2}月\d{1,2}日-\d{1,2}月\d{1,2}日)\s*(?:：|:)\s*(\d{1,2}:\d{1,2})-(\d{1,2}:\d{1,2})/g;
    const matches = resp.body.matchAll(regex);

    const openingTimes = [];
    let foundMatches = false;
    for (const match of matches) {
      foundMatches = true;
      const dates = match[1];
      const open = hoursTo24Format(match[2]);
      const close = hoursTo24Format(match[3]);

      const dateParts = dates.split('-');

      const startDate = dateParts[0];
      const endDate = dateParts[1];

      const startMonth = parseInt(startDate.split('月')[0]);
      const startDay = parseInt(startDate.split('月')[1].split('日')[0]);
      const endMonth = parseInt(endDate.split('月')[0]);
      const endDay = parseInt(endDate.split('月')[1].split('日')[0]);

      const now = this.getTimeNowMoment();
      const year = now.year();

      const startDateMoment = moment(`${year}-${startMonth}-${startDay}`, 'YYYY-MM-DD');
      const endDateMoment = moment(`${year}-${endMonth}-${endDay}`, 'YYYY-MM-DD');
      if (endDateMoment.isBefore(startDateMoment)) {
        endDateMoment.add(1, 'year');
      }

      for (let date = startDateMoment.clone(); date.isSameOrBefore(endDateMoment); date.add(1, 'day')) {
        openingTimes.push({
          date: date.format('YYYY-MM-DD'),
          openingTime: date.format('YYYY-MM-DD') + 'T' + open + ':00+08:00',
          closingTime: date.format('YYYY-MM-DD') + 'T' + close + ':00+08:00',
          type: scheduleType.operating,
        });
      }
    }

    // try and handle matches like "10月8日-10月31日：周一至周五：10:00-18:00；周六-周日/10月31日：10:00-19:00"
    //  which covers a range of dates with different times for different days
    // TODO - this misses complex cases where the text contains multiple ranges, and things like "all weekends this month"
    const regex2 = /(\d{1,2}月\d{1,2}日-\d{1,2}月\d{1,2}日)：(周一至周日|周一至周五|周六-周日|周六至周日)：(\d{1,2}:\d{1,2})-(\d{1,2}:\d{1,2})/g;
    const matches2 = resp.body.matchAll(regex2);

    for (const match of matches2) {
      foundMatches = true;
      const dates = match[1];
      const days = match[2];
      const open = hoursTo24Format(match[3]);
      const close = hoursTo24Format(match[4]);

      const dateParts = dates.split('-');

      const startDate = dateParts[0];
      const endDate = dateParts[1];

      const startMonth = parseInt(startDate.split('月')[0]);
      const startDay = parseInt(startDate.split('月')[1].split('日')[0]);
      const endMonth = parseInt(endDate.split('月')[0]);
      const endDay = parseInt(endDate.split('月')[1].split('日')[0]);

      const now = this.getTimeNowMoment();
      const year = now.year();

      const startDateMoment = moment(`${year}-${startMonth}-${startDay}`, 'YYYY-MM-DD');
      const endDateMoment = moment(`${year}-${endMonth}-${endDay}`, 'YYYY-MM-DD');
      if (endDateMoment.isBefore(startDateMoment)) {
        endDateMoment.add(1, 'year');
      }

      // TODO - filter on days of the week in days range
      const daysOfWeek = {
        '周一至周日': [1, 2, 3, 4, 5, 6, 0],
        '周一至周五': [1, 2, 3, 4, 5],
        '周六-周日': [6, 0],
        '周六至周日': [6, 0],
      };

      for (let date = startDateMoment.clone(); date.isSameOrBefore(endDateMoment); date.add(1, 'day')) {
        if (daysOfWeek[days].includes(date.day())) {
          openingTimes.push({
            date: date.format('YYYY-MM-DD'),
            openingTime: date.format('YYYY-MM-DD') + 'T' + open + ':00+08:00',
            closingTime: date.format('YYYY-MM-DD') + 'T' + close + ':00+08:00',
            type: scheduleType.operating,
          });
        }
      }
    }

    if (!foundMatches) {
      // no matches found, look for other formats

      // look for 园区营业时间, meaning "park operating hours"
      //  then find the next element that contains the actual times
      const parkHours = resp.body.match(/园区营业时间/);
      if (parkHours) {
        const parkHoursElement = parkHours[0];
        const parkHoursElementIndex = resp.body.indexOf(parkHoursElement);
        const nextElement = resp.body.substring(parkHoursElementIndex + parkHoursElement.length);

        // look for the next element that contains the actual times
        const nextElementMatch = nextElement.match(/(\d{1,2}:\d{1,2})-(\d{1,2}:\d{1,2})/);
        if (nextElementMatch) {
          const open = hoursTo24Format(nextElementMatch[1]);
          const close = hoursTo24Format(nextElementMatch[2]);

          const now = this.getTimeNowMoment();
          const date = now.format('YYYY-MM-DD');

          openingTimes.push({
            date: date,
            openingTime: date + 'T' + open + ':00+08:00',
            closingTime: date + 'T' + close + ':00+08:00',
            type: scheduleType.operating,
          });
        }
      }
    }

    return {
      _id: `park_${park.parkId}`,
      schedule: openingTimes,
    };
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const schedules = [];
    for (const park of this.parks) {
      const scheduleData = await this.fetchActiveOpeningTimes({
        park: park,
      });

      if (scheduleData) {
        schedules.push(scheduleData);
      }
    }

    return schedules;
  }
}
