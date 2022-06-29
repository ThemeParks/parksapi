import {v4 as uuid} from 'uuid';
import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, scheduleType, returnTimeState, entityType} from '../parkTypes.js';
import moment from 'moment-timezone';
import sift from 'sift';

const ignoreEntities = [
  '00000', // Avengers Campus
];

/**
 * Disneyland Paris Park Object
 */
export class DisneylandParis extends Destination {
  /**
   * Create a new DisneylandParis object
   * @param {object} options
   */
  constructor(options = {}) {
    options.name = options.name || 'Disneyland Paris';
    options.timezone = options.timezone || 'Europe/Paris';

    options.apiKey = options.apiKey || '';
    options.apiBase = options.apiBase || '';
    options.apiBaseWaitTimes = options.apiBaseWaitTimes || '';
    options.language = options.language || 'en-gb';

    options.standbyApiBase = options.standbyApiBase || '';
    options.standbyApiKey = options.standbyApiKey || '';
    options.standbyAuthURL = options.standbyAuthURL || '';

    options.standbyApiRefreshToken = options.standbyApiRefreshToken || '';

    options.premierAccessApiKey = options.premierAccessApiKey || '';
    options.premierAccessURL = options.premierAccessURL || '';

    options.useragent = options.useragent || 'okhttp/3.12.1';

    options.configPrefixes = ['DLP'].concat(options.configPrefixes || []);

    options.cacheVersion = 2;

    super(options);

    if (!this.config.apiKey) throw new Error('Missing Disneyland Paris apiKey');
    if (!this.config.apiBase) throw new Error('Missing Disneyland Paris apiBase');
    if (!this.config.apiBaseWaitTimes) throw new Error('Missing Disneyland Paris apiBaseWaitTimes');

    if (!this.config.standbyApiBase) throw new Error('Missing Disneyland Paris standbyApiBase');
    if (!this.config.standbyApiKey) throw new Error('Missing Disneyland Paris standbyApiKey');
    if (!this.config.standbyAuthURL) throw new Error('Missing Disneyland Paris standbyAuthURL');

    if (!this.config.standbyApiRefreshToken) {
      console.log(`Missing DLP standby API token - will be missing standby (virtual) queue data`);
    }

    if (!this.config.premierAccessURL) throw new Error('Missing Disneyland Paris premierAccessURL');
    if (!this.config.premierAccessApiKey) throw new Error('Missing Disneyland Paris premierAccessApiKey');

    // attraction data domain
    this.http.injectForDomain({
      hostname: new URL(this.config.apiBase).hostname,
    }, async (method, url, data, options) => {
      options.headers['x-application-id'] = 'mobile-app';
      options.headers['x-request-id'] = uuid();
      options.json = true;
    });

    // live wait time domain
    this.http.injectForDomain({
      hostname: new URL(this.config.apiBaseWaitTimes).hostname,
    }, async (method, url, data, options) => {
      options.headers['x-api-key'] = this.config.apiKey,
        options.headers.accept = 'application/json, text/plain, */*';
    });

    // virtual queue domain
    this.http.injectForDomain({
      hostname: new URL(this.config.standbyApiBase).hostname,
    }, async (method, url, data, options) => {
      const authData = await this.getAuthToken();
      if (!authData) {
        throw new Error(`Unable to get auth token for DLP virtual queue access: ${JSON.stringify(authData)}`);
      }

      options.headers['x-api-key'] = this.config.standbyApiKey;
      options.headers['authorization'] = `BEARER ${authData}`;
      options.headers.accept = 'application/json, text/plain, */*';
    });

    this.http.injectForDomainResponse({
      $or: [
        {hostname: new URL(this.config.standbyApiBase).hostname},
        {hostname: new URL(this.config.premierAccessURL).hostname}
      ],
    }, async (resp) => {
      if (resp.statusCode === 401) {
        // unset our api key so we refetch it
        console.log('Failed to get vqueue, fetch our auth key again...');
        await this.cache.set('dlp_apikey', undefined, -1);
        return undefined;
      }

      return resp;
    });

    this.http.injectForDomainResponse({
      $or: [
        {hostname: new URL(this.config.standbyApiBase).hostname},
        {hostname: new URL(this.config.premierAccessURL).hostname},
        {hostname: new URL(this.config.standbyAuthURL).hostname},
      ],
    }, async (resp) => {
      if (resp.statusCode === 400) {
        // fetch our API key and try again
        await this.cache.set('dlp_authapikey', undefined, -1);
        return undefined;
      }

      return resp;
    });

    // premier access domain
    this.http.injectForDomain({
      hostname: new URL(this.config.premierAccessURL).hostname,
    }, async (method, url, data, options) => {
      options.headers['x-api-key'] = this.config.premierAccessApiKey;
      options.headers.accept = 'application/json, text/plain, */*';
    });
  }

