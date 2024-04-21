// Walibi Holland has it's own API separate from bellewaerde suddenly

import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';

import moment from 'moment-timezone';

export class WalibiHolland extends Destination {
  constructor(options = {}) {
    options.name = options.name || 'Walibi Holland';
    options.timezone = options.timezone || 'Europe/Amsterdam';

    options.apiKey = options.apiKey || '';
    options.baseURL = options.baseURL || 'https://www.walibi.nl/';
    options.destinationSlug = options.destinationSlug || 'walibiholland';
    options.parkSlug = options.parkSlug || 'walibihollandpark';

    super(options);

    if (!this.config.apiKey) throw new Error('Missing Walibi Holland API key');
    if (!this.config.baseURL) throw new Error('Missing Walibi Holland baseURL');

    // setup some API hooks
    const baseURLHostname = new URL(this.config.baseURL).hostname;

    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      // inject our API key into all requests to this domain
      options.headers = options.headers || {};
      options.headers['x-api-key'] = this.config.apiKey;
    });
  }

  /**
   * Fetch all POI data for this destination
   * @returns {object}
   */
  async fetchAttractionsPOI() {
    '@cache|1d'; // cache for 1 day
    const poi = await this.http('GET', `${this.config.baseURL}api/who/en/attractions.v1.json`);
    return poi.body;
  }

  /**
   * Fetch all restaurant POI data for this destination
   * @returns {object}
   */
  async fetchRestaurantsPOI() {
    '@cache|1d'; // cache for 1 day
    const poi = await this.http('GET', `${this.config.baseURL}api/who/en/restaurants.v1.json`);
    return poi.body;
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
      if (data.title) entity.name = data.title;
      if (data.longiture && data.latitude) {
        entity.location = {
          longitude: Number(data.longitude),
          latitude: Number(data.latitude),
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
        _id: this.config.parkSlug,
        _destinationId: this.config.destinationSlug,
        _parentId: this.config.destinationSlug,
        name: this.config.name,
        entityType: entityType.park,
      }
    ];
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    // get POI data
    const poi = await this.fetchAttractionsPOI();

    // build entities
    return poi.map((x, idx) => {
      const entity = this.buildBaseEntityObject(x);
      return {
        ...entity,
        // use the array idx as our unique ID... not ideal but it's all we have
        //  Walibi API doesn't provide any kind of unique IDs for attractions
        _id: `attr_${idx}`,
        _parentId: this.config.parkSlug,
        _destinationId: this.config.destinationSlug,
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
    // get POI data
    const poi = await this.fetchRestaurantsPOI();

    // build entities
    return poi.map((x, idx) => {
      const entity = this.buildBaseEntityObject(x);
      return {
        ...entity,
        // use the array idx as our unique ID... not ideal but it's all we have
        //  Walibi API doesn't provide any kind of unique IDs for attractions
        _id: `dining_${idx}`,
        _parentId: this.config.parkSlug,
        _destinationId: this.config.destinationSlug,
        entityType: entityType.restaurant,
      };
    });
  }

  async fetchLiveData() {
    '@cache|1m'; // cache for 1 minute
    const resp = await this.http('GET', `${this.config.baseURL}api/who/waitingtimes.v1.json`);
    return resp.body;
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const attractionData = await this.fetchAttractionsPOI();
    const waitData = await this.fetchLiveData();

    // this function should return all the live data for all entities in this destination
    return waitData.map((entry) => {
      // find matching attraction data
      const attractionIdx = attractionData.findIndex((x) => x.waitingTimeName === entry.id);
      if (attractionIdx === -1) {
        return null;
      }

      const data = {
        _id: `attr_${attractionIdx}`,
        status: statusType.operating,
      };

      switch (entry.status) {
        case 'closed':
        case 'closed_indefinitely':
        case 'full_and_closed':
          data.status = statusType.closed;
          break;
        case 'not_operational':
          // (at time of writing) this is used for "Blast" and a dummy ride
          return null;
        case 'full': // ride if open, but the queue is full
          data.status = statusType.down;
          // waitTimeMins will be 0, so don't return a queue at all!
          break;
        case 'open':
          data.status = statusType.operating;
          // parse wait time
          let waitTime = Number(entry.time || 0);
          if (waitTime > 0) {
            // convert from seconds to minutes
            waitTime = waitTime / 60;
          }
          data.queue = {
            [queueType.standBy]: {
              waitTime: Math.floor(waitTime),
            },
          };
          break;
        default:
          // unknown ride status - assume open but with no queue... ?
          data.status = statusType.operating;
          console.error('error', entry.id, `Unknown ride status ${entry.status} for ${entry.id}`, entry);
          debugger;
          break;
      }

      return data;
    }).filter((x) => !!x);
  }

  async fetchCalendar() {
    '@cache|1d'; // cache for 1 day
    const resp = await this.http('GET', `${this.config.baseURL}api/who/nl/openinghours.v1.json`);
    return resp.body;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const calendarData = await this.fetchCalendar();

    const schedule = [];
    // loop calendar KEYS for each year
    for (const year in calendarData.calendar) {
      for (const monthKey in calendarData.calendar[year].months) {
        const month = calendarData.calendar[year].months[monthKey];
        const monthNum = month.monthNumber;
        for (const dayKey in month.days) {
          const day = month.days[dayKey];

          // skip closed days
          if (day.closed) {
            continue;
          }

          // build date string padding month/day
          const date = `${year}-${monthNum.toString().padStart(2, '0')}-${dayKey.toString().padStart(2, '0')}`;
          const momentObj = moment.tz(date, this.config.timezone);
          const splitTime = (time) => {
            const parts = time.split(':');
            return {
              hour: Number(parts[0]),
              minute: Number(parts[1]),
            };
          };
          const openingTime = splitTime(day.openingHour);
          const closingTime = splitTime(day.closingHour);

          const openingObj = momentObj.clone().hour(openingTime.hour).minute(openingTime.minute);
          const closingObj = momentObj.clone().hour(closingTime.hour).minute(closingTime.minute);

          const openingTimeStr = openingObj.format();
          const closingTimeStr = closingObj.format();

          // add to schedule
          schedule.push({
            date: date,
            openingTime: openingTimeStr,
            closingTime: closingTimeStr,
            type: scheduleType.operating,
          });
        }
      }
    }

    return [
      {
        _id: this.config.parkSlug,
        schedule,
      }
    ];
  }

  async unittest_attractionIdStability(logSuccess, logError) {
    const ids = [
      {_id: 'attr_18', _name: 'Lost Gravity'},
      {_id: 'attr_1', _name: 'Eat my Dust'},
      {_id: 'attr_20', _name: 'El Rio Grande'},
      {_id: 'attr_28', _name: 'Goliath'},
      {_id: 'attr_26', _name: 'UNTAMED'},
      {_id: 'attr_17', _name: 'Space Shot'},
      {_id: 'attr_24', _name: 'Speed Of Sound'},
      {_id: 'attr_19', _name: 'Xpress: Platform 13'},
      {_id: 'attr_12', _name: 'Crazy River'},
      {_id: 'attr_11', _name: 'Condor'},
      {_id: 'attr_22', _name: 'Blast'},
      {_id: 'attr_25', _name: "Merlin's Magic Castle"}
    ];

    let attractionsUnstable = false;

    // get all attraction entities
    const ents = await this.buildAttractionEntities();
    // test each _id and name
    for (const data of ids) {
      const ent = ents.find((x) => x._id === data._id);
      if (!ent) {
        logError(`Missing entity ${data._id} - no longer present in API`);
        attractionsUnstable = true;
      } else {
        // check name still matches
        if (ent.name != data._name) {
          logError(`Name mismatch for ${data._id}: ${ent.name} != ${data._name}`);
          attractionsUnstable = true;
        } else {
          logSuccess(`${data._id} - ${data._name}`);
        }
      }
    }

    if (attractionsUnstable) {
      throw new Error('Attraction IDs are unstable');
    } else {
      logSuccess('Attraction IDs are currently stable for Walibi Holland');
    }
  }
}
