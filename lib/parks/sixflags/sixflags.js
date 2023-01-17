import moment from 'moment-timezone';
import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';

export class SixFlags extends Destination {
  constructor(options = {}) {
    // all destinations must have a timezone, allow overriding in constructor
    options.timezone = options.timezone || 'Europe/Berlin';

    options.baseURL = options.baseURL || 'https://api.sixflags.net';
    options.authHeader = options.authHeader || '';

    super(options);

    if (!this.config.authHeader) throw new Error('Missing authHeader');

    // setup some API hooks
    //  we can automatically auth/react to any http requests without having to constantly rewrite the same login logic
    const baseURLHostname = new URL(this.config.baseURL).hostname;

    // setup an "injection" for a domain
    //  first argument is a sift query object that can query any parameters of a URL object
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      if (!options.skipAuth) {
        const authToken = await this.fetchAuthToken();
        options.headers = {
          ...options.headers,
          Authorization: `Bearer ${authToken}`,
        };
      }
    });

    // respond to any 401 errors
    this.http.injectForDomainResponse({
      hostname: baseURLHostname,
    }, async (resp) => {
      if (resp.statusCode === 401) {
        // auth token expired, wipe it and try again
        await this._clearFunctionCache('fetchAuthToken');

        throw new Error('Auth token expired, try again');
      }

      return resp;
    });
  }

  async fetchAuthToken() {
    '@cache|10d'; // cache for 10 days
    const resp = await this.http.post(`${this.config.baseURL}/Authentication/identity/connect/token`, {
      grant_type: 'client_credentials',
      scope: 'mobileApp',
    }, {
      headers: {
        'Authorization': `Basic ${this.config.authHeader}`,
      },
      skipAuth: true,
    });

    return resp.body.access_token;
  }

  async fetchAllDestinations() {
    '@cache|1d'; // cache for 1 day
    const resp = await this.http.get(`${this.config.baseURL}/mobileapi/v1/park`);
    return resp.body;
  }

  async fetchRidePOI({parkID}) {
    '@cache|1d'; // cache for 1 day
    const resp = await this.http.get(`${this.config.baseURL}/mobileapi/v1/park/${parkID}/ride`);
    return resp.body;
  }

  async fetchRestaurantPOI({parkID}) {
    '@cache|1d'; // cache for 1 day
    const resp = await this.http.get(`${this.config.baseURL}/mobileapi/v1/park/${parkID}/restaurant`);
    return resp.body;
  }

  async fetchShowPOI({parkID}) {
    '@cache|1d'; // cache for 1 day
    const resp = await this.http.get(`${this.config.baseURL}/mobileapi/v1/park/${parkID}/entertainment`);
    return resp.body;
  }

  async fetchRideStatus({parkID}) {
    '@cache|60'; // cache for 1 minute
    const resp = await this.http.get(`${this.config.baseURL}/mobileapi/v1/park/${parkID}/rideStatus`);
    return resp.body;
  }

  async fetchParkHours({parkID}) {
    '@cache|1h'; // cache for 1 hour
    const resp = await this.http.get(`${this.config.baseURL}/mobileapi/v1/park/${parkID}/hours`);
    return resp.body;
  }

  /**
   * Helper function to build a basic entity document
   * Useful to avoid copy/pasting
   * @param {object} data 
   * @returns {object}
   */
  buildBaseEntityObject(data) {
    const entity = Destination.prototype.buildBaseEntityObject.call(this, data);

    if (!data) {
      return entity;
    }

    if (data.name) {
      entity.name = data.name;
    }

    if (data.location && data.location.latitude && data.location.longitude) {
      entity.location = {
        longitude: data.location.longitude,
        latitude: data.location.latitude,
      };
    } else if (data.entranceLocation && data.entranceLocation.latitude && data.entranceLocation.longitude) {
      entity.location = {
        longitude: data.entranceLocation.longitude,
        latitude: data.entranceLocation.latitude,
      };
    }

    if (!entity.location && data.park && data.park.location && data.park.location.latitude && data.park.location.longitude) {
      // no location data, try to get it from the park
      entity.location = {
        longitude: data.park.location.longitude,
        latitude: data.park.location.latitude,
      };
    }

    // guess entity timezone from location
    if (entity.location && entity.location.latitude && entity.location.longitude) {
      try {
        entity.timezone = this.calculateTimezone(entity.location.latitude, entity.location.longitude);
      } catch (e) { }
    }

    return entity;
  }

  async _getParkData() {
    '@cache|1d'; // cache for 1 day
    const destinations = await this.fetchAllDestinations();
    return destinations.parks.filter((x) => !x.isWaterPark);
  }

  async _getParkIDs() {
    '@cache|1d'; // cache for 1 day
    const destinations = await this._getParkData();
    return destinations.map(destination => destination.parkId);
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    const destinations = await this._getParkData();
    return destinations.map(destination => {
      return {
        ...this.buildBaseEntityObject(destination),
        _id: `sixflags_destination_${destination.parkId}`,
        slug: destination.name.replace(/\s+/g, '-').replace(/[^a-zA-Z-]/, '').toLowerCase(),
        entityType: entityType.destination,
      };
    });
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    const destinations = await this._getParkData();
    return destinations.map((destination) => {
      return {
        ...this.buildBaseEntityObject(destination),
        _id: `park_${destination.parkId}`,
        _destinationId: `sixflags_destination_${destination.parkId}`,
        _parentId: `sixflags_destination_${destination.parkId}`,
        entityType: entityType.park,
      };
    });
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const parksToFetch = await this._getParkIDs();
    const parks = await this._getParkData();

    const attractionEntities = [];
    for (const park of parksToFetch) {
      const ridePOI = await this.fetchRidePOI({parkID: park});
      const parkData = parks.find(x => x.parkId === park);

      attractionEntities.push(...ridePOI.rides.map(attraction => {
        return {
          ...this.buildBaseEntityObject({
            ...attraction,
            park: parkData,
          }),
          _id: `attraction_${attraction.rideId}`,
          _parkId: `park_${park}`,
          _parentId: `park_${park}`,
          _destinationId: `sixflags_destination_${park}`,
          entityType: entityType.attraction,
          attractionType: attractionType.ride,
        };
      }));
    }

    return attractionEntities;
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    const parksToFetch = await this._getParkIDs();
    const parks = await this._getParkData();

    const showEntities = [];
    for (const park of parksToFetch) {
      const showsPOI = await this.fetchShowPOI({parkID: park});
      const parkData = parks.find(x => x.parkId === park);

      const showObj = showsPOI?.shows;
      if (!showObj) {
        continue;
      }

      showEntities.push(...showObj.map(show => {
        return {
          ...this.buildBaseEntityObject({
            ...show,
            park: parkData,
          }),
          _id: `show_${show.showId}`,
          _parkId: `park_${park}`,
          _parentId: `park_${park}`,
          _destinationId: `sixflags_destination_${park}`,
          entityType: entityType.show,
        };
      }));
    }

    return showEntities;
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    const parksToFetch = await this._getParkIDs();
    const parks = await this._getParkData();

    const restaurantEntities = [];
    for (const park of parksToFetch) {
      const restaurantPOIs = await this.fetchRestaurantPOI({parkID: park});
      const parkData = parks.find(x => x.parkId === park);

      restaurantEntities.push(...restaurantPOIs.restaurants.map(show => {
        return {
          ...this.buildBaseEntityObject({
            ...show,
            park: parkData,
          }),
          _id: `restaurant_${show.restaurantId}`,
          _parkId: `park_${park}`,
          _parentId: `park_${park}`,
          _destinationId: `sixflags_destination_${park}`,
          entityType: entityType.restaurant,
        };
      }));
    }

    return restaurantEntities;
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const parksToFetch = await this._getParkIDs();
    const parkEntities = await this.getParkEntities();

    const liveData = [];
    for (const park of parksToFetch) {
      const parkData = await this.fetchRideStatus({parkID: park});
      const parkEntity = parkEntities.find(x => x._id === `park_${park}`);
      if (!parkEntity) continue;

      liveData.push(...parkData.rideStatuses.map(ride => {
        const rideLiveData = {
          _id: `attraction_${ride.rideId}`,
          status: statusType.closed,
        };

        switch (ride.status) {
          case 'AttractionStatusOpen':
            rideLiveData.status = statusType.operating;
            break;
          case 'AttractionStatusClosed':
          case 'AttractionStatusClosedForSeason':
          case 'AttractionStatusComingSoon':
            rideLiveData.status = statusType.closed;
            break;
          case 'AttractionStatusTemporarilyClosed':
            rideLiveData.status = statusType.down;
            break;
          default:
            this.log(`Unknown ride status: ${ride.status}`);
            break;
        }

        const waitTime = rideLiveData.status !== statusType.operating ? null : Number(ride.waitTime);
        rideLiveData.queue = {
          [queueType.standBy]: {
            waitTime: isNaN(waitTime) ? null : waitTime,
          },
        };

        return rideLiveData;
      }));

      // also fetch show times
      const showsPOI = await this.fetchShowPOI({parkID: park});
      if (showsPOI?.shows) {
        liveData.push(...showsPOI.shows.map(show => {
          const showLiveData = {
            _id: `show_${show.showId}`,
            status: statusType.operating,
          };

          if (show.startTimes && show.startTimes.length > 0) {
            showLiveData.showTimes = show.startTimes.map((x) => {
              const showTime = moment.tz(x, 'YYYY-MM-DDTHH:mm:ss', parkEntity.timezone);
              const showEndTime = showTime.clone();

              // try to figure out show end time
              //  sometimes it's just a number, sometimes it's a number with "min" appended
              if (show.duration) {
                const regexMinutes = /^([0-9]+) min$/;
                const match = regexMinutes.exec(show.duration);
                if (match) {
                  showEndTime.add(Number(match[1]), 'minutes');
                } else {
                  const assumeMinutes = /^([0-9]+)$/;
                  const match = assumeMinutes.exec(show.duration);
                  if (match) {
                    showEndTime.add(Number(match[1]), 'minutes');
                  } else {
                    this.log(`Unknown show duration: ${show.duration}`);
                  }
                }
              }

              return {
                startTime: showTime.format(),
                endTime: showEndTime.format(),
                type: "Performance Time",
              };
            })
          }

          return showLiveData;
        }).filter((x) => !!x));
      }
    }

    return liveData;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const parksToFetch = await this._getParkIDs();

    const parkEntities = await this.getParkEntities();

    const schedules = [];
    for (const park of parksToFetch) {
      const parkData = await this.fetchParkHours({parkID: park});
      const parkEntity = parkEntities.find(x => x._id === `park_${park}`);
      if (!parkEntity) continue;

      schedules.push({
        _id: `park_${park}`,
        schedule: parkData.operatingHours.map((x) => {
          return {
            // date use first 10 digits of unix timestamp
            date: x.operatingDate.substring(0, 10),
            type: "OPERATING",
            openingTime: moment.tz(x.open, "YYYY-MM-DDTHH:mm:ss", parkEntity.timezone).format(),
            closingTime: moment.tz(x.close, "YYYY-MM-DDTHH:mm:ss", parkEntity.timezone).format(),
          };
        }).filter(x => !!x),
      });
    }

    return schedules;
  }
}
