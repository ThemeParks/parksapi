import Database from '../database.js';
import crypto from 'crypto';
import {URL} from 'url';
import {tagType, attractionType, entityType} from '../parkTypes.js';
import Blowfish from 'egoroof-blowfish';

/**
 * Europa Park Database Class
 */
export class DatabaseEuropaPark extends Database {
  /**
   * @inheritdoc
   * @param {object} options
   */
  constructor(options = {}) {
    options.fbAppId = '';
    options.fbApiKey = '';
    options.fbProjectId = '';
    options.apiBase = '';
    options.encKey = '';
    options.encIV = '';
    options.authURL = '';
    options.userKey = options.userKey || 'v3_live_android_exozet_api_username';
    options.passKey = options.passKey || 'v3_live_android_exozet_api_password';
    options.appVersion = options.appVersion || '10.1.0';

    options.configPrefixes = ['EUROPAPARK'].concat(options.configPrefixes || []);

    super(options);

    if (!this.config.fbApiKey) throw new Error('Missing Europa Park Firebase API Key');
    if (!this.config.fbAppId) throw new Error('Missing Europa Park Firebase App ID');
    if (!this.config.fbProjectId) throw new Error('Missing Europa Park Firebase Project ID');
    if (!this.config.apiBase) throw new Error('Missing Europa Park API Base');
    if (!this.config.encKey) throw new Error('Missing Europa Park Encryption Key');
    if (!this.config.encIV) throw new Error('Missing Europa Park Encryption IV');
    if (!this.config.authURL) throw new Error('Missing Europa Park Token URL');

    this.http.injectForDomain({
      hostname: new URL(this.config.authURL).hostname,
    }, async (method, url, data, options) => {
      options.headers['user-agent'] = `EuropaParkApp/${this.config.appVersion} (Android)`;
    });

    this.http.injectForDomain({
      hostname: new URL(this.config.apiBase).hostname,
    }, async (method, url, data, options) => {
      options.headers['user-agent'] = `EuropaParkApp/${this.config.appVersion} (Android)`;

      const jwtToken = await this.getToken();
      if (jwtToken === undefined) {
        // refetch Firebase settings and try again
        await this.cache.set('auth', undefined, -1);
        const jwtTokenRetry = await this.getToken();
        options.headers['jwtauthorization'] = `Bearer ${jwtTokenRetry}`;
      } else {
        options.headers['jwtauthorization'] = `Bearer ${jwtToken}`;
      }
    });

    this.http.injectForDomainResponse({
      hostname: new URL(this.config.apiBase).hostname,
    }, async (response) => {
      // if error code is unauthorised, clear out our JWT token
      if (response.statusCode === 401) {
        // wipe any existing token
        await this.cache.set('access_token', undefined, -1);
        // this will be regenerated next time injectForDomain is run
        return undefined;
      }

      return response;
    });

    this.bf = new Blowfish(this.config.encKey, Blowfish.MODE.CBC, Blowfish.PADDING.PKCS5);
    this.bf.setIv(this.config.encIV);
  }

  /**
   * Get or generate a Firebase device ID
   */
  async getFirebaseID() {
    return await this.cache.wrap('fid', async () => {
      try {
        const fidByteArray = crypto.randomBytes(17).toJSON().data;
        fidByteArray[0] = 0b01110000 + (fidByteArray[0] % 0b00010000);
        const b64String = Buffer.from(String.fromCharCode(...fidByteArray))
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_');
        const fid = b64String.substr(0, 22);
        return /^[cdef][\w-]{21}$/.test(fid) ? fid : '';
      } catch (e) {
        this.emit('error', e);
        console.log(e);
        return '';
      }
    }, 1000 * 60 * 60 * 24 * 8); // 8days
  }

  /**
   * Get Europa Park config keys
   */
  async getConfig() {
    return await this.cache.wrap('auth', async () => {
      const fid = await this.getFirebaseID();

      const resp = await this.http(
        'POST',
        `https://firebaseremoteconfig.googleapis.com/v1/projects/${this.config.fbProjectId}/namespaces/firebase:fetch`,
        {
          'appInstanceId': fid,
          'appId': this.config.fbAppId,
          'packageName': 'com.EuropaParkMackKG.EPGuide',
          'languageCode': 'en_GB',
        }, {
        headers: {
          'X-Goog-Api-Key': this.config.fbApiKey,
        },
      },
      );

      const decrypt = (str) => {
        return this.bf.decode(Buffer.from(str, 'base64'), Blowfish.TYPE.STRING);
      };

      const ret = {};
      Object.keys(resp.body.entries).forEach((key) => {
        ret[key] = decrypt(resp.body.entries[key]);
      });
      return ret;
    }, 1000 * 60 * 60 * 6); // 6 hours
  }

