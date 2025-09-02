import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import * as cheerio from 'cheerio';
import moment from 'moment-timezone';

// cultures in a rough priority order
//  destinations can override the default culture
//  by setting the preferredCulture property
const cultures = [
  'en',
  'nl',
  'de',
  'fr',
  'es',
  'it',
];

// data to be injected into the entity when it is missing from the app database
//  if the app supplies data.[key], then this will be ignored
const fallbackMissingData = [
  {
    match: {
      _id: '177837',
      _parkId: 'parquesreunidos_1109_park',
    },
    data: {
      location: {
        latitude: 51.20030731099587,
        longitude: 4.906631289468816,
      },
    },
  }
];

export class ParcsReunidosDestination extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Europe/Brussels';

    // options.apiKey = options.apiKey || '';
    options.appId = options.appId || '';
    options.baseURL = options.baseURL || 'https://api-manager.stay-app.com';
    options.authToken = options.authToken || '';
    options.stayEstablishment = options.stayEstablishment || '';
    options.calendarURL = options.calendarURL || '';

    options.preferredCulture = options.preferredCulture || cultures[0];

    // allow all stayapp destinations to share the same config
    options.configPrefixes = ['STAYAPP'];

    super(options);

    // if (!this.config.apiKey) throw new Error('Missing apiKey');
    if (!this.config.appId) throw new Error('Missing appId');
    if (!this.config.authToken) throw new Error('Missing authToken');
    if (!this.config.stayEstablishment) throw new Error('Missing stayEstablishment');
    if (!this.config.calendarURL) throw new Error('Missing calendarURL');

    const baseURLHostname = new URL(this.config.baseURL).hostname;
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      // inject our auth token into all requests to this domain
      options.headers = options.headers || {};

      const token = await this.getAuthToken();
      if (!token) {
        throw new Error('Error getting API key');
      }

      options.headers['Authorization'] = 'Bearer ' + token;
      options.headers['Stay-Establishment'] = this.config.stayEstablishment;
    });
  }


  /** Get the auth token needed for the API */
  async getAuthToken() {
    return this.config.authToken;
  }

  /** Helper function to get the preferred culture from an object of translated strings */
  _getPreferredCulture(obj, fallback = '') {
    // if obj is string, return it
    if (typeof obj === 'string') {
      return obj;
    }

    if (obj[this.config.preferredCulture]) {
      return obj[this.config.preferredCulture];
    }

    for (const culture of cultures) {
      if (obj[culture]) {
        return obj[culture];
      }
    }

    return fallback;
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
      entity._id = `${data.id}`;

      entity.name = this._getPreferredCulture(data.translatableName, 'unknown_' + entity.id);

      if (data.place && data.place.point) {
        entity.location = {
          latitude: data.place.point.latitude,
          longitude: data.place.point.longitude,
        }
      }
    }

    // fill in entity heirarchy
    entity._destinationId = this._getDestinationID();
    entity._parkId = this._getParkID();
    entity._parentId = this._getParkID();

    entity.timezone = this.config.timezone;

    // check for missing data
    //  if the entity is missing data, fill it in from the fallbackMissingData array
    for (const fallback of fallbackMissingData) {
      const matchReq = fallback.match;
      // check each field of the matchReq object
      let match = true;
      for (const key in matchReq) {
        if (entity[key] !== matchReq[key]) {
          match = false;
          break;
        }
      }

      if (match) {
        // fill in the data
        for (const key in fallback.data) {
          if (!entity[key]) {
            entity[key] = fallback.data[key];
          }
        }
      }
    }

    return entity;
  }

  _getDestinationID() {
    return 'parquesreunidos_' + this.config.appId;
  }

  _getParkID() {
    return 'parquesreunidos_' + this.config.appId + '_park';
  }

  async _getParkLocation() {
    const parkData = await this._fetchParkInfo();

    if (parkData.coordinates && parkData.coordinates.latitude && parkData.coordinates.longitude) {
      return {
        latitude: parkData.coordinates.latitude,
        longitude: parkData.coordinates.longitude,
      };
    }
    return undefined;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    const parkData = await this._fetchParkInfo();

    const destinationObj = {
      _id: this._getDestinationID(),
      // remove any non-alphanumeric characters
      slug: parkData.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(),
      name: parkData.name,
      entityType: entityType.destination,
      timezone: this.config.timezone,
      location: await this._getParkLocation(),
    };

    return destinationObj;
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    const parkData = await this._fetchParkInfo();

    return [
      {
        _id: this._getParkID(),
        _destinationId: this._getDestinationID(),
        _parentId: this._getDestinationID(),
        name: parkData.name,
        entityType: entityType.park,
        timezone: this.config.timezone,
        location: await this._getParkLocation(),
      }
    ];
  }

  async _fetchParkInfo() {
    '@cache|12h'; // cache for 12 hours
    const resp = await this.http('GET', `${this.config.baseURL}/api/v1/establishment/${this.config.appId}`);

    return resp.body.data;
  }

  async _fetchAttractions() {
    '@cache|1m'; // cache for 1 minute
    const resp = await this.http('GET', `${this.config.baseURL}/api/v1/service/attraction`);

    return resp.body.data;
  }

  async _fetchRestaurants() {
    '@cache|12h'; // cache for 12 hours
    const resp = await this.http('GET', `${this.config.baseURL}/api/v1/service/restaurant`);

    return resp.body.data;
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const poiData = await this._fetchAttractions();

    return poiData.filter((x) => {
      // filter out any attractions we don't want
      return true;
    }).map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
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
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const attractionData = await this._fetchAttractions();

    return attractionData.filter((x) => {
      // filter out any attractions we don't want
      return true;
    }).map((x) => {
      if (x.waitingTime === undefined) {
        return null;
      }

      const liveData = {
        _id: `${x.id}`,
        status: statusType.operating,
      };

      if (x.waitingTime < 0) {
        if (x.waitingTime === -2) {
          liveData.status = statusType.down;
        } else if (x.waitingTime === -3) {
          liveData.status = statusType.closed;
        } else {
          // unknown status, assume closed if < 0
          liveData.status = statusType.closed;
        }
      } else {
        liveData.queue = {
          [queueType.standBy]: {
            waitTime: x.waitingTime,
          }
        };
      }

      return liveData;
    }).filter((x) => {
      return !!x;
    });
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async fetchCalendarHTML() {
    '@cache|1d'; // cache for 1 day
    const resp = await this.http('GET', this.config.calendarURL);
    return resp.body;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const html = await this.fetchCalendarHTML();
    const $ = cheerio.load(html);

    const currentYear = moment().tz(this.config.timezone).year();
    const nextYear = currentYear + 1;

    // first get the labels data from the calendar
    // eg. <input type="hidden" id="data-hour-labels" value="[{&#34;h&#34;:&#34;10am - 5pm&#34;},{&#34;b&#34;:&#34;10am - 6pm&#34;},{&#34;e&#34;:&#34;12pm - 8pm&#34;},{&#34;k&#34;:&#34;Movie Park\u0027s Hollywood Christmas&#34;},{&#34;g&#34;:&#34;10am - 9pm&#34;},{&#34;d&#34;:&#34;10am - 10pm&#34;},{&#34;r&#34;:&#34;Park closed&#34;},{&#34;n&#34;:&#34;Halloween Horror Festival&#34;}]"/>
    //  this is a list of labels for the opening hours
    const hourLabels = [];
    const labelsData = $('#data-hour-labels').val();
    if (labelsData) {
      // Define an array of time range parsers
      const timeRangeParsers = [
        {
          // format eg. 10am - 5pm
          regex: /^(\d{1,2})(am|pm)\s*-\s*(\d{1,2})(am|pm)$/,
          parse: (match) => {
            const startHour = moment(match[1], 'h').add(match[2] === 'pm' ? 12 : 0, 'hours');
            const endHour = moment(match[3], 'h').add(match[4] === 'pm' ? 12 : 0, 'hours');

            // Handle 12pm special case
            if (match[1] === '12' && match[2] === 'pm') {
              startHour.add(12, 'hours');
            }

            return {
              start: startHour.format('HH:mm'),
              end: endHour.format('HH:mm'),
            };
          },
        },
        {
          // format eg. 10 tot 5u
          regex: /^(\d{1,2})\s*tot\s*(\d{1,2})\s*u$/,
          parse: (match) => {
            const startHour = moment(match[1], 'h');
            const endHour = moment(match[2], 'h');

            // Handle 12pm special case
            if (match[1] === '12') {
              startHour.add(12, 'hours');
            }

            return {
              start: startHour.format('HH:mm'),
              end: endHour.format('HH:mm'),
            };
          },
        },
        {
          // format eg. 10:30 - 17:00
          regex: /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/,
          parse: (match) => {
            const startHour = moment(match[1], 'HH:mm');
            const endHour = moment(match[2], 'HH:mm');

            return {
              start: startHour.format('HH:mm'),
              end: endHour.format('HH:mm'),
            };
          },
        },
        {
          // format eg: Summer: 11 a.m. – 7 p.m.
          regex: /(\d{1,2})\s*(a\.m\.|p\.m\.)\s*(?:–|-)\s*(\d{1,2})\s*(a\.m\.|p\.m\.)/,
          parse: (match) => {
            const startHour = moment(match[1], 'h').add(match[2] === 'p.m.' ? 12 : 0, 'hours');
            const endHour = moment(match[3], 'h').add(match[4] === 'p.m.' ? 12 : 0, 'hours');

            // Handle 12pm special case
            if (match[1] === '12' && match[2] === 'p.m.') {
              startHour.add(12, 'hours');
            }

            let type = match[1].trim();
            // strip out known seasonal types, leave undefined so this becomes regular park hours
            if (type === 'Summer' || type === 'Winter' || type === 'Spring' || type === 'Autumn') {
              type = undefined;
            }

            return {
              start: startHour.format('HH:mm'),
              end: endHour.format('HH:mm'),
              type,
            };
          },
        },
        {
          // format eg: Parque Warner Beach - 12:00 a 20:00
          // also capture the park name
          regex: /^(.*)\s*-\s*(\d{1,2}:\d{2})\s*a\s*(\d{1,2}:\d{2})$/,
          parse: (match) => {
            const startHour = moment(match[2], 'HH:mm');
            const endHour = moment(match[3], 'HH:mm');

            return {
              start: startHour.format('HH:mm'),
              end: endHour.format('HH:mm'),
              type: match[1].trim(),
            };
          },
        },
        {
          // format eg. Halloween Scary Nights - 22:00 - 03:00
          regex: /^(.*)\s*-\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/,
          parse: (match) => {
            const startHour = moment(match[2], 'HH:mm');
            const endHour = moment(match[3], 'HH:mm');

            return {
              start: startHour.format('HH:mm'),
              end: endHour.format('HH:mm'),
              type: match[1].trim(),
            };
          },
        },
        {
          // format eg. 12:00 - 00:00 (Aforo Completo)
          regex: /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*\((.*?)\)$/,
          parse: (match) => {
            const startHour = moment(match[1], 'HH:mm');
            const endHour = moment(match[2], 'HH:mm');

            return {
              start: startHour.format('HH:mm'),
              end: endHour.format('HH:mm'),
              type: match[3].trim(),
            };
          },
        },
        {
          // format eg. 10:30 - 24:00 Halloween
          regex: /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*(.*?)$/,
          parse: (match) => {
            const startHour = moment(match[1], 'HH:mm');
            const endHour = moment(match[2], 'HH:mm');

            return {
              start: startHour.format('HH:mm'),
              end: endHour.format('HH:mm'),
              type: match[3].trim(),
            };
          },
        }
      ];

      try {
        const parsedLabels = JSON.parse(labelsData);
        for (const label of parsedLabels) {
          // label is an object with a key and a value
          //  we want to keep the key and the value
          for (const key in label) {
            let foundHours = false;

            for (const parser of timeRangeParsers) {
              const match = label[key].match(parser.regex);
              if (match) {
                hourLabels[key] = {
                  ...parser.parse(match),
                  originalLabel: label[key],
                };
                foundHours = true;
                break; // Stop checking other parsers once a match is found
              }
            }

            if (!foundHours) {
              // if there are any numbers, debugger
              const numbers = label[key].match(/\d+/g);
              if (numbers) {
                // if there are any numbers, log the label
                console.warn('Unknown time range format:', label[key]);
              } else {
                // if there are no numbers, log the label
                //console.warn('Unknown label format:', label[key]);
              }
            }
          }
        }
      } catch (e) {
        console.error('Error parsing schedule labels data', e);
      }
    }

    const rawData = [];
    // parse current and next year data
    //  data sits inside a hidden input called "data-hour-{YEAR}"
    // eg. <input type="hidden" id="data-hour-2025" value="[{&#34;1&#34;:&#34;r&#34;,&#34;2&#34;:&#34;r&#34;,&#34;3&#34;:&#34;r&#34;,&#34;4&#34;:&

    for (const year of [currentYear, nextYear]) {
      const data = $('#data-hour-' + year).val();
      if (data) {
        try {
          const parsedData = JSON.parse(data);
          rawData.push({
            year: year,
            data: parsedData,
          });
        } catch (e) {
          this.log.error('Error parsing schedule data for year ' + year, e);
        }
      }
    }

    const parkSchedules = [];

    // loop through the data and build a schedule object
    //  for each day of the year
    for (const yearData of rawData) {
      const year = yearData.year;
      const monthsData = yearData.data;

      // arrayindex is the month (0-11)
      // each month is an object of keys -> label
      monthsData.forEach((monthData, monthIndex) => {
        // monthIndex is 0-11, so we need to add 1 to get the month number
        const month = monthIndex + 1;

        // loop through the days of the month
        for (const day in monthData) {
          const dayData = monthData[day];

          // build date string by padding the month and day with 0s
          const paddedMonth = String(month).padStart(2, '0');
          const paddedDay = String(day).padStart(2, '0');
          // build the date string
          const dateStr = `${year}-${paddedMonth}-${paddedDay}`;

          // ignore if date is in the past
          const today = moment().startOf('day');
          if (moment(dateStr).isBefore(today)) {
            continue;
          }

          // dayData can contain multiple keys, separated by commas
          // split them and keep any that match the hourLabels keys
          const keys = dayData.split(',');
          // remove any keys that are not in hourLabels
          const validKeys = keys.filter((key) => {
            return hourLabels[key];
          });
          // if there are no valid keys, skip this day
          if (validKeys.length === 0) {
            continue;
          }

          const schedulesForDate = [];

          // for each valid key...
          for (const key of validKeys) {
            // get the opening hours for this day
            const hours = hourLabels[key];
            if (!hours) {
              continue;
            }

            const openingTime = moment.tz(dateStr + 'T' + hours.start, 'YYYY-MM-DDTHH:mm', this.config.timezone);
            const closingTime = moment.tz(dateStr + 'T' + hours.end, 'YYYY-MM-DDTHH:mm', this.config.timezone);

            // ignore nonsense dates (some parks list 31st June for example)
            if (!openingTime.isValid() || !closingTime.isValid()) {
              continue;
            }

            schedulesForDate.push({
              date: dateStr,
              openingTime: openingTime.format(),
              closingTime: closingTime.format(),
              type: hours.type ? scheduleType.informational : scheduleType.operating,
              description: hours.type || undefined,
            });
          }

          // if there is only one entry for this date, make sure it has an "operating" type
          if (schedulesForDate.length == 1) {
            schedulesForDate[0].type = scheduleType.operating;
          }

          parkSchedules.push(...schedulesForDate);
        }
      });
    }

    // for each date in parkSchedules, check for duplicates

    return [{
      _id: this._getParkID(),
      schedule: parkSchedules,
    }];
  }
}

