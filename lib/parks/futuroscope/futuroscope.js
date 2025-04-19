import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';

import {v4 as uuidv4} from 'uuid';
import * as cheerio from 'cheerio';
import moment from 'moment-timezone';

export class Futuroscope extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Europe/Paris';

    options.baseURL = options.baseURL || '';

    super(options);

    if (!this.config.baseURL) throw new Error('Missing baseURL');


    // inject into API calls
    const baseURLHostname = new URL(this.config.baseURL).hostname;
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      // if we're not the auth request, add our token
      if (!options._authRequest) {
        const token = await this._getAPIToken();

        if (token) {
          if (!options.headers) {
            options.headers = {};
          }
          options.headers['token'] = token;
        }
      }
    });
  }

  /**
   * Get or fetch our API token
   * @returns {string}
   */
  async _getAPIToken() {
    '@cache|30d';

    // generate a random 13 character token made up of 0-9a-f
    //  this is used to create a session
    const randomToken = Math.random().toString(16).slice(2, 15);
    const randomUUID = uuidv4();
    const url = `${this.config.baseURL}/api/sessions/create/${randomToken}`;

    const resp = await this.http('POST', url, {
      session: {
        language: "en",
        device_name: "web",
        device_version: "REL",
        os_name: "Android",
        app_version: "3.7.17",
        uid: randomUUID,
        push_token: "none",
      },
    }, {
      json: true,
      _authRequest: true,
    });

    return `${resp.body.token}`;
  }

  /**
   * Get the raw POI data from the API
   * @returns {object}
   */
  async getPOIData() {
    '@cache|12h';

    const url = `${this.config.baseURL}/api/poi`;
    const resp = await this.http('GET', url, null, {
      json: true,
    });
    return resp.body;
  }

  /**
   * Get latest realtime data
   * @returns {object}
   */
  async fetchLiveData() {
    '@cache|1m'; // cache for 1 minute
    const url = `${this.config.baseURL}/api/poi/get-realtime-datas`;
    const resp = await this.http('GET', url, null, {
      json: true,
    });
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

    if (data && data.id && data.title) {
      entity._id = data.id;

      if (data.title) {
        entity.name = data.title;
      }

      if (data.latitude && data.longitude) {
        entity.location = {
          latitude: Number(data.latitude),
          longitude: Number(data.longitude),
        };

        // if lon/lat are not numbers, remove them from the entity
        if (isNaN(entity.location.latitude) || isNaN(entity.location.longitude)) {
          delete entity.location;
        }
      }

      entity._parkId = 'futuroscope';
      entity._destinationId = 'futuroscopedestination';
      entity._parentId = 'futuroscope';
    }

    entity.timezone = this.config.timezone;

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    const doc = {};
    return {
      ...this.buildBaseEntityObject(doc),
      _id: 'futuroscopedestination',
      slug: 'futuroscope', // all destinations must have a unique slug
      name: "Futuroscope",
      entityType: entityType.destination,
      location: {
        latitude: 46.667013,
        longitude: 0.367956,
      },
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    return [
      {
        ...this.buildBaseEntityObject(null),
        _id: 'futuroscope',
        _destinationId: 'futuroscopedestination',
        _parentId: 'futuroscopedestination',
        name: "Futuroscope",
        entityType: entityType.park,
        location: {
          latitude: 46.667013,
          longitude: 0.367956,
        },
      }
    ];
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const poiData = await this.getPOIData();

    const attractions = poiData.poi.filter((poi) => {
      return poi.type === 'attraction' && poi.theme != 'Shows';
    });
    const entities = attractions.map((attraction) => {
      return {
        ...this.buildBaseEntityObject(attraction),
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
      };
    });
    return entities.filter((attraction) => {
      return attraction._id && attraction.name;
    });
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    const poiData = await this.getPOIData();

    const shows = poiData.poi.filter((poi) => {
      return poi.type === 'attraction' && poi.theme == 'Shows';
    });
    const entities = shows.map((show) => {
      return {
        ...this.buildBaseEntityObject(show),
        entityType: entityType.show,
      };
    });
    return entities.filter((show) => {
      return show._id && show.name;
    });
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
    const liveData = await this.fetchLiveData();
    // get all entities
    const entities = await this.getAllEntities();

    return liveData.map((data) => {
      // ignore any data that has no poiData
      const poi = entities.find((poi) => {
        return poi._id === data.id;
      });
      if (!poi) {
        return null;
      }

      const liveDataObj = {
        _id: data.id,
        status: statusType.operating,
      };

      // scan status text for info
      const foundClosedText = data.infos.texts.find((text) => {
        return text.toLowerCase().includes('closed');
      });

      if (!foundClosedText) {
        // open
        liveDataObj.status = statusType.operating;
        liveDataObj.queue = {
          [queueType.standBy]: {
            waitTime: data.minutes_left,
          },
        };
      } else {
        const tempClosedText = data.infos.texts.find((text) => {
          return text.toLowerCase().includes('temp');
        });
        if (tempClosedText) {
          // temporarily closed
          liveDataObj.status = statusType.down;
        } else {
          // closed
          liveDataObj.status = statusType.closed;
        }
      }

      return liveDataObj;
    }).filter((data) => {
      return data !== null;
    });
  }

  /** Fetch the raw calendar HTML for the park */
  async _fetchCalendarHTML() {
    '@cache|1d';
    const url = 'https://www.futuroscope.com/en/practical-info/park-opening-hours-and-calendar';
    const resp = await this.http('GET', url);
    return resp.body;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const html = await this._fetchCalendarHTML();

    // find JSON object
    // <script>self.__next_f.push([1,"20:[\"$\",\"$L2a\",null,{\"items\":
    // ...
    // o\":\"Plus d’informations\"}}]\n"])</script><script

    // find the script tag with the calendar data
    const $ = cheerio.load(html);

    // find all <script> tags and find the one that contains the calendar data
    const scriptTags = $('script');
    const calendarScriptTags = scriptTags.filter((i, el) => {
      return $(el).html().includes('self.__next_f.push') && $(el).html().includes('\\"items\\"') && $(el).html().includes('\\"schedule\\"');
    });

    // test each tag for the JSON data
    let JSONData = null;
    for (const tag of calendarScriptTags) {
      const scriptContent = $(tag).html();
      const jsonMatch = scriptContent.match(/({\\"items\\".*)\]\\n\"\]/s);
      if (jsonMatch) {
        // remove slashes and newlines
        const cleanedJSON = jsonMatch[1].replace(/\\/g, '').replace(/\n/g, '');
        // parse the JSON data
        JSONData = JSON.parse(cleanedJSON);
        break;
      }
    }
    if (!JSONData) {
      throw new Error('Failed to find calendar JSON data');
    }

    // parse the JSON data and generate schedules
    const scheduleItems = JSONData.items.filter((x) => {
      return x.type === 'schedule' && x.detailsSchedule && x.detailsSchedule.space === 'Futuroscope';
    }).map((x) => {
      return {
        ...x,
        openingTime: x.detailsSchedule?.hours?.from,
        closingTime: x.detailsSchedule?.hours?.to,
      };
    }).filter((x) => {
      return x.openingTime && x.closingTime;
    }).map((x) => {
      const openObj = x.openingTime.split(':').map(Number);
      const closeObj = x.closingTime.split(':').map(Number);
      return {
        ...x,
        open: openObj,
        close: closeObj,
      };
    });

    const findMatchingPeriod = (date) => {
      // find the scheduleItems for this date
      //  each scheduleItem has an array of periods
      /* eg.
      [
        {
          from: "2024-10-19T00:00:00",
          to: "2024-11-01T00:00:00",
        },
        {
          from: "2024-11-01T00:00:00",
          to: "2024-11-03T00:00:00",
        },
      ]*/
      const scheduleItemForDate = scheduleItems.find((item) => {
        return item.periods.find((x) => {
          const startDate = moment(x.from).tz(this.config.timezone, true);
          const endDate = moment(x.to).tz(this.config.timezone, true);
          const startDateTime = startDate.startOf('day');
          const endDateTime = endDate.add(-1, 'days').endOf('day');
          const dateTime = moment(date).tz(this.config.timezone).startOf('day');
          return dateTime.isBetween(startDateTime, endDateTime, 'Day', '[]');
        });
      });

      return scheduleItemForDate;
    };

    const schedule = [];

    // loop over next 120 days
    let date = this.getTimeNowMoment();
    date.set({
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    })
    for (let i = 0; i < 120; i++) {
      const scheduleItem = findMatchingPeriod(date);
      if (scheduleItem) {
        schedule.push({
          date: date.format('YYYY-MM-DD'),
          openingTime: date.clone().set({
            hour: scheduleItem.open[0],
            minute: scheduleItem.open[1],
          }).format(),
          closingTime: date.clone().set({
            hour: scheduleItem.close[0],
            minute: scheduleItem.close[1],
          }).format(),
          type: "OPERATING",
        });
      }
      date = date.add(1, 'day');
    }


    return [
      {
        _id: 'futuroscope',
        schedule,
      },
    ];
  }
}
