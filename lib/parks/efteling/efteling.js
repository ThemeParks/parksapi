import {Park} from '../park.js';

/**
 * Efteling Park Object
 */
export class Efteling extends Park {
  /**
   * Create a new Efteling Park object
   * @param {object} options
   */
  constructor(options = {}) {
    options.name = options.name || 'Efteling';
    options.timezone = options.timezone || 'Europe/Amsterdam';

    options.apiKey = '';
    options.apiVersion = '';
    options.appVersion = '';

    options.searchUrl = options.searchUrl || 'https://prd-search-acs.efteling.com/2013-01-01/search';
    options.waitTimesUrl = options.waitTimesUrl || 'https://api.efteling.com/app/wis/';

    super(options);

    if (!this.config.apiKey) throw new Error('Missing Efteling apiKey');
    if (!this.config.apiVersion) throw new Error('Missing Efteling apiVersion');
    if (!this.config.appVersion) throw new Error('Missing Efteling appVersion');

    this.injectForDomain('*.efteling.com', (method, url, data, options) => {
      // all requests from the app to any efteling subdomain should send these headers
      options.headers['x-app-version'] = this.config.appVersion;
      options.headers['x-app-name'] = 'Efteling';
      options.headers['x-app-id'] = 'nl.efteling.android';
      options.headers['x-app-platform'] = 'Android';
      options.headers['x-app-language'] = 'en';
      options.headers['x-app-timezone'] = this.config.timezone;
      // override user-agent here, rather than class-wide
      //  any other non-Efteling API requests can use the default user-agent
      options.headers['user-agent'] = 'okhttp/4.4.0';
      options.compressed = true;
    });

    this.injectForDomain('api.efteling.com', (method, url, data, options) => {
      // api.efteling.com requries an API key as well as the above headers
      options.headers['x-api-key'] = this.config.apiKey;
      options.headers['x-api-version'] = this.config.apiVersion;
    });
  }

  /**
   * Get Efteling POI data
   * This data contains general ride names, descriptions etc.
   * Wait time data references this to get ride names
   */
  async getPOIData() {
    return await this.cache.wrap('poidata', async () => {
      // curl -H 'Host: prd-search-acs.efteling.com' -H 'user-agent: okhttp/4.4.0' -H 'x-app-version: v3.7.1' -H 'x-app-name: Efteling' -H 'x-app-id: nl.efteling.android' -H 'x-app-platform: Android' -H 'x-app-language: en' -H 'x-app-timezone: Europe/London' --compressed 'https://prd-search-acs.efteling.com/2013-01-01/search?q.parser=structured&size=1000&q=%28and%20%28phrase%20field%3Dlanguage%20%27en%27%29%29'
      const fetchedPOIData = await this.http('GET', this.config.searchUrl, {
        'size': 1000,
        'q.parser': 'structured',
        'q': '(and (phrase field=language \'en\'))',
      });

      const data = fetchedPOIData?.body?.hits?.hit;
      if (!data) {
        console.log(fetchedPOIData.body);
        throw new Error('Failed to fetch Efteling POI data');
      }

      const poiData = {};
      data.forEach((hit) => {
        if (hit.fields) {
          // ignore non-attractions
          if (hit.fields.category === 'attraction') {
            poiData[hit.fields.id] = {
              name: hit.fields.name,
            };

            // try to parse lat/long
            //  edge-case: some rides have dud "0.0,0.0" location, ignore these
            if (hit.fields.latlon && hit.fields.latlon !== '0.0,0.0') {
              const match = /([0-9.]+),([0-9.]+)/.exec(hit.fields.latlon);
              if (match) {
                poiData[hit.fields.id].location = {
                  latitude: match[1],
                  longitude: match[2],
                };
              }
            }
          }
        }
      });

      return poiData;
    }, 1000 * 60 * 60 * 12 /* cache for 12 hours */);
  }

  /**
   * @inheritdoc
   */
  async _init() {
    // make sure POI data is up-to-date
    await this.getPOIData();
  }

  /**
   * @inheritdoc
   */
  async _update() {

  }
}

export default Efteling;