export class MovieParkGermany extends ParcsReunidosDestination {
  constructor(options = {}) {
    options.name = options.name || 'Movie Park Germany';
    options.timezone = options.timezone || 'Europe/Berlin';
    options.calendarURL = options.calendarURL || 'https://www.movieparkgermany.de/en/oeffnungszeiten-und-preise/oeffnungszeiten';

    super(options);
  }
}

// bobbejaanland

export class Bobbejaanland extends ParcsReunidosDestination {
  constructor(options = {}) {
    options.name = options.name || 'Bobbejaanland';
    options.timezone = options.timezone || 'Europe/Brussels';
    options.calendarURL = options.calendarURL || 'https://www.bobbejaanland.be/openingsuren-en-prijzen/openingsuren';

    super(options);
  }
}

// Mirabilandia

export class Mirabilandia extends ParcsReunidosDestination {
  constructor(options = {}) {
    options.name = options.name || 'Mirabilandia';
    options.timezone = options.timezone || 'Europe/Rome';
    options.calendarURL = options.calendarURL || 'https://www.mirabilandia.it/en/calendario-e-tariffe/calendario-di-apertura';

    super(options);
  }
}

// Parque de Atracciones Madrid

export class ParqueDeAtraccionesMadrid extends ParcsReunidosDestination {
  constructor(options = {}) {
    options.name = options.name || 'Parque de Atracciones Madrid';
    options.timezone = options.timezone || 'Europe/Madrid';
    options.calendarURL = options.calendarURL || 'https://www.parquedeatracciones.es/en/horarios';

    super(options);
  }
}

// Parque Warner Madrid
export class ParqueWarnerMadrid extends ParcsReunidosDestination {
  constructor(options = {}) {
    options.name = options.name || 'Parque Warner Madrid';
    options.timezone = options.timezone || 'Europe/Madrid';
    options.calendarURL = options.calendarURL || 'https://www.parquewarner.com/en/horarios-y-precios/horarios';

    super(options);
  }
}

// Kennywood Amusement Park
export class Kennywood extends ParcsReunidosDestination {
  constructor(options = {}) {
    options.name = options.name || 'Kennywood Amusement Park';
    options.timezone = options.timezone || 'America/New_York';
    options.calendarURL = options.calendarURL || 'https://www.kennywood.com/operating-hours---prices/operating-hours-';

    super(options);
  }
}
