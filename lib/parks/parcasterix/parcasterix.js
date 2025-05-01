import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import moment from 'moment-timezone';

// zip lib adm-zip
import AdmZip from 'adm-zip';

// node:sqlite
import sqlite from 'node:sqlite';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';

export class ParcAsterix extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Europe/Paris';

    options.apiBase = options.apiBase || '';
    options.language = options.language || 'en';

    // bump cache version when we need to wipe our cached query state
    options.cacheVersion = options.cacheVersion || 2;

    super(options);

    if (!this.config.apiBase) throw new Error('Missing apiBase');
  }

  /**
   * Make a simple GraphQL query against the API
   * @param {string} query 
   * @param {object} options
   * @returns {object} JSON response from API
   */
  async makeGraphQLQuery(query, {
    headers = {},
  } = {}) {
    const resp = (await this.http(
      'POST',
      `${this.config.apiBase}graphql`,
      {
        query,
        variables: {},
      },
      {
        headers: {
          'Content-Type': 'application/json',
          ...headers || {},
        },
      },
    )).body;

    if (resp?.errors) {
      if (resp.errors[0] && resp.errors[0].message) {
        throw new Error(`makeGraphQLQuery error: ${resp.errors[0].message}`);
      }
      throw new Error(`makeGraphQLQuery error: ${JSON.stringify(resp.errors)}`);
    }

    return resp;
  }

  /**
   * Get the current local database version
   * @returns {string}
   */
  async getLocalDatabaseVersion() {
    const cachedValue = await this.cache.get('localDatabaseVersion');
    if (cachedValue) {
      return cachedValue;
    }

    // return a default version that is guaranteed to be lower than the live version
    return '1.1.29';
  }

  /**
   * Get some key resort data
   * @returns {object}
   */
  async getLiveDatabaseVersion() {
    // cache for 1 hour
    '@cache|1h';

    const currentVersion = await this.getLocalDatabaseVersion();

    const query = `query offlinePackageLast {
  offlinePackageLast {
    id
    version
    fileSize
    md5Signature
    builtAt
    url
    autoDownload
    forcePush
  }
}`;

    const liveDatabaseData = await this.makeGraphQLQuery(query,
      {
        headers: {
          'x-package-version': currentVersion,
        }
      }
    );

    return {
      currentVersion,
      liveVersion: liveDatabaseData.data.offlinePackageLast.version,
      url: liveDatabaseData.data.offlinePackageLast.url,
    };
  }

  /**
   * Download a POI archive from a URL
   * @param {string} url 
   * @returns {buffer}
   */
  async _downloadPOIArchive(url) {
    // cache for 30 days. Memoized by URL
    '@cache|30d';

    this.log(`Downloading POI archive from ${url}`);
    const data = await this.http('GET', url);
    if (!data || !data.body) {
      this.error(`Failed to download POI archive from ${url}`);
      return;
    }
    this.log(`Status: ${data.statusCode}`);
    this.log(`Downloaded ${data.body.length} bytes`);

    return data.body;
  }

  /**
   * Load a POI database from a zip file. Return useful POI data in JSON format
   * @param {object} entry 
   */
  async _loadPOIDatabase(entry) {
    // dump zip entry to file for loading
    const tmpFile = path.join(tmpdir(), `${entry.entryName}.sqlite`);
    await fs.writeFile(tmpFile, entry.getData());

    // open the database
    const db = await new sqlite.DatabaseSync(tmpFile);

    // query the database
    const attractionData = db.prepare('SELECT drupal_id, title, experience, latitude, longitude, min_age, min_size, min_size_unaccompanied FROM attractions').all();
    const restaurantData = db.prepare('SELECT drupal_id, title, meal_types, latitude, longitude, menu_url, mobile_url FROM restaurants').all();
    const showData = db.prepare('SELECT drupal_id, title, duration, latitude, longitude FROM shows').all();

    // TODO - grab schedule data from database
    // get today's date in YYYY-MM-DD format
    const now = this.getTimeNowMoment().format('YYYY-MM-DD');
    const schedules = db.prepare('SELECT * FROM calendar_items WHERE day >= ?').all(now);

    // find all our opening times in labels table, each row will have a key similar to calendar.dateType.legend.D
    const labels = db.prepare('SELECT key, value FROM labels WHERE key LIKE \'calendar.dateType.legend.%\'').all();

    // helper function to convert 9:30 p.m. to {hour: 21, minute: 30} etc.
    const stringHoursToNumbers = (str) => {
      const match = str.match(/(\d+):(\d+)\s*(?:am|pm|a\.m|p\.m|h|hr)/);
      if (match) {
        str = str.replace(/([ap])\.m\.?/g, '$1m');
        // if we're in pm, add 12 hours
        if (str.indexOf('pm') >= 0 && match[1] !== '12') {
          const hourVal = parseInt(match[1], 10);
          if (hourVal < 12) {
            match[1] = hourVal + 12;
          }
        }

        return {
          hour: parseInt(match[1], 10),
          minute: parseInt(match[2], 10),
        };
      } else {
        // try another regex format
        //  such as 10am
        const match2 = str.match(/(\d+)\s*(?:am|pm|a\.m|p\.m|h|hr)/);
        if (match2) {
          // remove . from am/pm (if present)
          str = str.replace(/([ap])\.m\.?/g, '$1m');
          // if we're in pm, add 12 hours
          if (str.indexOf('pm') >= 0 && match2[1] !== '12') {
            const hourVal = parseInt(match2[1], 10);
            if (hourVal < 12) {
              match2[1] = hourVal + 12;
            }
          }

          return {
            hour: parseInt(match2[1], 10),
            minute: 0,
            _key: str,
          };
        }
      }
      return null;
    };

    // parse each label into hours
    const hoursMap = labels.reduce((acc, x) => {
      // time will be in one of many formats. Examples:
      //  10:00 a.m. to 6:00 p.m.
      //  10:00 a.m. - 7:00 p.m. Peur sur le Parc
      //  Daytime 9:00 a.m. - 6:00 p.m. and Evening 7:00 p.m. - 1:00 a.m. Peur sur le Parc
      //  Theme Park closed

      // ignore closed dates, just don't store it and let the lack of key indicate closed

      const regexPiecePostfix = "(?:am|pm|a\\.m|p\\.m|h|hr)\\.?";
      const regexPieceConnector = "\\s*(?:-|to)\\s*";
      const regexHoursWithMinutes = "\\d+:\\d+";
      const regexHoursWithoutMinutes = "\\d+";

      const timePatterns = [
        new RegExp(`(${regexHoursWithMinutes}\\s*${regexPiecePostfix})${regexPieceConnector}(${regexHoursWithMinutes}\\s*${regexPiecePostfix})`, 'ig'),
        new RegExp(`(${regexHoursWithoutMinutes}\\s*${regexPiecePostfix})${regexPieceConnector}(${regexHoursWithoutMinutes}\\s*${regexPiecePostfix})`, 'ig'),
      ];

      // try each time pattern
      let bFoundMatch = false;
      for (const timePattern of timePatterns) {
        const matches = x.value.match(timePattern);
        if (matches) {
          bFoundMatch = true;

          const key = x.key.replace('calendar.dateType.legend.', '');
          if (!acc[key]) {
            acc[key] = matches.map((match) => {
              const times = match.replace(' to ', '-').split('-');
              return {
                start: stringHoursToNumbers(times[0]),
                end: stringHoursToNumbers(times[1]),
              };
            });
          }

          break;
        }
      }
      if (!bFoundMatch) {
        //debugger;
      }

      return acc;
    }, {});

    // close the database
    db.close();

    const addTypeToEntries = (entries, type) => {
      return entries.map((x) => {
        return {
          ...x,
          _type: type,
        }
      });
    };

    // format schedule data
    const scheduleData = schedules.reduce((acc, x) => {
      // find the hours for this date type
      const hours = hoursMap[x.type];
      if (!hours) {
        return acc;
      }

      const date = moment.tz(x.day, 'YYYY-MM-DD', this.config.timezone);

      for (const hour of hours) {
        const openingTime = date.clone().set('hour', hour.start.hour).set('minute', hour.start.minute);
        const closingTime = date.clone().set('hour', hour.end.hour).set('minute', hour.end.minute);

        if (closingTime.isBefore(openingTime)) {
          closingTime.add(1, 'day');
        }
        acc.push({
          date: date.format("YYYY-MM-DD"),
          openingTime: openingTime.format(),
          closingTime: closingTime.format(),
          type: 'OPERATING',
        });
      }

      return acc;
    }, []);

    return {
      poi: [
        ...addTypeToEntries(attractionData, 'attraction'),
        ...addTypeToEntries(restaurantData, 'restaurant'),
        ...addTypeToEntries(showData, 'show'),
      ],
      calendar: scheduleData,
    };
  }

  /**
   * Get the latest POI data as a JSON object
   * @returns {object}
   */
  async _fetchPOIData() {
    // cache the whole thing for 3 hours
    //  saves reloading/reparsing the database all the time
    '@cache|3h';

    // get live database version
    const liveDatabaseVersion = await this.getLiveDatabaseVersion();

    if (liveDatabaseVersion.currentVersion === liveDatabaseVersion.liveVersion) {
      // fetch from cache
      return this.cache.get('poiData');
    }

    // fetch new data from liveDatabaseVersion.url
    const poiDataArchive = await this._downloadPOIArchive(liveDatabaseVersion.url);
    // if undefined, nuke function cache
    if (!poiDataArchive) {
      await this._clearFunctionCache('_downloadPOIArchive', [
        liveDatabaseVersion.url,
      ]);
      return [];
    }

    // list all files in the zip
    const zip = new AdmZip(poiDataArchive);
    const zipEntries = zip.getEntries();

    // print all entries
    const cultures = ['en', 'fr'];
    const databaseEntries = cultures.map((culture) => {
      return {
        culture,
        zipEntry: zipEntries.find((entry) => entry.entryName.indexOf(`pax_${culture}.sqlite`) >= 0),
      };
    });

    // load each database entry
    for (const entry of databaseEntries) {
      if (!entry.zipEntry) {
        this.error(`Failed to find database entry for culture ${entry.culture}`);
        continue;
      }

      const data = await this._loadPOIDatabase(entry.zipEntry);
      if (data && data.poi) {
        entry.data = data.poi;
      }
      if (data && data.calendar) {
        entry.calendar = data.calendar;
      }
    }

    // merge data from all cultures into a single object
    //  prioritise cultures in order of cultures array

    const poiData = [];
    let schedule = null;
    for (const entry of databaseEntries) {
      if (entry.data) {
        entry.data.forEach((entry) => {
          // look for existing entry in poiData
          const existingEntry = poiData.find((x) => x.drupal_id === entry.drupal_id);
          if (!existingEntry) {
            poiData.push(entry);
          } else {
            // add any missing data to the existing entry
            const keys = Object.keys(entry);
            for (const key of keys) {
              if (!existingEntry[key]) {
                existingEntry[key] = entry[key];
              }
            }
          }
        });
      }

      if (entry.calendar && !schedule) {
        schedule = entry.calendar;
      }
    }

    return {
      poi: poiData,
      schedule,
    };
  }

  /**
   * Get raw wait time data
   */
  async getWaitTimeData() {
    '@cache|1';
    const waitTimesQuery = `query paxPolling {
  paxLatencies {
    drupalId
    latency
    isOpen
    message
    openingTime
    closingTime
  }
  paxSchedules {
    drupalId
    times {
      at
      startAt
      endAt
    }
  }
  paxMessages {
    id
    type
    label
    modalText
    modalImage
    url
    updatedAt
  }
}`;

    const waitTimes = await this.makeGraphQLQuery(waitTimesQuery);
    return waitTimes;
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
      entity.name = data.title || undefined;

      entity._id = `${data.drupal_id}`;

      if (data.latitude && data.longitude) {
        entity.location = {
          latitude: data.latitude,
          longitude: data.longitude,
        };
      }

      // deprecated field
      //entity.fastPass = !!data.hasQueuingCut;
    }

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    return {
      ...this.buildBaseEntityObject(),
      _id: 'parcasterix',
      slug: 'parcasterix', // all destinations must have a unique slug
      name: 'Parc Asterix',
      entityType: entityType.destination,
      location: {
        longitude: 2.573816,
        latitude: 49.136750,
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
        _id: 'parcasterixpark',
        _destinationId: 'parcasterix',
        _parentId: 'parcasterix',
        slug: 'ParcAsterixPark',
        name: 'Parc Asterix',
        entityType: entityType.park,
        location: {
          longitude: 2.573816,
          latitude: 49.136750,
        },
      }
    ];
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const poiData = await this._fetchPOIData();

    return poiData.poi.filter((x) => {
      return x._type === 'attraction';
    }).map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
        _destinationId: 'parcasterix',
        _parentId: 'parcasterixpark',
        _parkId: 'parcasterixpark',
      };
    }).filter((x) => {
      return !!x && x._id;
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
    const poiData = await this._fetchPOIData();

    return poiData.poi.filter((x) => {
      return x._type === 'restaurant';
    }).map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        entityType: entityType.restaurant,
        _destinationId: 'parcasterix',
        _parentId: 'parcasterixpark',
        _parkId: 'parcasterixpark',
      };
    }).filter((x) => {
      return !!x && x._id;
    });
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const waitTimes = await this.getWaitTimeData();

    return waitTimes.data.paxLatencies.map((x) => {
      const data = {
        _id: x.drupalId,
      };

      data.status = statusType.operating;

      if (x.isOpen == false) {
        data.status = statusType.closed;
      } else {
        data.queue = {
          [queueType.standBy]: {
            waitTime: null,
          }
        };

        if (x.latency !== null) {
          if (!isNaN(x.latency)) {
            data.queue[queueType.standBy].waitTime = x.latency;
          } else if (x.latency.match(/^\d+$/)) {
            data.queue[queueType.standBy].waitTime = parseInt(x.latency, 10);
          } else {
            // TODO - report error in parsing latency, unknown string!
            // assume closed
            data.status = statusType.closed;
          }
        }
      }

      return data;
    });
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const calendarData = await this._fetchPOIData();

    return [
      {
        _id: 'parcasterixpark',
        schedule: calendarData.schedule,
      },
    ];
  }
}
