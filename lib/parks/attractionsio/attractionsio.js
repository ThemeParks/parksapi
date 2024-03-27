import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';

import {v4 as uuidv4} from 'uuid';
import moment from 'moment';
import unzip from 'yauzl';
import {promisify} from 'util';

const unzipFromBuffer = promisify(unzip.fromBuffer);

const langs = ['en-GB', 'en-US', 'en-AU', 'en-CA', 'es-419', 'de-DE', 'it'];
/**
 * Helper to extract name from a variable
 * @param {String|Object} name 
 * @returns {String}
 */
function extractName(name) {
  if (typeof name === 'object') {
    // if we have translations, pick in priority order...
    const langIdx = langs.findIndex((lang) => !!name[lang]);
    if (langIdx > -1) {
      return name[langs[langIdx]];
    } else {
      // otherwise just pick the first one
      return Object.values(name)[0];
    }
  }

  return name;
}

export class AttractionsIO extends Destination {
  constructor(options = {}) {
    options.destinationId = options.destinationId || '';
    options.parkId = options.parkId || '';
    options.baseURL = options.baseURL || '';
    options.timezone = options.timezone || 'Europe/London';
    options.appBuild = options.appBuild || undefined;
    options.appVersion = options.appVersion || '';
    options.deviceIdentifier = options.deviceIdentifier || '123';
    options.apiKey = options.apiKey || '';
    options.initialDataVersion = options.initialDataVersion || undefined;
    options.calendarURL = options.calendarURL || '';

    // allow env config for all attractionsio destinations
    options.configPrefixes = ['ATTRACTIONSIO'];

    // invalidate cache
    options.cacheVersion = options.cacheVersion || '3';

    super(options);

    if (!this.config.destinationId) throw new Error('destinationId is required');
    if (!this.config.parkId) throw new Error('parkId is required');
    if (!this.config.baseURL) throw new Error('Missing attractions.io base URL');
    if (!this.config.appBuild) throw new Error('Missing appBuild');
    if (!this.config.appVersion) throw new Error('Missing appVersion');
    if (!this.config.deviceIdentifier) throw new Error('Missing deviceIdentifier');
    if (!this.config.apiKey) throw new Error('Missing apiKey');
    if (!this.config.calendarURL) throw new Error('Missing calendarURL');

    // API hooks for auto-login
    const baseURLHostname = new URL(this.config.baseURL).hostname;

    // login when accessing API domain
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {

      // always include the current date
      options.headers.date = moment().format();

      if (options.skipDeviceId) {
        // special case for initial device setup
        options.headers['authorization'] = `Attractions-Io api-key="${this.config.apiKey}"`;
        return;
      }

      const deviceId = await this.getDeviceId();
      options.headers['authorization'] = `Attractions-Io api-key="${this.config.apiKey}", installation-token="${deviceId}"`;
    });
  }

  /**
   * Create a device ID to login to the API
   */
  async getDeviceId() {
    '@cache|481801'; // cache 11 months
    const deviceId = uuidv4();

    const resp = await this.http('POST', `${this.config.baseURL}installation`, {
      user_identifier: deviceId,
      app_build: this.config.appBuild,
      app_version: this.config.appVersion,
      device_identifier: this.config.deviceIdentifier,
    }, {
      skipDeviceId: true,
    });

    return resp.body.token;
  }

  /**
   * Get POI data for this destination
   */
  async getPOIData(depth = 0) {
    '@cache|720'; // cache for 12 hours

    // get current data asset version
    const currentParkDataVersion = (await this.cache.get('currentParkDataVersion')) || this.config.initialDataVersion;

    const dataQueryOptions = {};
    if (currentParkDataVersion) {
      dataQueryOptions.version = currentParkDataVersion;
    }

    // query current data version
    const dataVersionQuery = await this.http(
      'GET',
      `${this.config.baseURL}data`,
      Object.keys(dataQueryOptions).length > 0 ? dataQueryOptions : undefined,
      {
        // allow up to 10 minutes
        read_timeout: 0,
      },
    );

    if (dataVersionQuery.statusCode === 202) {
      // data is being generated, wait for it to finish and try again...

      // give up after 5 tries...
      if (depth < 5) {
        // wait 10 seconds
        this.log('Status Code 202 receieved. Data is still being generated, waiting 10 seconds and trying again...');
        await new Promise((resolve) => setTimeout(resolve, 10 * 1000));
        // try again
        return this.getPOIData(depth++);
      }
    }

    if (dataVersionQuery.statusCode === 303) {
      // redirect to new data asset
      const newDataAssets = dataVersionQuery.headers.location;

      // download the new data asset and extract records.json
      const assetData = await this.downloadAssetPack(newDataAssets);

      // save assetData in long-term cache
      await this.cache.set('assetData', assetData, 1000 * 60 * 60 * 24 * 365 * 2); // cache for 2 years
      // save the current data asset version
      await this.cache.set('currentParkDataVersion', assetData.manifestData.version, 1000 * 60 * 60 * 24 * 365 * 2); // cache for 2 years

      return assetData.recordsData;
    }

    // in all other scenarios, return our previously cached data
    const assetData = await this.cache.get('assetData');
    if (!assetData?.recordsData) {
      this.emit('error', new Error(`No asset data found, return code ${dataVersionQuery.statusCode}`));
    }
    return assetData.recordsData;
  }

  /**
   * Download asset zip file. Extract manifest and records data.
   * @param {String} url 
   * @returns {object}
   */
  async downloadAssetPack(url) {
    const resp = await this.http('GET', url);

    // read a single JSON file from a zip object
    const readZipFile = async (zip, file) => {
      const openReadStream = promisify(zip.openReadStream.bind(zip));
      const readStream = await openReadStream(file);

      let data = '';
      readStream.on('data', (chunk) => {
        data += chunk;
      });

      return new Promise((resolve, reject) => {
        readStream.on('end', () => {
          try {
            data = JSON.parse(data);
            return resolve(data);
          } catch (e) {
            return reject(new Error(`JSON parse error extracting ${file.fileName}: ${e}`));
          }
        });
      });
    }

    // unzip data
    const zip = await unzipFromBuffer(resp.body, {
      lazyEntries: true,
    });
    let manifestData;
    let recordsData;

    const filenames = [
      'manifest.json',
      'records.json',
    ];

    zip.on('entry', async (file) => {
      if (filenames.indexOf(file.fileName) > -1) {
        // read the file
        const data = await readZipFile(zip, file);

        // store the data
        if (file.fileName === 'manifest.json') {
          manifestData = data;
        } else if (file.fileName === 'records.json') {
          recordsData = data;
        }
      }

      zip.readEntry();
    });

    return new Promise((resolve, reject) => {
      zip.on('end', () => {
        if (!manifestData) {
          return reject(new Error('No manifest.json found in zip file'));
        }
        if (!recordsData) {
          return reject(new Error('No records.json found in zip file'));
        }

        return resolve({
          manifestData,
          recordsData,
        });
      });

      // start reading file...
      zip.readEntry();
    });
  }

  /**
   * Given a category string, return all category IDs
   * eg. "Attractions" will return the "Attractions" category and all child categories, such as "Thrills" etc.
   */
  async getCategoryIDs(categoryName) {
    '@cache|120';

    const destinationData = await this.getPOIData();

    // find parent category
    const cats = [];
    const attractionCats = destinationData.Category.filter((x) => {
      return extractName(x.Name) === categoryName;
    });
    if (!attractionCats || attractionCats.length === 0) return [];

    // return main category
    // cats.push(attractionCat._id);
    cats.push(...attractionCats.map((x) => x._id));

    // concat child cateories too
    attractionCats.forEach((parentCat) => {
      cats.push(...destinationData.Category.filter((x) => {
        return x.Parent == parentCat._id;
      }).map((x) => x._id));
    });

    return cats;
  }

  /**
   * Helper function to build a basic entity document
   * Useful to avoid copy/pasting
   * @param {object} data 
   * @returns {object}
   */
  buildBaseEntityObject(data) {
    const entity = Destination.prototype.buildBaseEntityObject.call(this, data);

    entity._id = `${data?._id || undefined}`;
    entity.name = extractName(data?.Name || undefined);

    if (data?.DirectionsLocation) {
      try {
        const loc = data.DirectionsLocation.split(',').map(Number);
        entity.location = {
          latitude: loc[0],
          longitude: loc[1],
        };
      } catch (e) {
        // ignore
      }
    }
    if (data?.Location) {
      try {
        const loc = data.Location.split(',').map(Number);
        entity.location = {
          latitude: loc[0],
          longitude: loc[1],
        };
      } catch (e) {
        // ignore
      }
    }

    entity._tags = [];
    // minimum height
    if (data?.MinimumHeightRequirement !== undefined) {
      entity._tags.push({
        id: 'minimumHeight',
        value: Math.floor(data.MinimumHeightRequirement * 100),
      });
    }
    // minimum height unaccompanied
    if (data?.MinimumUnaccompaniedHeightRequirement !== null && data?.MinimumUnaccompaniedHeightRequirement !== undefined) {
      entity._tags.push({
        id: 'minimumHeightUnaccompanied',
        value: Math.floor(data.MinimumUnaccompaniedHeightRequirement * 100),
      });
    }

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    const destinationData = await this.getPOIData();

    // TODO - hardcode or find a better way to find our destination data
    // Note: What about merlin resorts with multiple parks? i.e, Legoland Orlando - any others?
    if (!destinationData?.Resort) {
      throw new Error('No resort data found');
    }
    if (destinationData.Resort.length > 1) {
      throw new Error('Multiple resorts found in destination data');
    }

    const resortData = destinationData.Resort[0];
    if (!resortData) throw new Error('No resort data found');

    return {
      ...this.buildBaseEntityObject(resortData),
      _id: this.config.destinationId,
      slug: this.config.destinationId,
      entityType: entityType.destination,
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    const destinationData = await this.getPOIData();

    if (!destinationData?.Resort?.length) {
      throw new Error('No resort data found');
    }

    const park = destinationData.Resort[0];
    const parkObj = {
      ...this.buildBaseEntityObject(park),
      _parentId: this.config.destinationId,
      _destinationId: this.config.destinationId,
      entityType: entityType.park,
      _id: this.config.parkId,
    };
    parkObj.name = parkObj.name.replace(/\s*Resort/, '');
    parkObj.slug = parkObj.name.toLowerCase().replace(/[^\w]/g, '');
    return [parkObj];
  }

  /**
   * Helper function to generate entities from a list of category names
   * @param {Array<String>} categoryNames
   * @returns  {Array<Object>}
   */
  async _buildEntitiesFromCategories(categoryNames, parentId, attributes = {}) {
    const categoryIDs = [];
    for (let i = 0; i < categoryNames.length; i++) {
      const categories = await this.getCategoryIDs(categoryNames[i]);
      categoryIDs.push(...categories);
    }

    const categoryData = await this.getPOIData();

    const ents = categoryData.Item.filter((x) => categoryIDs.indexOf(x.Category) >= 0);

    return ents.map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        _parentId: parentId,
        _parkId: parentId,
        _destinationId: this.config.destinationId,
        ...attributes,
      };
    });
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    return this._buildEntitiesFromCategories(['Attractions', 'Rides', 'Water Rides', 'Thrill Rides', 'Coasters', 'Intense Thrills', 'Rides & Shows', 'Thrills & Mini-Thrills', 'RIDES', ''], this.config.parkId, {
      entityType: entityType.attraction,
      attractionType: attractionType.ride,
    });
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    return this._buildEntitiesFromCategories(['Shows', 'Show', 'Live Shows'], this.config.parkId, {
      entityType: entityType.show,
    });
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    return this._buildEntitiesFromCategories(['Restaurants', 'Fast Food', 'Snacks', 'Healthy Food', 'Food', 'Dining', 'Food & Drink'], this.config.parkId, {
      entityType: entityType.restaurant,
    });
  }

  async _fetchLiveData() {
    '@cache|1'; // cache for 1 minute
    const resp = await this.http('GET', `https://live-data.attractions.io/${this.config.apiKey}.json`);

    return resp.body.entities;
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const liveData = await this._fetchLiveData();

    // only return attractions
    const attrs = await this.getAttractionEntities();
    const attrIds = attrs.map((x) => `${x._id}`);

    const validEnts = liveData.Item.records.filter((x) => {
      return attrIds.indexOf(`${x._id}`) >= 0;
    });

    return validEnts.map((x) => {
      const data = {
        _id: `${x._id}`,
        status: (!!x.IsOperational) ? statusType.operating : statusType.closed,
      };

      if (x.QueueTime !== undefined && x.QueueTime !== null && !isNaN(x.QueueTime)) {
        data.queue = {
          [queueType.standBy]: {
            waitTime: Math.floor(x.QueueTime / 60),
          },
        };
      }

      return data;
    });
  }

  async _fetchCalendar() {
    '@cache|120'; // cache for 2 hours

    const scheduleData = await this.http('GET', this.config.calendarURL);
    return scheduleData.body;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const scheduleData = await this._fetchCalendar();

    if (!scheduleData) {
      return [
        {
          _id: this.config.parkId,
          schedule: [],
        }
      ];
    }

    // assume 1 park per destination
    const days = scheduleData.Locations[0].days;

    // various random formats the calendar API can return in
    const hourFormats = [
      {
        // eg. 10am - 5pm
        regex: /(\d{1,2})([a|p]m)\s*\-\s*(\d{1,2})([a|p]m)/,
        process: (match, date) => {
          return {
            openingTime: date.clone().hour(Number(match[1]) + (match[2] === 'pm' ? 12 : 0)).minute(0).second(0).millisecond(0),
            closingTime: date.clone().hour(Number(match[3]) + (match[4] === 'pm' ? 12 : 0)).minute(0).second(0).millisecond(0),
          };
        },
      },
      {
        // eg. 10:00 - 17:00
        regex: /(\d{1,2}):(\d{1,2})\s*\-\s*(\d{1,2}):(\d{1,2})/,
        process: (match, date) => {
          return {
            openingTime: date.clone().hour(Number(match[1])).minute(Number(match[2])).second(0).millisecond(0),
            closingTime: date.clone().hour(Number(match[3])).minute(Number(match[4])).second(0).millisecond(0),
          };
        },
      },
    ];

    const schedule = days.map((x) => {
      const date = moment(x.key, 'YYYYMMDD').tz(this.config.timezone, true);

      for (let i = 0; i < hourFormats.length; i++) {
        const format = hourFormats[i];
        const match = format.regex.exec(x.openingHours);
        if (!match) continue;

        const times = format.process(match, date);

        return {
          "date": date.format('YYYY-MM-DD'),
          "type": "OPERATING",
          "openingTime": times.openingTime.format(),
          "closingTime": times.closingTime.format(),
        };
      }

      return null;
    }).filter((x) => !!x);

    return [
      {
        _id: this.config.parkId,
        schedule,
      }
    ];
  }
}

