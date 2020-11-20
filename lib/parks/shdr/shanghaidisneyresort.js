import {Park} from '../park.js';
import {attractionType, statusType, queueType, tagType, scheduleType} from '../parkTypes.js';
import level from 'level';
import path from 'path';
import moment from 'moment-timezone';
import zlib from 'zlib';
import util from 'util';
import {fileURLToPath} from 'url';
import {promises as fs} from 'fs';

const zDecompress = util.promisify(zlib.unzip);
const zCompress = util.promisify(zlib.deflate);

/**
 * Shanghai Disneyland Park
 */
export class ShanghaiDisneylandPark extends Park {
  /**
   * Create a new Sample Park object
   * @param {object} options
   */
  constructor(options = {}) {
    options.name = options.name || 'Shanghai Disney Resort - Shanghai Disneyland Park';
    options.timezone = options.timezone || 'Asia/Shanghai';

    options.apiBase = options.apiBase || '';
    options.apiAuth = options.apiAuth || '';
    options.parkId = options.parkId || 'desShanghaiDisneyland';

    options.configPrefixes = ['SHDR'].concat(options.configPrefixes || []);

    super(options);

    // here we can validate the resulting this.config object
    if (!this.config.apiBase) throw new Error('Missing Shanghai Disney Resort apiBase');
    if (!this.config.apiAuth) throw new Error('Missing Shanghai Disney Resort apiAuth');

    // add our auth token to any API requests
    this.injectForDomain({
      hostname: new URL(this.config.apiBase).hostname,
    }, async (method, url, data, options) => {
      const accessToken = await this.getAccessToken();
      options.headers['Authorization'] = `BEARER ${accessToken}`;

      // gather in English where possible
      options.headers['Accept-Language'] = 'en';
    });

    // catch unauthorised requests and force a token refresh
    this.http.injectForDomainResponse({
      hostname: new URL(this.config.apiBase).hostname,
    }, async (resp) => {
      // if we get an unauthorised response, refetch our access_token
      if (resp?.statusCode === 401) {
        this.cache.set('access_token', undefined, -1);
        return undefined;
      }

      if (resp?.statusCode === 500) {
        // API will just return 500 fairly often, throw an error to use cached data instead
        throw new Error('SHDR API returned 500 error response to fetching facility data');
      }

      return resp;
    });

    // setup our local database for our attraction data
    this.db = level(path.join(process.cwd(), 'db.shdr'));
  }

  /**
   * Get an access token for making requests to the API
   */
  async getAccessToken() {
    let expiresIn = 0;

    return await this.cache.wrap('access_token', async () => {
      const resp = await this.http('POST', this.config.apiAuth, {
        grant_type: 'assertion',
        assertion_type: 'public',
        client_id: 'DPRD-SHDR.MOBILE.ANDROID-PROD',
      });

      // remember the expirey time sent by the server
      expiresIn = resp.body?.expires_in;

      return resp.body.access_token;
    }, () => {
      // return the expires_in field we got from our response, or 899 seconds, the default
      return (expiresIn || 899) * 1000;
    });
  }

  /**
   * Extract the key information from an attraction entity doc ID
   * @param {string|object} doc Either the document or the document ID
   * @return {object}
   */
  extractEntityData(doc) {
    const id = doc?.id || doc;
    const parts = id.split(';');
    const ret = {
      entityId: id.replace(/;cacheId=\d*;?/, ''),
    };
    ret.id = parts[0].replace(/id=/, '');
    parts.forEach((str, idx) => {
      if (idx === 0) return;
      const keyVal = str.split('=');
      if (keyVal && keyVal.length == 2) {
        ret[keyVal[0]] = keyVal[1];
      }
    });
    return ret;
  }

  /**
   * Get all stored entities
   * @return {array<string>}
   */
  async getAllEntities() {
    return new Promise((resolve) => {
      const keys = [];
      const keyStream = this.db.createKeyStream();
      keyStream.on('data', (data) => {
        keys.push(data);
      });
      keyStream.on('end', () => {
        return resolve(keys);
      });
    });
  }