  /*
  async _buildAttractionObject(attractionID) {
    const parkData = await this.getParkData();

    const attr = parkData.find((x) => {
      return x.id === attractionID;
    });
    if (attr === undefined) return undefined;

    // attraction tags
    const tags = [];

    // attraction have fastpass?
    tags.push({
      type: tagType.fastPass,
      value: !!attr.fastPass,
    });

    // on-ride photos?
    tags.push({
      type: tagType.onRidePhoto,
      value: !!attr.photopass,
    });

    // single rider queue available?
    tags.push({
      type: tagType.singleRider,
      value: !!attr.singleRider,
    });

    // location
    if (attr.coordinates) {
      const entrance = attr.coordinates.find((x) => x.type === 'Guest Entrance');
      if (entrance) {
        tags.push({
          type: tagType.location,
          key: 'location',
          value: {
            longitude: entrance.lng,
            latitude: entrance.lat,
          },
        });
      }
    }

    // height tag
    if (attr.height !== undefined) {
      attr.height.forEach((height) => {
        // skip attractions for "any height"
        if (height.id === 'anyHeight') return;

        const heightVal = /([\d\.]+)\s+(\w+)/.exec(height.value);
        if (heightVal) {
          const unit = heightVal[2];
          tags.push({
            type: tagType.minimumHeight,
            key: height.id,
            value: {
              height: Number(heightVal[1]) * (unit === 'm' ? 100 : 1),
              unit: 'cm',
            },
          });
        }
      });
    }

    // may get wet
    tags.push({
      type: tagType.mayGetWet,
      value: attr.interests ? !!attr.interests.find((x) => x.id === 'guestMayGetSplashed') : false,
    });

    // pregnant riders
    tags.push({
      type: tagType.unsuitableForPregnantPeople,
      value: attr.physicalConsiderations ?
        !!attr.physicalConsiderations.find((x) => x.id === 'expectantMothersMayNotRide') :
        false,
    });

    return {
      name: attr.name,
      // TODO - sort rides from other attractions
      type: attr.contentType === 'Attraction' ? attractionType.ride : attractionType.other,
      tags,
    };
  }*/

  /**
   * Get API key for authentication
   * @returns {string}
   */
  async getAuthApiKey() {
    return await this.cache.wrap(`dlp_authapikey`, async () => {
      const data = await this.http('POST', `${this.config.standbyAuthURL}api-key`, null);
      return data?.headers?.['api-key'];
    }, 1000 * 60 * 60 * 24); // 24-hours, will be refreshed if we need to fetch a new one
  }

  /**
   * Get our latest refresh token
   */
  async getRefreshToken() {
    // return refresh token from env or local cache
    return await this.cache.wrap(`refreshtoken`, async () => {
      return this.config.standbyApiRefreshToken;
    }, 1000 * 60 * 60 * 24 * 180); // keep using cached token for 180 days
    //  we update our token in refreshAuthToken with updated token values
  }

  /**
   * Use a refresh token to get a new token object
   */
  async refreshAuthToken(refreshToken) {
    this.log('Refreshing DLP token...');
    const apiKey = await this.getAuthApiKey();

    const resp = await this.http('POST', `${this.config.standbyAuthURL}guest/refresh-auth`, {
      'refreshToken': refreshToken,
    }, {
      headers: {
        'x-api-key': apiKey,
        'authorization': `APIKEY ${apiKey}`,
        'x-requested-with': 'fr.disneylandparis.android',
        "user-agent": 'okhttp/3.14.7',
        "cache-control": "no-cache",
        "accept-language": "en-gb",
      },
      json: true,
    });

    this.log(`Receieved new refresh token ${resp?.body?.data?.token?.refresh_token}`);

    // if we get a new refresh token, store it for later use
    if (resp?.body?.data?.token?.refresh_token) {
      await this.cache.set('refreshtoken', resp?.body?.data?.token?.refresh_token, 1000 * 60 * 60 * 24 * 180);
    }

    return resp?.body?.data?.token;
  }