export class AltonTowers extends AttractionsIO {
  constructor(config = {}) {
    config.destinationId = config.destinationId || 'altontowersresort';
    config.parkId = config.parkId || 'altontowers';
    config.initialDataVersion = config.initialDataVersion || '2021-07-06T07:48:43Z';

    config.appBuild = config.appBuild || 293;
    config.appVersion = config.appVersion || '5.3';

    super(config);
  }
}

export class ThorpePark extends AttractionsIO {
  constructor(config = {}) {
    config.destinationId = config.destinationId || 'thorpeparkresort';
    config.parkId = config.parkId || 'thorpepark';
    config.initialDataVersion = config.initialDataVersion || '2021-04-15T15:28:08Z';

    config.appBuild = config.appBuild || 299;
    config.appVersion = config.appVersion || '1.4';

    super(config);
  }
}

export class ChessingtonWorldOfAdventures extends AttractionsIO {
  constructor(config = {}) {
    config.destinationId = config.destinationId || 'chessingtonworldofadventuresresort';
    config.parkId = config.parkId || 'chessingtonworldofadventures';
    config.initialDataVersion = config.initialDataVersion || '2021-08-19T09:59:06Z';

    config.appBuild = config.appBuild || 178;
    config.appVersion = config.appVersion || '3.3';

    super(config);
  }
}