  /**
   * Get our JWT Token
   */
  async getToken() {
    let expiresIn = 1000 * 60 * 60 * 24; // default: 1 day
    return await this.cache.wrap('access_token', async () => {
      const config = await this.getConfig();
      const resp = await this.http(
        'POST',
        this.config.authURL,
        {
          client_id: config[this.config.userKey],
          client_secret: config[this.config.passKey],
          grant_type: 'client_credentials',
        },
        {
          json: true,
        },
      );

      if (!resp || !resp.body) {
        throw new Error('Failed to fetch credentials for Europa API');
      }

      expiresIn = resp.body.expires_in * 1000;
      const token = resp.body.access_token;
      return token;
    }, () => {
      return expiresIn;
    });
  }

  /**
   * Get static data for all park entities
   */
  async getParkData() {
    return await this.cache.wrap('poi', async () => {
      // get the last checksum we received
      const checksum = (await this.cache.get('poi_checksum')) || 0;
      const data = await this.http(
        'GET',
        `${this.config.apiBase}/api/v1/latest/en/live/${checksum}`,
        undefined,
        {
          json: true,
          ignoreErrors: true, // we want 404 errors
        },
      );

      if (data.body?.error?.code === 404 && checksum > 0) {
        // return old data, hasn't changed
        return await this.cache.get('poi_store');
      }

      if (!data.body.package) return undefined;

      // collapse sub fields into one array
      const entities = [];
      Object.keys(data.body.package.data).forEach((key) => {
        data.body.package.data[key].forEach((x) => {
          entities.push({
            ...x,
            entityType: key,
          });
        });
      });

      // store this data indefinitely, we'll only override it if the checksum changes
      await this.cache.set('poi_store', entities, Number.MAX_SAFE_INTEGER);
      await this.cache.set('poi_checksum', data.body.package.checksum);

      return entities;
    }, 1000 * 60 * 60 * 2); // check every 2 hours for updates
  }

  /**
   * @inheritdoc
   */
  async _init() {

  }

  /**
   * Get waiting time data from API
   */
  async getWaitingTimes() {
    return this.cache.wrap('waittingtimes', async () => {
      return (await this.http('GET', `${this.config.apiBase}/api/v1/waitingtimes`)).body;
    }, 1000 * 60);
  }

  /**
   * Get Europa Park calendar data
   */
  async getCalendar() {
    return this.cache.wrap('seasons', async () => {
      return (await this.http('GET', `${this.config.apiBase}/api/v1/seasons/en`)).body;
    }, 1000 * 60 * 60 * 6);
  }

  /**
   * @inheritdoc
   */
  async _getEntities() {
    const poiData = await this.getParkData();

    const ret = poiData.map((poi) => {
      if (poi.code === undefined || poi.code === null) return undefined;

      if (poi.type !== 'attraction') return undefined;

      // "queueing" entries are pretend entities for virtual queues
      if (poi.queueing) return undefined;

      // ignore queue map pointers
      if (poi.name.indexOf('Queue - ') === 0) return undefined;

      delete poi.versions;

      // check for virtual queue
      const nameLower = poi.name.toLowerCase();
      const vQueueData = poiData.find((x) => {
        return x.queueing && x.name.toLowerCase().indexOf(nameLower) > 0;
      });
      // virtual queue waitingtimes data
      // code === vQueueData.code
      // time can only ever be between 0-90, anything >90 is a special code
      // if time == 90, wait time is reported as 90+ in-app
      // time == 91, virtual queue is open
      // time == 999, down
      // time == 222, closed refurb
      // time == 333, closed
      // time == 444, closed becaue weather
      // time == 555, closed because ice
      // time == 666, virtual queue is "temporarily full"
      // time == 777, virtual queue is completely full
      // startAt/endAt - current virtual queue window

      const tags = [];

      tags.push({
        key: 'location',
        type: tagType.location,
        value: {
          longitude: poi.longitude,
          latitude: poi.latitude,
        },
      });

      if (poi.minHeight) {
        tags.push({
          key: 'minimumHeight',
          type: tagType.minimumHeight,
          value: {
            unit: 'cm',
            height: poi.minHeight,
          },
        });
      }

      if (poi.maxHeight) {
        tags.push({
          key: 'maximumHeight',
          type: tagType.maximumHeight,
          value: {
            unit: 'cm',
            height: poi.maxHeight,
          },
        });
      }

      return {
        id: `${poi.code}`,
        name: poi.name,
        type: attractionType.ride,
        entityType: entityType.attraction,
        tags,
        _src: {
          ...poi,
          vQueue: vQueueData,
        },
      };
    }).filter((x) => x !== undefined);

    return ret;
  }
}

export default DatabaseEuropaPark;