  /**
   * Get an entity doc using it's ID from the local database
   * @param {string} id
   */
  async getEntity(id) {
    const doc = await this.db.get(id);
    try {
      const jsonDoc = JSON.parse(doc);
      return jsonDoc;
    } catch (e) {
      console.trace(`Error parsing SHDR doc ${id}`);
      this.emit('error', e);
    }
    return undefined;
  }

  /**
   * Get all attraction data
   */
  async getAttractionData() {
    return await this.cache.wrap('attraction_poi', async () => {
      try {
        await this._refreshAttractionData();
      } catch (e) {
        this.log('Failed to refresh Shanghai facilities data', e);
      }
      const docs = await this.getAllEntities();
      return Promise.all(docs.map((docId) => {
        return this.getEntity(docId);
      }));
    }, 1000 * 60 * 60 * 24); // update once every day
  }

  /**
   * Refresh attraction data, getting new and updated documents from the API
   */
  async _refreshAttractionData() {
    const docs = await this.getAllEntities();

    const entityCacheString = [];
    await Promise.allSettled(docs.map(async (id) => {
      const doc = await this.getEntity(id);
      if (doc !== undefined) {
        entityCacheString.push(`id=${doc.cacheId}`);
      }
    }));

    const resp = await this.http(
        'POST',
        `${this.config.apiBase}explorer-service/public/destinations/shdr;entityType=destination/facilities?region=cn`,
        entityCacheString.join('&'),
        {
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
          },
        },
    );

    const addReplaceDoc = async (doc) => {
      const info = this.extractEntityData(doc);
      await this.db.put(info.id, JSON.stringify({
        attractionId: info.id,
        ...doc,
      }));
    };