export class LegolandWindsor extends AttractionsIO {
  constructor(config = {}) {
    config.destinationId = config.destinationId || 'legolandwindsorresort';
    config.parkId = config.parkId || 'legolandwindsor';
    config.initialDataVersion = config.initialDataVersion || '2021-08-20T08:22:20Z';

    config.appBuild = config.appBuild || 113;
    config.appVersion = config.appVersion || '2.4';

    super(config);
  }
}

export class LegolandOrlando extends AttractionsIO {
  constructor(config = {}) {
    config.timezone = config.timezone || 'America/New_York';
    config.destinationId = config.destinationId || 'legolandorlandoresort';
    config.parkId = config.parkId || 'legolandorlando';
    config.initialDataVersion = config.initialDataVersion || '2021-08-09T15:48:56Z';

    config.appBuild = config.appBuild || 115;
    config.appVersion = config.appVersion || '1.6.1';

    super(config);
  }
}

export class LegolandCalifornia extends AttractionsIO {
  constructor(config = {}) {
    config.timezone = config.timezone || 'America/Los_Angeles';
    config.destinationId = config.destinationId || 'legolandcaliforniaresort';
    config.parkId = config.parkId || 'legolandcalifornia';
    config.initialDataVersion = config.initialDataVersion || '';//'2023-03-15T16:27:19Z';

    config.appBuild = config.appBuild || 800000074;
    config.appVersion = config.appVersion || '8.4.11';

    super(config);
  }
}

