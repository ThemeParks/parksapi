import {Park} from '../park.js';
import {attractionType, statusType, queueType, tagType, scheduleType} from '../parkTypes.js';

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

    // bump cache to invalidate the POI data that has been updated
    options.cacheVersion = 1;

    super(options);

    if (!this.config.apiKey) throw new Error('Missing Efteling apiKey');
    if (!this.config.apiVersion) throw new Error('Missing Efteling apiVersion');
    if (!this.config.appVersion) throw new Error('Missing Efteling appVersion');

    this.injectForDomain({
      // match either of the API domains
      $or: [
        {
          hostname: 'api.efteling.com',
        },
        {
          hostname: 'prd-search-acs.efteling.com',
        },
      ],
    }, (method, url, data, options) => {
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

    this.injectForDomain({
      // only use these headers for the main API domain
      hostname: 'api.efteling.com',
    }, (method, url, data, options) => {
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
        throw new Error('Failed to fetch Efteling POI data');
      }

      const poiData = {};
      data.forEach((hit) => {
        // skip any entries that aren't shown in the app
        if (hit.hide_in_app) return;

        if (hit.fields) {
          poiData[hit.fields.id] = {
            name: hit.fields.name,
            type: hit.fields.category,
            props: hit.fields.properties,
          };

          // try to parse lat/long
          //  edge-case: some rides have dud "0.0,0.0" location, ignore these
          if (hit.fields.latlon && hit.fields.latlon !== '0.0,0.0') {
            const match = /([0-9.]+),([0-9.]+)/.exec(hit.fields.latlon);
            if (match) {
              poiData[hit.fields.id].location = {
                latitude: Number(match[1]),
                longitude: Number(match[2]),
              };
            }
          }

          // check for any alternative versions of the ride
          //  this is usually the single rider line, though one is a "boatride"
          if (hit.fields.alternateid && hit.fields.alternatetype === 'singlerider') {
            poiData[hit.fields.id].singleRiderId = hit.fields.alternateid;
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
    const poi = await this.getPOIData();

    // auto-populate our attractions list with all rides and shows
    //  this makes them appear in our API output even if they have no wait time data
    // other valid attraction types from the Efteling API:
    //  'merchandise', 'restaurant', 'fairytale', 'facilities-toilets', 'facilities-generic', 'eventlocation', 'game'
    const wantedAttractionTypes = ['attraction', 'show'];
    await Promise.allSettled(Object.keys(poi).map(async (id) => {
      const p = poi[id];
      if (wantedAttractionTypes.indexOf(p.type) >= 0) {
        // request the attraction by ID so it is built, then we'll tag it with some metadata
        const attraction = await this.findAttractionByID(id);
        if (attraction !== undefined && p.location !== undefined) {
          // tag with attraction's location
          await this.setAttractionTag(id, 'location', tagType.location, {
            longitude: p.location.longitude,
            latitude: p.location.latitude,
          });

          // look for any other useful tags
          // may get wet
          await this.toggleAttractionTag(id, tagType.mayGetWet, p.props.indexOf('wet') >= 0);
          // tag "pregnant people should not ride" attractions
          await this.toggleAttractionTag(
              id,
              tagType.unsuitableForPregnantPeople,
              p.props.indexOf('pregnantwomen') >= 0,
          );

          // single rider queue available?
          await this.setAttractionTag(
              id,
              null,
              tagType.singleRider,
              !!p.singleRiderId,
          );

          // look for attraction minimum height
          const minHeightProp = p.props.find((prop) => prop.indexOf('minimum') === 0);
          if (minHeightProp !== undefined) {
            const minHeightNumber = Number(minHeightProp.slice(7));
            if (!isNaN(minHeightNumber)) {
              await this.setAttractionTag(id, 'minimumHeight', tagType.minimumHeight, {
                height: minHeightNumber,
                unit: 'cm',
              });
            }
          }
        }
      }
    }));
  }

  /**
   * @inheritdoc
   */
  async _buildAttractionObject(attractionID) {
    const poiData = await this.getPOIData();

    const data = poiData[attractionID];
    if (!data) return undefined;

    // assign the attraction type
    let type = attractionType.other; // default to "other" for attractions that don't match our types
    if (data.type === 'attraction') {
      // all attractions default to "ride"
      type = attractionType.ride;
    } else if (data.type ==='show') {
      type = attractionType.show;
    }

    return {
      name: data.name,
      type: type,
    };
  }

  /**
   * @inheritdoc
   */
  async _update() {
    const poiData = await this.getPOIData();

    const waitTimes = await this.http('GET', this.config.waitTimesUrl, {
      language: 'en',
    });

    const attractions = waitTimes?.body?.AttractionInfo;
    if (!attractions) throw new Error('Efteling wait times response missing AttractionInfo');

    await Promise.allSettled(attractions.map(async (entry) => {
      if (entry.Type !== 'Attraction') return;

      if (poiData[entry.Id] !== undefined) {
        let rideStatus = null;
        const rideWaitTime = parseInt(entry.WaitingTime, 10);
        const rideState = entry.State.toLowerCase();
        // update ride with wait time data
        if (rideState === 'storing' || rideState === 'tijdelijkbuitenbedrijf' || rideState === 'buitenbedrijf') {
          // Ride down because of an interruption
          rideStatus = statusType.down;
        } else if (rideState === 'inonderhoud') {
          // Ride down because of maintenance/refurbishment
          rideStatus = statusType.refurbishment;
        } else if (rideState === 'gesloten' || rideState === '' || rideState === 'wachtrijgesloten') {
          // ride is "closed"
          rideStatus = statusType.closed;
        } else if (rideState === 'open') {
          // Ride operating
          rideStatus = statusType.operating;
        }

        if (rideStatus === null) {
          this.emit('error', new Error(`Unknown Efteling rideStatus ${JSON.stringify(rideState)}`));
          console.log('Unknown Efteling rideStatus', JSON.stringify(rideState));
        }

        // update attraction status
        await this.updateAttractionState(
            entry.Id,
            rideStatus,
        );

        // update queue status
        await this.updateAttractionQueue(
            entry.Id,
            rideStatus == statusType.operating ? rideWaitTime : null,
            queueType.standBy,
        );
      } else {
        // if we don't have POI data for this attraction, check for single rider IDs and update the main attraction
        const singleRiderPOI = Object.keys(poiData).find((k) => {
          return poiData[k].singleRiderId && poiData[k].singleRiderId === entry.Id;
        });

        if (singleRiderPOI !== undefined) {
          // we have found a matching single-rider entry!
          //  update the singleRider queue time
          const rideWaitTime = parseInt(entry.WaitingTime, 10);
          await this.updateAttractionQueue(singleRiderPOI, rideWaitTime, queueType.singleRider);
        }
      }
    }));
  }

  /**
   * Get calendar data for the given month and year
   * @param {string} month
   * @param {string} year
   * @return {array<object>}
   */
  async getCalendarMonth(month, year) {
    return await this.cache.wrap(`calendar_${year}_${month}`, async () => {
      const data = await this.http(
          'GET',
          `https://www.efteling.com/service/cached/getpoiinfo/en/${year}/${month}`,
          null,
          {
            headers: {
              'X-Requested-With': 'XMLHttpRequest',
              'referer': 'https://www.efteling.com/en/park/opening-hours?app=true',
              'cookie': 'website#lang=en',
            },
            json: true,
          },
      );

      // Efteling returns 400 once the month is in the past
      if (data.statusCode === 400) {
        return undefined;
      }

      if (!data?.body?.OpeningHours) throw new Error(`Unable to find opening hours for Efteling ${data.body}`);

      return data.body;
    }, 1000 * 60 * 60 * 12); // 12 hours
  }

  /**
   * Return the operating hours for the supplied date
   * @param {moment} date
   */
  async _getOperatingHoursForDate(date) {
    const cal = await this.getCalendarMonth(date.format('M'), date.format('YYYY'));
    if (cal === undefined) return undefined;

    const dateFormatted = date.format('YYYY-MM-DD');
    const data = cal.OpeningHours.find((x) => x.Date === dateFormatted);
    if (data) {
      return data.OpeningHours.map((d) => {
        const open = d.Open.split(':').map(Number);
        const close = d.Close.split(':').map(Number);
        return {
          openingTime: date.clone().set('hour', open[0]).set('minute', open[1]).format(),
          closingTime: date.clone().set('hour', close[0]).set('minute', close[1]).format(),
          type: scheduleType.operating,
        };
      });
    }
    return undefined;
  }
}

export default Efteling;