    await Promise.all(resp.body.added.map((add) => {
      this.log(`Adding entity ${add?.id}`);
      return addReplaceDoc(add);
    }));
    await Promise.all(resp.body.updated.map((updated) => {
      this.log(`Updating entity ${updated?.id}`);
      return addReplaceDoc(updated);
    }));
    await Promise.all(resp.body.removed.map((removed) => {
      // removed just gives us the ID
      this.log(`Removing entity ${removed?.id}`);
      const info = this.extractEntityData(removed);
      return this.db.del(info.id);
    }));
  }

  /**
   * @inheritdoc
   */
  async _init() {
    // restore backup of data if we haven't yet started syncing SHDR data
    const hasInitialData = await this.getAllEntities();
    if (hasInitialData.length === 0) {
      console.log('Restoring SHDR backup before syncing...');
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const backupFile = path.join(thisDir, 'shdr_data.gz');
      const backupData = await fs.readFile(backupFile);
      await this._loadDB(backupData);
    }
  }

  /**
   * @inheritdoc
   */
  async _buildAttractionObject(attractionID) {
    const data = await this.getAttractionData();
    if (data === undefined) {
      console.error('Failed to fetch SHDR attraction data');
      return undefined;
    }

    const entryInfo = this.extractEntityData(attractionID);

    const attr = data.find((x) => x.attractionId === entryInfo.id);
    if (attr === undefined) {
      return undefined;
    }

    if (attr.name.toLowerCase().indexOf('standby pass required') >= 0) {
      // TODO - process "standby pass" attractions separately in the live data of the "normal" attraction
      return undefined;
    }

    // TODO - only return Attractions for now, return shows etc. too
    if (attr.type !== 'Attraction') return undefined;

    let type = attractionType.other;
    switch (attr.type) {
      // TODO - support other types
      case 'Attraction':
        type = attractionType.ride;
        break;
    }

    const tags = [];

    tags.push({
      type: tagType.fastPass,
      value: (attr.fastPass == 'true'),
    });

    const location = attr.relatedLocations.find((x) => x.type === 'primaryLocation' && x.coordinates.length > 0);
    if (location !== undefined) {
      tags.push({
        key: 'location',
        type: tagType.location,
        value: {
          longitude: Number(location.coordinates[0].longitude),
          latitude: Number(location.coordinates[0].latitude),
        },
      });
    }

    tags.push({
      type: tagType.unsuitableForPregnantPeople,
      value: attr.policies && (attr.policies.find((x) => x.id === 'policyExpectantMothers') !== undefined),
    });

    const hasMinHeight = attr.facets.find((x) => x.group === 'height');
    if (hasMinHeight !== undefined) {
      const minHeight = /(\d+)cm-\d+in-or-taller/.exec(hasMinHeight.id);
      if (minHeight) {
        tags.push({
          type: tagType.minimumHeight,
          key: 'minimumHeight',
          value: {
            unit: 'cm',
            value: Number(minHeight[1]),
          },
        });
      }
    }

    tags.push({
      type: tagType.mayGetWet,
      value: attr.policies && (attr.policies.find((x) =>
        x?.descriptions && x.descriptions.length > 0 && (x.descriptions[0].text.indexOf('You may get wet.') >= 0),
      ) !== undefined),
    });

    return {
      name: attr.name,
      type,
      tags,
    };
  }

  /**
   * @inheritdoc
   */
  async _update() {
    const waitTimes = await this.http(
        'GET',
        `${this.config.apiBase}explorer-service/public/wait-times/shdr;entityType=destination?region=cn`,
        undefined,
        {json: true},
    );

    await Promise.all(waitTimes.body.entries.map(async (entry) => {
      const cleanID = this.extractEntityData(entry).id;

      let state = statusType.operating;
      switch (entry.waitTime?.status) {
        case 'Closed':
          state = statusType.closed;
          break;
        case 'Down':
          state = statusType.down;
          break;
        case 'Renewal':
          state = statusType.refurbishment;
          break;
      }

      await this.updateAttractionState(cleanID, state);

      const waitTime = entry.waitTime?.postedWaitMinutes;
      await this.updateAttractionQueue(cleanID, waitTime !== undefined ? waitTime : null, queueType.standBy);

      // update single rider state
      const singleRider = !!entry.waitTime?.singleRider;
      await this.updateAttractionQueue(cleanID, singleRider ? null : undefined, queueType.singleRider);
      await this.setAttractionTag(cleanID, null, tagType.singleRider, singleRider);
    }));
  }

  /**
   * Get the upcoming schedule for the park
   */
  async _getUpcomingSchedule() {
    return await this.cache.wrap('calendar', async () => {
      const todaysDate = this.getTimeNowMoment().add(-1, 'days');
      const endOfTarget = todaysDate.clone().add(62, 'days');
      return (await this.http(
          'GET',
          `${this.config.apiBase}explorer-service/public/ancestor-activities-schedules/shdr;entityType=destination`,
          {
            filters: 'resort,theme-park,water-park,restaurant,Attraction,Entertainment',
            startDate: todaysDate.format('YYYY-MM-DD'),
            endDate: endOfTarget.format('YYYY-MM-DD'),
            region: 'cn',
            childSchedules: 'guest-service(point-of-interest)',
          },
      )).body;
    }, 1000 * 60 * 60 * 24);
  }

  /**
   * Get the schedule for the park itself
   */
  async _getParkSchedule() {
    return await this.cache.wrap('parkcalendar', async () => {
      const cal = await this._getUpcomingSchedule();
      return cal.activities.find((x) => {
        const info = this.extractEntityData(x.id);
        return info.id === this.config.parkId;
      });
    }, 1000 * 60);
  }

  /**
   * @inheritdoc
   */
  async _getOperatingHoursForDate(date) {
    const calendar = (await this._getParkSchedule())?.schedule?.schedules;
    if (calendar === undefined) return undefined;

    const dateString = date.format('YYYY-MM-DD');
    const todaysSchedule = calendar.filter((x) => x.date === dateString);
    if (todaysSchedule.length === 0) return undefined;

    const timeFormat = 'YYYY-MM-DDTHH:mm:ss';

    return todaysSchedule.map((sched) => {
      if (sched.type === 'Operating') {
        return {
          openingTime: moment.tz(`${dateString}T${sched.startTime}`, timeFormat, this.config.timezone).format(),
          closingTime: moment.tz(`${dateString}T${sched.endTime}`, timeFormat, this.config.timezone).format(),
          type: scheduleType.operating,
        };
      } else {
        console.trace(sched);
        this.emit('error', new Error(`Unknown SHDR operating type ${sched.type}`));
      }
    });
  }


  /**
     * Return restaurant operating hours for the supplied date
     * @param {moment} date
     */
  async _getRestaurantOperatingHoursForDate(date) {
    const cal = await this._getUpcomingSchedule();

    const dateString = date.format('YYYY-MM-DD');
    return cal.activities.map((entity) => {
      const entityInfo = this.extractEntityData(entity.id);

      if (entityInfo.entityType !== 'restaurant' || !entity.schedule) return;

      const todaysSchedule = entity.schedule.schedules.find((x) => x.date === dateString);

      if (!todaysSchedule) {
        return {
          restaurantID: entityInfo.id,
          openingTime: 0,
          closingTime: 0,
          status: statusType.closed,
        };
      }

      const timeFormat = 'YYYY-MM-DDTHH:mm:ss';

      if (todaysSchedule.type === 'Operating') {
        return {
          restaurantID: entityInfo.id,
          // eslint-disable-next-line max-len
          openingTime: moment.tz(`${dateString}T${todaysSchedule.startTime}`, timeFormat, this.config.timezone).format(),
          closingTime: moment.tz(`${dateString}T${todaysSchedule.endTime}`, timeFormat, this.config.timezone).format(),
          status: scheduleType.operating,
        };
      } else {
        console.trace(todaysSchedule);
        this.emit('error', new Error(`Unknown SHDR operating type ${todaysSchedule.type}`));
      }
    }).filter((x) => x !== undefined);
  }

  /**
   * Return entertainment schedule for today
   */
  async _getEntertainmentForToday() {
    const cal = await this._getUpcomingSchedule();

    const date = moment();
    const dateString = date.format('YYYY-MM-DD');
    return cal.activities.map((entity) => {
      const entityInfo = this.extractEntityData(entity.id);

      if (entityInfo.entityType !== 'Entertainment' || !entity.schedule) return;

      const todaysSchedule = entity.schedule.schedules.find((x) => x.date === dateString);

      if (!todaysSchedule) {
        return;
      }

      const timeFormat = 'YYYY-MM-DDTHH:mm:ss';
      if (todaysSchedule.type === 'Operating' || todaysSchedule.type === 'Performance Time') {
        return {
          entertainmentID: entityInfo.id,
          startTime: moment.tz(
              `${dateString}T${todaysSchedule.startTime}`,
              timeFormat,
              this.config.timezone).format(),
          endTime: moment.tz(
              `${dateString}T${todaysSchedule.endTime}`,
              timeFormat,
              this.config.timezone).format(),
        };
      } else if (todaysSchedule.type === 'Refurbishment') {

      } else {
        console.trace(todaysSchedule);
        this.emit('error', new Error(`Unknown SHDR operating type ${todaysSchedule.type}`));
      }
    }).filter((x) => x !== undefined);
  }

  /**
   * Dump the SHDR database to a buffer
   * @return {buffer}
   */
  async _dumpDB() {
    const keys = await this.getAllEntities();
    const docs = {};
    await Promise.allSettled(keys.map(async (key) => {
      docs[key] = await this.db.get(key);
    }));

    return await zCompress(JSON.stringify(docs));
  }

  /**
   * Load a SHDR database from an existing buffer
   * @param {buffer} buff
   */
  async _loadDB(buff) {
    const data = await zDecompress(buff);
    const json = JSON.parse(data.toString('utf8'));

    await Promise.allSettled(Object.keys(json).map(async (key) => {
      await this.db.put(key, json[key]);
    }));
  }
}

export default ShanghaiDisneylandPark;