export class LegolandBillund extends AttractionsIO {
  constructor(config = {}) {
    config.destinationId = config.destinationId || 'legolandbillundresort';
    config.parkId = config.parkId || 'legolandbillund';
    config.initialDataVersion = config.initialDataVersion || '2023-10-31T09:22:05Z';

    config.appBuild = config.appBuild || 162;
    config.appVersion = config.appVersion || '3.4.17';

    super(config);
  }
}

export class LegolandDeutschland extends AttractionsIO {
  constructor(config = {}) {
    config.destinationId = config.destinationId || 'legolanddeutschlandresort';
    config.parkId = config.parkId || 'legolanddeutschland';
    config.initialDataVersion = config.initialDataVersion || '';

    config.appBuild = config.appBuild || 113;
    config.appVersion = config.appVersion || '1.4.15';

    super(config);
  }
}

export class Gardaland extends AttractionsIO {
  constructor(config = {}) {
    config.timezone = config.timezone || 'Europe/Rome';
    config.destinationId = config.destinationId || 'gardalandresort';
    config.parkId = config.parkId || 'gardaland';
    config.initialDataVersion = config.initialDataVersion || '2020-10-27T08:40:37Z';

    config.appBuild = config.appBuild || 119;
    config.appVersion = config.appVersion || '4.2';

    super(config);
  }
}

export class HeidePark extends AttractionsIO {
  constructor(config = {}) {
    config.timezone = config.timezone || 'Europe/Berlin';
    config.destinationId = config.destinationId || 'heideparkresort';
    config.parkId = config.parkId || 'heidepark';
    config.initialDataVersion = config.initialDataVersion || '2022-05-10T09:00:46Z';

    config.appBuild = config.appBuild || 302018;
    config.appVersion = config.appVersion || '4.0.5';

    super(config);
  }
}
