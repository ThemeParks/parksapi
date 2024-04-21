import { attractionType, statusType, queueType, tagType, scheduleType, entityType } from '../parkTypes.js';
//import level from 'level';
import path from 'path';
import moment from 'moment-timezone';
import zlib from 'zlib';
import util, { callbackify } from 'util';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import Destination from '../destination.js';
import sift from 'sift';
import levelup from 'levelup';
import leveldown from 'leveldown';

const zDecompress = util.promisify(zlib.unzip);
const zCompress = util.promisify(zlib.deflate);

/**
 * Shanghai Disneyland Resort
 */
export class ShanghaiDisneylandResort extends Destination {
  /**
   * Create a new ShanghaiDisneylandResort
   * @param {object} options
   */
  constructor(options = {}) {
    options.name = options.name || 'Shanghai Disney Resort';
    options.timezone = options.timezone || 'Asia/Shanghai';

    options.apiBase = options.apiBase || '';
    options.apiAuth = options.apiAuth || '';
    // options.parkId = options.parkId || 'desShanghaiDisneyland';

    options.configPrefixes = ['SHDR'].concat(options.configPrefixes || []);

    options.parkIds = options.parkIds || ['desShanghaiDisneyland'];

    super(options);

    // here we can validate the resulting this.config object
    if (!this.config.apiBase) throw new Error('Missing Shanghai Disney Resort apiBase');
    if (!this.config.apiAuth) throw new Error('Missing Shanghai Disney Resort apiAuth');

    // add our auth token to any API requests
    this.http.injectForDomain({
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
        this.log('Got unauthorised response, refresh access_token...');
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
    this.db = levelup(leveldown(path.join(process.cwd(), 'db.shdr')))
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
      expiresIn = resp?.body?.expires_in;

      const token = resp?.body?.access_token;
      this.log(`Got new access_token ${token}`);

      return token;
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
  async getAllEntityKeys() {
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
      console.trace(`Error parsing SHDR doc ${id}: ${doc}`);
      this.emit('error', e);
    }
    return undefined;
  }

  /**
   * Get all attraction data
   */
  async getAttractionData() {
    // cache 2 hours
    '@cache|120';
    try {
      await this._refreshAttractionData();
    } catch (e) {
      this.log('Failed to refresh Shanghai facilities data', e);
    }
    const docs = await this.getAllEntityKeys();
    const allEnts = await Promise.all(docs.map((docId) => {
      return this.getEntity(docId);
    }));

    // HACK - manually add Hot Persuit if it's missing
    const existingEnt = allEnts.find((x) => x?.attractionID === 'attZootopiaHotPursuit');
    if (existingEnt) return allEnts;
    
    const hotPersuit = {
      attractionId: "attZootopiaHotPursuit",
      id: "attZootopiaHotPursuit;entityType=Attraction;destination=shdr",
      type: "Attraction",
      cacheId: "attZootopiaHotPursuit;entityType=Attraction;destination=shdr;cacheId=-2111797129",
      name: "Zootopia: Hot Pursuit",
      ancestors: [
        {
          id: "shdr;entityType=destination;destination=shdr",
          type: "destination",
        },
        {
          id: "desShanghaiDisneyland;entityType=theme-park;destination=shdr",
          type: "theme-park",
        },
      ],
      relatedLocations: [
        {
          id: "attZootopiaHotPursuit;entityType=Attraction;destination=shdr",
          type: "primaryLocation",
          name: "Zootopia: Hot Pursuit",
          coordinates: [
            {
              latitude: "31.15180406306",
              longitude: "121.665299510689",
              type: "Guest Entrance",
            },
          ],
          ancestors: [
            {
              id: "shdr;entityType=destination;destination=shdr",
              type: "destination",
            },
            {
              id: "desShanghaiDisneyland;entityType=theme-park;destination=shdr",
              type: "theme-park",
            },
          ],
        },
      ],
      facets: [],
      fastPass: "false",
      webLink: "",
      policies: [],
    };

    allEnts.push(hotPersuit);

    return allEnts;
  }

  /**
   * Refresh attraction data, getting new and updated documents from the API
   */
  async _refreshAttractionData() {
    const docs = await this.getAllEntityKeys();

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
        retries: 0,
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
      if (removed === undefined) return;
      // removed just gives us the ID
      this.log(`Removing entity ${removed}`);
      const info = this.extractEntityData(removed);
      return this.db.del(info.id);
    }));
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
      // process "standby pass" attractions separately in the live data of the "normal" attraction
      const originalName = attr.name.slice(0, ' (Standby Pass Required)'.length);
      const originalAttraction = data.find((x) => x.name === originalName);
      if (originalAttraction !== undefined) {
        // store a mapping of attraction -> standby version in our database
        await this.db.put(`standbypass_${originalAttraction.attractionId}`, JSON.stringify(attr.attractionId));
      }
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
   * Dump the SHDR database to a buffer
   * @return {buffer}
   */
  async _dumpDB() {
    const keys = await this.getAllEntityKeys();
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



  /**
   * @inheritdoc
   */
  async _init() {
    // restore backup of data if we haven't yet started syncing SHDR data
    const hasInitialData = await this.getAllEntityKeys();
    if (hasInitialData.length === 0) {
      console.log('Restoring SHDR backup before syncing...');
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const backupFile = path.join(thisDir, 'shdr_data.gz');
      const backupData = await fs.readFile(backupFile);
      await this._loadDB(backupData);
    }
  }

  /**
   * Helper function to build a basic entity document
   * Useful to avoid copy/pasting
   * @param {object} data 
   * @returns {object}
   */
  buildBaseEntityObject(data) {
    const entity = Destination.prototype.buildBaseEntityObject.call(this, data);

    entity._id = data?.id;

    entity.name = data?.name;

    if (data?.relatedLocations) {
      const loc = data.relatedLocations.find((x) => x.type === 'primaryLocation' && x.coordinates.length > 0);
      if (loc) {
        entity.location = {
          longitude: Number(loc.coordinates[0].longitude),
          latitude: Number(loc.coordinates[0].latitude),
        };
      }
    }

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    return {
      ...this.buildBaseEntityObject(),
      _id: 'shanghaidisneyresort',
      slug: 'shanghaidisneyresort',
      name: this.config.name,
      entityType: entityType.destination,
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    const dest = await this.buildDestinationEntity();
    const parks = [];
    for (let i = 0; i < this.config.parkIds.length; i++) {
      const parkData = await this.getEntity(this.config.parkIds[i]);
      parks.push({
        ...this.buildBaseEntityObject(parkData),
        _destinationId: dest._id,
        _parentId: dest._id,
        slug: parkData.attractionId.toLowerCase().replace(/^des/, ''),
        entityType: entityType.park,
      });
    }
    return parks;
  }

  /**
   * Build array of entities matching filterFn
   * @param {function} filterFn 
   */
  async _buildEntities(filterFn, attrs = {}) {
    const dest = await this.buildDestinationEntity();

    const ents = await this.getAttractionData();

    return ents.filter(sift(filterFn)).map((x) => {
      if (x.name.indexOf(' (Standby Pass Required)') > 0) {
        return undefined;
      }

      const ent = {
        ...this.buildBaseEntityObject(x),
        _destinationId: dest._id,
        ...attrs,
      };

      const park = x.ancestors.find((y) => y.type === 'theme-park');
      if (park) {
        ent._parentId = park.id;
        ent._parkId = park.id;
      } else {
        ent._parentId = dest._id;
      }

      return ent;
    }).filter((x) => !!x);
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    return this._buildEntities({
      type: 'Attraction',
    }, {
      entityType: entityType.attraction,
      attractionType: attractionType.ride,
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
   * Fetch wait time data
   * @return {array<object>}
   */
  async _fetchWaitTimes() {
    '@cache|1';
    const waitTimes = await this.http(
      'GET',
      `${this.config.apiBase}explorer-service/public/wait-times/shdr;entityType=destination?region=cn`,
      undefined,
      { json: true },
    );

    return waitTimes?.body?.entries;
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    await this.init();

    const waitTimes = await this._fetchWaitTimes();

    const livedata = [];

    const allAttrs = await this.getAttractionData();

    // first, loop over and find any standby ticket varients
    //  build an object of attraction -> standbypass version
    const standbyPass = {};
    for (let i = 0; i < waitTimes.length; i++) {
      const cleanID = this.extractEntityData(waitTimes[i]).id;
      try {
        const ent = await this.getEntity(cleanID);
        if (ent && ent?.name.toLowerCase().indexOf(' (standby pass required)') > 0) {
          const originalName = ent.name.slice(0, ent?.name.toLowerCase().indexOf(' (standby pass required)'));

          const originalAttraction = allAttrs.find((x) => x.name === originalName);
          if (originalAttraction) {
            standbyPass[originalAttraction.attractionId] = ent.attractionId;
          }
        }
      } catch (e) { }
    }

    for (let i = 0; i < waitTimes.length; i++) {
      const dat = waitTimes[i];
      const live = {
        _id: dat.id,
        status: statusType.operating,
      };

      switch (dat.waitTime?.status) {
        case 'Closed':
          live.status = statusType.closed;
          break;
        case 'Down':
          live.status = statusType.down;
          break;
        case 'Renewal':
          live.status = statusType.refurbishment;
          break;
      }

      // skip if standby pass object
      const cleanID = this.extractEntityData(dat).id;
      try {
        const ent = await this.getEntity(cleanID);
        if (!ent || !ent.name || ent.name.toLowerCase().indexOf(' (standby pass required)') > 0) {
          continue;
        }
      } catch (e) { }

      // base standby queue time
      live.queue = {
        [queueType.standBy]: {
          waitTime: dat.waitTime?.postedWaitMinutes !== undefined ? dat.waitTime?.postedWaitMinutes : null,
        },
      };

      // show single rider time
      if (dat.waitTime?.singleRider) {
        live.queue[queueType.singleRider] = {
          // API doesn't give us the wait times, just that the queue exists
          waitTime: null,
        };
      }

      // look for standby pass entry (this gives us return times)
      const standbyVersionId = standbyPass[dat.attractionId];
      if (standbyVersionId) {
        const passDat = waitTimes.find((x) => x.attractionId === standbyVersionId);
        if (passDat) {
          live.queue[queueType.returnTime] = {
            // currently no way of getting the latest return time
            //  return null so the API shows that return times are active
            returnStart: null,
            returnEnd: null,
            // API doesn't reveal current state of return time tickets
            status: null,
          };
        }
      }

      livedata.push(live);
    }

    return livedata;
  }

  async _fetchUpcomingCalendar() {
    // 12 hours
    '@cache|720';
    const todaysDate = this.getTimeNowMoment().add(-1, 'days');
    const endOfTarget = todaysDate.clone().add(190, 'days');
    return (await this.http(
      'GET',
      `${this.config.apiBase}explorer-service/public/ancestor-activities-schedules/shdr;entityType=destination`,
      {
        filters: 'resort,theme-park,water-park,restaurant,Attraction',
        startDate: todaysDate.format('YYYY-MM-DD'),
        endDate: endOfTarget.format('YYYY-MM-DD'),
        region: 'cn',
        childSchedules: 'guest-service(point-of-interest)',
      },
    )).body;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const cal = await this._fetchUpcomingCalendar();

    const timeFormat = 'YYYY-MM-DDTHH:mm:ss';

    return cal.activities.map((entity) => {
      if (!entity.schedule) return undefined;
      return {
        _id: entity.id,
        schedule: entity.schedule.schedules.map((x) => {
          if (x.type !== 'Operating') return undefined;
          return {
            date: x.date,
            openingTime: moment.tz(`${x.date}T${x.startTime}`, timeFormat, this.config.timezone).format(),
            closingTime: moment.tz(`${x.date}T${x.endTime}`, timeFormat, this.config.timezone).format(),
            type: scheduleType.operating,
          };
        }).filter((x) => !!x),
      }
    }).filter((x) => !!x);
  }
}

export default ShanghaiDisneylandResort;
