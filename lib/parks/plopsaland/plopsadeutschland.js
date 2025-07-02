import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import moment from 'moment-timezone';

/**
 * Plopsaland Deutschland theme park implementation
 * @since 2025
 */
export class PlopsalandDeutschland extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Europe/Berlin';

    // Base API URL for Plopsaland Deutschland
    options.baseURL = options.baseURL || '';
    options.parkId = options.parkId || 'plopsaland-deutschland';
    options.language = options.language || 'en';

    super(options);

    if (!this.config.baseURL) throw new Error('Missing baseURL');
    if (!this.config.parkId) throw new Error('Missing parkId');

    // Setup API injection for the domain
    const baseURLHostname = new URL(this.config.baseURL).hostname;
    this.http.injectForDomain({
      hostname: baseURLHostname,
    }, async (method, url, data, options) => {
      // Add default headers if needed
      // TODO - Add authentication if required
    });
  }

  /**
   * Get points of interest data (attractions, restaurants, shops, etc.)
   */
  async getPointsOfInterest() {
    '@cache|360'; // cache for 6 hours
    const resp = await this.http('GET', `${this.config.baseURL}/points-of-interest`, {
      language: this.config.language,
      park: this.config.parkId,
    });
    return resp.body;
  }

  /**
   * Get waiting times for attractions
   */
  async getWaitingTimes() {
    '@cache|1'; // cache for 1 minute
    const resp = await this.http('GET', `${this.config.baseURL}/attractions/waiting-times`, {
      language: this.config.language,
      park: this.config.parkId,
    });
    return resp.body;
  }

  /**
   * Get park opening hours
   */
  async getParkHours() {
    '@cache|360'; // cache for 6 hours
    const nowInParkTimezone = this.getTimeNowMoment();
    const startDate = nowInParkTimezone.clone().format('YYYY-MM-DD');
    const endDate = nowInParkTimezone.clone().add(3, 'months').format('YYYY-MM-DD');
    const resp = await this.http('GET', `https://www.plopsa.com/en/plopsaland-deutschland/api/opening-hours-calendar`, {
      start: startDate,
      end: endDate,
    });
    return resp.body;
  }

  /**
   * Get entertainment/shows schedule
   */
  async getEntertainmentProgram() {
    '@cache|60'; // cache for 1 hour
    const resp = await this.http('GET', `${this.config.baseURL}/entertainments/day_program`, {
      language: this.config.language,
      park: this.config.parkId,
    });
    return resp.body;
  }

  /**
   * Convert image coordinates on the park map to geographical coordinates
   * This uses a linear transformation based on known control points on the park map image
   * to convert pixel coordinates (x, y) to longitude and latitude.
   * Gives a good enough approximation for the park map.
   * @param {number} x 
   * @param {number} y 
   * @returns 
   */
  imageToCoordinates(x, y) {
    let transformCoefficients = null;

    // generate our transform coefficients if not already done
    if (transformCoefficients === null) {
      // known control points on the park map image
      const controlPoints = [
        // Sky Scream
        {pixel: {x: 1301, y: 457}, geo: {lat: 49.319340577718215, lon: 8.29254336959917}},
        // lighthouse tower
        {pixel: {x: 1237, y: 315}, geo: {lat: 49.31888886637556, lon: 8.29163056371229}},
        // dinosplash
        {pixel: {x: 954, y: 1019}, geo: {lat: 49.3187872288459, lon: 8.297126723709829}},
        // splash battle
        {pixel: {x: 1105, y: 810}, geo: {lat: 49.31921368348008, lon: 8.295472339476438}},
        // beach resuce
        {pixel: {x: 1103, y: 298}, geo: {lat: 49.31859964484687, lon: 8.29199916066343}},
        // smurfs adventure
        {pixel: {x: 1131, y: 991}, geo: {lat: 49.319341, lon: 8.296514}},
        // red baron
        {pixel: {x: 1108, y: 479}, geo: {lat: 49.31838591416893, lon: 8.293468523154518}},
        // the frogs
        {pixel: {x: 602, y: 1544}, geo: {lat: 49.318147, lon: 8.300963}},
        // geforce
        {pixel: {x: 678, y: 1022}, geo: {lat: 49.317542883557145, lon: 8.29789694573585}},
      ];
      const transpose = (matrix) => {
        return matrix[0].map((_, colIndex) => matrix.map(row => row[colIndex]));
      };
      const multiply = (a, b) => {
        const aNumRows = a.length, aNumCols = a[0].length, bNumCols = b[0].length;
        const m = new Array(aNumRows);
        for (let r = 0; r < aNumRows; ++r) {
          m[r] = new Array(bNumCols).fill(0);
          for (let c = 0; c < bNumCols; ++c) {
            for (let i = 0; i < aNumCols; ++i) {
              m[r][c] += a[r][i] * b[i][c];
            }
          }
        }
        return m;
      };
      const invert3x3 = (m) => {
        const det = m[0][0] * (m[1][1] * m[2][2] - m[2][1] * m[1][2]) -
          m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
          m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

        if (det === 0) {
          console.error("Matrix is singular and cannot be inverted.");
          return null;
        }

        const invDet = 1 / det;
        const inv = [
          new Array(3), new Array(3), new Array(3)
        ];

        inv[0][0] = (m[1][1] * m[2][2] - m[2][1] * m[1][2]) * invDet;
        inv[0][1] = (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * invDet;
        inv[0][2] = (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * invDet;
        inv[1][0] = (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * invDet;
        inv[1][1] = (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * invDet;
        inv[1][2] = (m[1][0] * m[0][2] - m[0][0] * m[1][2]) * invDet;
        inv[2][0] = (m[1][0] * m[2][1] - m[2][0] * m[1][1]) * invDet;
        inv[2][1] = (m[2][0] * m[0][1] - m[0][0] * m[2][1]) * invDet;
        inv[2][2] = (m[0][0] * m[1][1] - m[1][0] * m[0][1]) * invDet;

        return inv;
      };
      const calculateTransformCoefficients = () => {
        // A matrix: Each row is [x, y, 1] for a control point.
        const A = controlPoints.map(p => [p.pixel.x, p.pixel.y, 1]);

        // b vectors: one for longitude, one for latitude.
        const b_lon = controlPoints.map(p => [p.geo.lon]);
        const b_lat = controlPoints.map(p => [p.geo.lat]);

        // Calculate A^T (A transpose)
        const AT = transpose(A);

        // Calculate A^T * A
        const ATA = multiply(AT, A);

        // Calculate (A^T * A)^-1
        const ATA_inv = invert3x3(ATA);
        if (!ATA_inv) return null;

        // Calculate A^T * b for both lon and lat
        const ATb_lon = multiply(AT, b_lon);
        const ATb_lat = multiply(AT, b_lat);

        // Finally, calculate the coefficients: x = (A^T * A)^-1 * (A^T * b)
        const x_lon = multiply(ATA_inv, ATb_lon);
        const x_lat = multiply(ATA_inv, ATb_lat);

        // The transformation is:
        // lon = a*x + b*y + c
        // lat = d*x + e*y + f
        return {
          a: x_lon[0][0], b: x_lon[1][0], c: x_lon[2][0], // for longitude
          d: x_lat[0][0], e: x_lat[1][0], f: x_lat[2][0]  // for latitude
        };
      };

      transformCoefficients = calculateTransformCoefficients();
    }

    const {a, b, c, d, e, f} = transformCoefficients;
    const lon = a * x + b * y + c;
    const lat = d * x + e * y + f;
    return {lon, lat};
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
      if (data.map_coordinates && data.map_coordinates.x && data.map_coordinates.y) {
        // Convert image coordinates to geographical coordinates
        const coords = this.imageToCoordinates(data.map_coordinates.x, data.map_coordinates.y);
        entity.location = {
          longitude: coords.lon,
          latitude: coords.lat,
        };
      }
    }

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    const doc = {};
    return {
      ...this.buildBaseEntityObject(doc),
      _id: 'plopsalanddeutschland',
      slug: 'plopsaland-deutschland',
      name: 'Plopsaland Deutschland',
      entityType: entityType.destination,
      location: {
        longitude: 8.300217955490842,
        latitude: 49.317914992075146,
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
        _id: 'plopsalanddeutschlandpark',
        _destinationId: 'plopsalanddeutschland',
        _parentId: 'plopsalanddeutschland',
        name: 'Plopsaland Deutschland',
        entityType: entityType.park,
        location: {
          longitude: 8.300217955490842,
          latitude: 49.317914992075146,
        }
      }
    ];
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const poisData = await this.getPointsOfInterest();
    const attractions = [];

    if (poisData?.items) {
      for (const poi of poisData.items) {
        // Filter for attractions only
        if (poi.type?.label === 'Attraction' && poi.contains?.length > 0) {
          for (const attraction of poi.contains) {
            if (attraction.type === 'attraction') {
              const entity = {
                ...this.buildBaseEntityObject(poi),
                _id: attraction.plopsa_id || attraction.id,
                _destinationId: 'plopsalanddeutschland',
                _parentId: 'plopsalanddeutschlandpark',
                _parkId: 'plopsalanddeutschlandpark',
                name: attraction.title,
                entityType: entityType.attraction,
                attractionType: attractionType.ride, // Default to ride type
              };

              attractions.push(entity);
            }
          }
        }
      }
    }

    return attractions;
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    const entertainmentData = await this.getEntertainmentProgram();
    const poiData = await this.getPointsOfInterest();
    const shows = [];

    if (entertainmentData?.items) {
      for (const show of entertainmentData.items) {
        if (show.type?.label === 'Show') {
          // find poidata
          const poi = poiData.items.find(p => p.plopsa_id === show.plopsa_id || p.id === show.plopsa_id);

          const entity = {
            ...this.buildBaseEntityObject(poi),
            _id: show.plopsa_id || show.id,
            _destinationId: 'plopsalanddeutschland',
            _parentId: 'plopsalanddeutschlandpark',
            _parkId: 'plopsalanddeutschlandpark',
            name: show.title,
            entityType: entityType.show,
            // default to park location
            location: {
              longitude: 8.300217955490842,
              latitude: 49.317914992075146,
            },
          };

          shows.push(entity);
        }
      }
    }

    return shows;
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    const poisData = await this.getPointsOfInterest();
    const restaurants = [];

    if (poisData?.items) {
      for (const poi of poisData.items) {
        // Filter for food and drinks
        if (poi.type?.label === 'Food and drinks' && poi.contains?.length > 0) {
          for (const restaurant of poi.contains) {
            if (restaurant.type === 'foods_and_drinks') {
              const entity = {
                ...this.buildBaseEntityObject(poi),
                _id: restaurant.plopsa_id || restaurant.id,
                _destinationId: 'plopsalanddeutschland',
                _parentId: 'plopsalanddeutschlandpark',
                _parkId: 'plopsalanddeutschlandpark',
                name: restaurant.title,
                entityType: entityType.restaurant,
              };

              restaurants.push(entity);
            }
          }
        }
      }
    }

    return restaurants;
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const waitTimes = await this.getWaitingTimes();
    const liveData = [];

    // Process waiting times
    if (waitTimes) {
      for (const [attractionId, waitTime] of Object.entries(waitTimes)) {
        const entity = {
          _id: attractionId,
          status: statusType.operating,
        };

        // Set queue time
        if (waitTime > 0) {
          entity.queue = {
            [queueType.standBy]: {
              waitTime: waitTime,
            }
          };
        } else {
          // 0 could mean closed or no wait
          entity.queue = {
            [queueType.standBy]: {
              waitTime: 0,
            }
          };
        }

        liveData.push(entity);
      }
    }

    return liveData;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const scheduleData = [];

    try {
      // Get park hours
      const parkHours = await this.getParkHours();
      if (parkHours) {
        const parkSchedule = {
          _id: 'plopsalanddeutschlandpark',
          schedule: []
        };

        // Process each month and date
        for (const [monthKey, monthData] of Object.entries(parkHours)) {
          for (const [dateKey, dayData] of Object.entries(monthData)) {
            // Skip if no slots (park closed)
            if (!dayData.slots || dayData.slots.length === 0) {
              continue;
            }

            // Process each time slot for this date
            for (const slot of dayData.slots) {
              if (slot.type === 'open') {
                const scheduleEntry = {
                  date: dateKey,
                  type: scheduleType.operating,
                  openingTime: slot.start_time,
                  closingTime: slot.end_time,
                };
                parkSchedule.schedule.push(scheduleEntry);
              }
            }
          }
        }

        if (parkSchedule.schedule.length > 0) {
          scheduleData.push(parkSchedule);
        }
      } else {
        console.error('parkHours is null or undefined:', parkHours);
      }
    } catch (error) {
      console.error('Error fetching park hours:', error);
    }

    return scheduleData;
  }
}