  /**
   * Fetch our auth token to access the HTTP API
   * @returns {string}
   */
  async getAuthToken() {
    let expiryTime = 1000 * 60 * 60; // default: 1 hour
    return await this.cache.wrap(`authtoken`, async () => {
      // use refresh token to fetch new auth token
      const token = await this.refreshAuthToken(this.config.standbyApiRefreshToken);

      expiryTime = token.ttl * 1000;

      return token.access_token;
    }, () => {
      return expiryTime;
    });
  }

  /**
   * Get Destination POI Data
   * @returns {array}
   */
  async getPOIData() {
    // cache 12 hours
    '@cache|720';
    const fetchedData = await this.http('POST', `${this.config.apiBase}/query`, {
      // eslint-disable-next-line max-len
      query: `query activities($market: String!, $types: [String]) {
        activities(market: $market, types: $types) {
          id
          closed
          contentType: __typename
          name
          subType
          entityType
          coordinates {
            lat
            lng
          }
          pageLink {
            tcmId
            regions {
              templateId
              schemaId
            }
          }
          schedules {
            status
          }
          squareMediaMobile {
            url
            alt
          }
          location {
            id
            value
            urlFriendlyId
            iconFont
          }
          guestPolicies
          hideFunctionality
          ... on Attraction {
            age {
              ...f
            }
            height {
              ...f
            }
            interests {
              ...f
            }
            photopass
            fastPass
            singleRider
            mobilityDisabilities {
              ...f
            }
            serviceAnimals {
              ...f
            }
            physicalConsiderations {
              ...f
            }
          }
          ... on Entertainment {
            relatedLocations {
              ...r
            }
            duration {
              ...duration
            }
            openDate
            endDate
            photopass
            schedules {
              startTime
              date
            }
            interests {
              ...f
            }
            age {
              ...f
            }
            entertainmentTypes {
              ...f
            }
            mobilityDisabilities {
              ...f
            }
          }
          ... on Event {
            relatedLocations {
              ...r
            }
            duration {
              ...duration
            }
            interests {
              ...f
            }
            mobilityDisabilities {
              ...f
            }
            experienceTypes {
              ...f
            }
            age {
              ...f
            }
          }
          ... on GuestService {
            guestServices {
              ...f
            }
            relatedLocations {
              ...r
              poi {
                name
                location {
                  value
                  pageLink {
                    tcmId
                    regions {
                      templateId
                      schemaId
                    }
                  }
                }
                smallMedia {
                  url
                  alt
                }
              }
            }
          }
          ... on Recreation {
            relatedLocations {
              ...r
            }
          }
          ... on Resort {
            disneyOwned
            hotelBeingRefurbished
            tier
            hotelCharacteristics {
              ...f
            }
            hotelTypes {
              ...f
            }
            hotelCategories {
              ...f
            }
            hotelParkDistances {
              ...f
            }
            hotelAmenities {
              ...f
            }
          }
          ... on DinnerShow {
            cuisines {
              ...f
            }
            serviceTypes {
              ...f
            }
            price {
              ...f
            }
            diningPlans {
              ...f
            }
          }
          ... on DiningEvent {
            cuisines {
              ...f
            }
            serviceTypes {
              ...f
            }
            price {
              ...f
            }
            diningPlans {
              ...f
            }
          }
          ... on Restaurant {
            drsApp
            clickAndCollect
            cuisines {
              ...f
            }
            serviceTypes {
              ...f
            }
            price {
              ...f
            }
            diningPlans {
              ...f
            }
          }
          ... on Shop {
            schedules {
              startTime
              endTime
            }
            merchandises {
              ...f
            }
            mobilityDisabilities {
              ...f
            }
          }
          ... on Spa {
            relatedLocations {
              ...r
            }
            serviceTypes {
              ...f
            }
            interests {
              ...f
            }
          }
          ... on Tour {
            interests {
              ...f
            }
            duration {
              ...duration
            }
            mobilityDisabilities {
              ...f
            }
            experienceTypes {
              ...f
            }
            age {
              ...f
            }
          }
        }
      }
      fragment duration on Duration {
        hours
        minutes
      } 
      fragment r on RelatedLocation {
        type
        poi {
          coordinates {
            lat
            lng
          }
        }
      }
      fragment f on Facet {
        id
        value
        urlFriendlyId
        iconFont
      }`,
      variables: {
        market: this.config.language,
        types: [
          'Attraction',
          'DiningEvent',
          'DinnerShow',
          'Entertainment',
          'Event',
          'GuestService',
          'Recreation',
          'Resort',
          'Restaurant',
          'Shop',
          'Spa',
          'Tour',
          'ThemePark',
        ],
      },
    });

    return fetchedData.body.data.activities;
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
    entity._tags = [];

    // try and find location data
    if (data?.coordinates) {
      const entrance = data.coordinates.find((x) => x.type === 'Guest Entrance' || x.type === undefined);
      if (entrance) {
        entity.location = {
          longitude: entrance.lng,
          latitude: entrance.lat,
        };
      }
    }

    // facets
    if (data?.height) {
      const noHeightLimit = !!data.height.find((x) => x.id === 'anyHeight');
      if (!noHeightLimit) {
        // TODO - find mix/max height
        const minHeightData = data.height.find((x) => x.iconFont.indexOf('min-height') > -1);
        if (minHeightData) {
          const val = minHeightData.value.split(' ');
          if (val[1] === 'm') {
            entity._tags.push({
              id: 'minimumHeight',
              value: Number(Number(val[0]) * 100),
            });
          } else if (val[1] === 'cm') {
            entity._tags.push({
              id: 'minimumHeight',
              value: Number(Number(val[0])),
            });
          } else {
            // TODO - emit error
            console.error('Unknown height unit', val);
          }
        }
      } else {
        entity._tags.push({
          id: 'minimumHeight',
          value: 0,
        });
      }
    }

    // this policy line takes priotity over any other tags
    if (data?.guestPolicies) {
      if (data.guestPolicies.indexOf('Expectant Mothers may not ride') >= 0) {
        entity._tags.push({
          id: 'suitableForPregnantPeople',
          value: false,
        });
      }
    }
    if (!entity._tags.find((x) => x.id === 'suitableForPregnantPeople') && data?.mobilityDisabilities) {
      // find pregnancy tag
      const pregnancy = data.mobilityDisabilities.find((x) => x.id === 'accessibleToPregnantWomen');
      if (pregnancy) {
        // major discrepencies between accessibility brochure (https://brochure.disneylandparis.com/HCP/UK/catalogue/index.html)
        //  and the DLP app. Not comfortable in reporting any ride as "suitable".
        // will keep an eye on, and likely manually evaluate rides as app data is useless here.
        /*entity._tags.push({
          id: 'suitableForPregnantPeople',
          value: true,
        });*/
      }
    }
    if (!entity._tags.find((x) => x.id === 'suitableForPregnantPeople') && data?.physicalConsiderations) {
      // find rides explicitly marked as not suitable for pregnant people
      const pregnancy = data.physicalConsiderations.find((x) => x.id === 'expectantMothersMayNotRide');
      if (pregnancy) {
        entity._tags.push({
          id: 'suitableForPregnantPeople',
          value: false,
        });
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
      _id: 'dlp',
      name: this.config.name,
      slug: 'disneylandparis',
      entityType: entityType.destination,
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    // find all destination parks
    const poiData = await this.getPOIData();
    const parks = poiData.filter((x) => {
      return x.contentType === 'ThemePark';
    });

    // parks like to vanish from the POI data sometimes (???)
    //  inject Studios manually into returned data if it's not in the API
    if (parks.findIndex((x) => x.id === 'P2') === -1) {
      parks.push({
        "id": "P2",
        "name": "Walt Disney Studios Park",
        "coordinates": [
          {
            "lat": 48.868391,
            "lng": 2.780802,
            "type": "Guest Entrance"
          }
        ],
      });
    }

    const destination = await this.buildDestinationEntity();

    return parks.map((x) => {
      return {
        ...this.buildBaseEntityObject(x),
        _destinationId: destination._id,
        _parentId: destination._id,
        slug: x.name.toLowerCase().replace(/[^a-z]/g, ''),
        entityType: entityType.park,
      };
    });
  }

  async filterPOIData(filterObj) {
    const parkData = await this.getPOIData();
    if (!parkData) return [];

    const attrs = parkData.filter(sift({
      location: {
        $or: [
          {
            id: "P1",
          },
          {
            id: "P2",
          },
        ],
      },
      hideFunctionality: {
        $and: [
          {
            $ne: "Hide from Web List + Mobile App",
          },
          {
            $ne: "Hide from the Service",
          },
        ],
      },
      $or: [
        {
          hideFunctionality: {
            $or: [
              {
                $eq: "",
              },
              {
                $eq: "Hide from Web",
              },
              {
                $eq: "Hide from the Listing Page",
              },
            ],
          },
        },
        {
          // return if attraction marked for REFURBISHMENT, even if hidden from app
          schedules: {
            $elemMatch: {
              status: "REFURBISHMENT",
            },
          },
        }
      ],
      ...filterObj,
    }));

    return attrs;
  }

  async getEntitiesOfTypes(filterObj, data) {
    const attrs = await this.filterPOIData(filterObj);

    const destination = await this.buildDestinationEntity();

    return attrs.map((x) => {
      // skip placeholders
      if (ignoreEntities.indexOf(x?.id) >= 0) return undefined;

      return {
        ...this.buildBaseEntityObject(x),
        ...data,
        _destinationId: destination._id,
        _parentId: x?.location?.id,
        _parkId: x?.location?.id,
      };
    }).filter((x) => !!x).filter((x) => {
      // remove any entities with invalid locations (placeholder/defunct)
      return x.location?.longitude !== 0 && x.location?.latitude !== 0;
    });
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    return this.getEntitiesOfTypes({
      entityType: 'attractions',
    }, {
      entityType: entityType.attraction,
      attractionType: attractionType.ride,
    });
  }

  _getShowSubtypes() {
    return [
      "Stage Show",
      "Fireworks",
      "Atmosphere",
      "Parade",
    ];
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    return this.getEntitiesOfTypes({
      $or: this._getShowSubtypes().map((x) => {
        return {
          subType: x,
        };
      }),
    }, {
      entityType: entityType.show,
    });
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    return this.getEntitiesOfTypes({
      contentType: "Restaurant",
    }, {
      entityType: entityType.restaurant,
    });
  }

  /**
   * Get wait time raw data
   * @returns {object}
   */
  async fetchWaitData() {
    '@cache|1';
    try {
      return (await this.http('GET', `${this.config.apiBaseWaitTimes}waitTimes`)).body;
    } catch (e) {
      console.error(`DLP error: getResortWaitTimes ${e}`);
      throw e;
    }
  }

  /**
   * Fetch virtual queue status
   * @returns {array}
   */
  async fetchVirtualQueueData() {
    '@cache|1';
    // skip if we have no auth token refresher
    if (!this.config.standbyApiRefreshToken) {
      return [];
    }

    try {
      const standByVirtualData = await this.http('GET', this.config.standbyApiBase);
      return standByVirtualData.body;
    } catch (e) {
      console.error(`DLP error: getResortVirtualQueues ${e}`);
      throw e;
    }
  }

  /**
   * Fetch premier access data
   * @returns {array}
   */
  async fetchPremierAccessData() {
    '@cache|1';
    // skip if we have no premier access API Key
    if (!this.config.premierAccessApiKey) {
      return [];
    }

    try {
      const standByPremierData = await this.http('GET', this.config.premierAccessURL);
      return standByPremierData.body;
    } catch (e) {
      console.error(`DLP error: getResortPremierAccess ${e}`);
      throw e;
    }
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    // this function should return all the live data for all entities in this destination
    const waits = await this.fetchWaitData();

    if (!Array.isArray(waits)) {
      // DLP is offline (?!)
      //  DLP servers go offline briefly most nights
      return [];
    }

    // virtual queue data
    const vQData = await this.fetchVirtualQueueData();

    // premier access data
    const premierAccessData = await this.fetchPremierAccessData();

    // today's schedule data
    const today = this.getTimeNowMoment().format('YYYY-MM-DD');
    const scheduleData = await this.fetchResortScheduleForDate(today);

    // get POI data for shows so we can use their duration data
    const showPOIData = await this.filterPOIData({
      $or: this._getShowSubtypes().map((x) => {
        return {
          subType: x,
        };
      }),
    });

    const livedata = waits.filter((x) => x.type === 'Attraction').map((time) => {
      const live = {
        _id: time.entityId,
        status: statusType.operating,
      };

      if (time.status === 'DOWN') {
        live.status = statusType.down;
      } else if (time.status === 'REFURBISHMENT') {
        // it may say "refurbishment", but the DLP app actaully displays this as "Closed"
        // live.status = statusType.refurbishment;
        live.status = statusType.closed;
      } else if (time.status === 'CLOSED' || time.status === null) {
        live.status = statusType.closed;
      }

      // stand-by time
      live.queue = {
        [queueType.standBy]: {
          waitTime: live.status === statusType.operating ?
            Number(time.postedWaitMinutes) :
            null,
        },
      };

      // single-rider time
      if (time.singleRider?.isAvailable === true) {
        live.queue[queueType.singleRider] = {
          waitTime: live.status === statusType.operating ?
            Number(time.singleRider.singleRiderWaitMinutes) :
            null,
        };
      }

      // look for virtual queue entries
      const rideVQueue = vQData && vQData.find((x) => x?.attractionId == time.entityId);
      if (rideVQueue !== undefined) {
        live.queue[queueType.returnTime] = {
          returnStart: rideVQueue.timeSlotStartDatetime ? moment.tz(rideVQueue.timeSlotStartDatetime, 'YYYY-MM-DD HH:mm', this.config.timezone).format() : null,
          returnEnd: rideVQueue.timeSlotEndDatetime ? moment.tz(rideVQueue.timeSlotEndDatetime, 'YYYY-MM-DD HH:mm', this.config.timezone).format() : null,
          state: rideVQueue.uiStatus === 'Available' ? returnTimeState.available : returnTimeState.finished,
        };
      }

      // look for premier access entries
      const access = premierAccessData && premierAccessData.find((x) => x?.attractionId == time.entityId);
      if (access !== undefined) {
        live.queue[queueType.paidReturnTime] = {
          returnStart: access.nextTimeSlotStartDateTime ? moment.tz(access.nextTimeSlotStartDateTime, this.config.timezone).format() : null,
          returnEnd: access.nextTimeSlotEndDateTime ? moment.tz(access.nextTimeSlotEndDateTime, this.config.timezone).format() : null,
          state: !!access.available ? returnTimeState.available : returnTimeState.finished,
          price: {
            currency: 'EUR',
            amount: access.price ? access.price * 100 : null,
          },
        };
      }

      return live;
    });

    // find all running shows
    scheduleData.forEach((sched) => {
      if (!sched?.schedules) return;

      const performances = sched.schedules.filter((s) => {
        return s.status === 'PERFORMANCE_TIME';
      });

      if (performances.length > 0) {
        // find show length from POI data
        let showDuration = 0; 
        const show = showPOIData.find((x) => x?.id === sched.id);
        if (show && show.duration) {
          // calculate show duration in minutes
          showDuration = (show.duration.minutes || 0) + ((show.duration.hours || 0) * 60);
        }

        // generate showtime data
        const showtimes = performances.map((p) => {
          const endTimeString = showDuration === 0 ? p.endTime : p.startTime;
          return {
            startTime: moment.tz(`${today}T${p.startTime}`, 'YYYY-MM-DDTHH:mm:ss', this.config.timezone).format(),
            endTime: moment.tz(`${today}T${endTimeString}`, 'YYYY-MM-DDTHH:mm:ss', this.config.timezone).add(showDuration, 'minutes').format(),
            type: "Performance Time",
          };
        });

        // look for existing livedata and inject, or create new entry
        const existingEntry = livedata.find((x) => x._id === sched.id);
        if (existingEntry) {
          existingEntry.showtimes = showtimes;
        } else {
          livedata.push({
            _id: sched.id,
            status: statusType.operating,
            showtimes,
          });
        }
      }
    });

    return livedata;
  }

  /**
   * Fetch schedule data for a specific day
   * DLP's API returns one day at a time
   * @param {string} date YYYY-MM-DD format
   * @returns {array<schedule>}
   */
  async fetchResortScheduleForDate(date) {
    // cache for a week
    '@cache|10080';
    const fetchedData = await this.http('POST', `${this.config.apiBase}/query`, {
      // eslint-disable-next-line max-len
      'query': 'query activitySchedules($market: String!, $types: [ActivityScheduleStatusInput]!, $date: String!) { activitySchedules(market: $market, date: $date, types: $types) { __typename id name subType url pageLink { url regions { contentId templateId schemaId } } heroMediaMobile { url alt } squareMediaMobile { url alt } hideFunctionality containerTcmId urlFriendlyId location { ...location } subLocation { ...location } type subType schedules(date: $date, types: $types) { startTime endTime date status closed language } } } fragment location on Location { id value urlFriendlyId iconFont pageLink { url tcmId title regions { contentId templateId schemaId } } } ',
      'variables': {
        'market': 'en-gb',
        'types': [{
          'type': 'ThemePark',
          'status': ['OPERATING', 'EXTRA_MAGIC_HOURS'],
        }, {
          'type': 'Entertainment',
          'status': ['PERFORMANCE_TIME'],
        }, {
          'type': 'Attraction',
          'status': ['OPERATING', 'REFURBISHMENT', 'CLOSED'],
        }, {
          'type': 'Resort',
          'status': ['OPERATING', 'REFURBISHMENT', 'CLOSED'],
        }, {
          'type': 'Shop',
          'status': ['REFURBISHMENT', 'CLOSED'],
        }, {
          'type': 'Restaurant',
          'status': ['REFURBISHMENT', 'CLOSED', 'OPERATING'],
        }, {
          'type': 'DiningEvent',
          'status': ['REFURBISHMENT', 'CLOSED'],
        }, {
          'type': 'DinnerShow',
          'status': ['REFURBISHMENT', 'CLOSED'],
        }],
        'date': date,
      },
    });

    return fetchedData.body.data.activitySchedules;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    // TODO - fetch schedule data some way into the future
    const now = this.getTimeNowMoment();
    const end = now.clone().add(60, 'days');

    const scheduleData = [];
    const momentParseFormat = 'YYYY-MM-DDTHH:mm:ss';

    for (; now.isSameOrBefore(end, 'day'); now.add(1, 'day')) {
      const dateString = now.format('YYYY-MM-DD');
      const dateData = await this.fetchResortScheduleForDate(dateString);
      if (!dateData) continue;

      dateData.forEach((x) => {
        if (ignoreEntities.indexOf(x?.id) >= 0) return;

        let sched = scheduleData.find((a) => a._id === x.id);
        if (!sched) {
          sched = scheduleData[scheduleData.push({
            _id: x.id,
            schedule: [],
          }) - 1];
        }

        x.schedules.forEach((hours) => {
          const open = moment.tz(`${dateString}T${hours.startTime}`, momentParseFormat, this.config.timezone);
          const close = moment.tz(`${dateString}T${hours.endTime}`, momentParseFormat, this.config.timezone);
          // handle closing times after midnight
          if (close.isBefore(open)) {
            close.add(1, 'day');
          }
          sched.schedule.push({
            date: dateString,
            openingTime: open.format(),
            closingTime: close.format(),
            // our graphql query only wants types of "OPERATING" or "EXTRA_MAGIC_HOURS", so we can ternery op this
            type: hours.status === 'EXTRA_MAGIC_HOURS' ? scheduleType.extraHours : scheduleType.operating,
            description: hours.status === 'EXTRA_MAGIC_HOURS' ? 'Extra Magic Hours' : undefined,
          });
        });
      });
    }

    return scheduleData;
  }


}

export default DisneylandParis;

/*
export class DisneylandParisMagicKingdom extends DisneylandParis {
  constructor(options = {}) {
    options.name = options.name || 'Disneyland Paris - Magic Kingdom';
    options.parkId = options.parkId || 'P1';
    super(options);
  }
}

export class DisneylandParisWaltDisneyStudios extends DisneylandParis {
  constructor(options = {}) {
    options.name = options.name || 'Disneyland Paris - Walt Disney Studios';
    options.parkId = options.parkId || 'P2';
    super(options);
  }
}
*/