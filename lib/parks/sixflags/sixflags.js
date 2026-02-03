import moment from 'moment-timezone';
import crypto from 'crypto';
import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, entityType} from '../parkTypes.js';

export class SixFlags extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'America/New_York';

    options.baseURL = options.baseURL || '';
    options.firebaseApiKey = options.firebaseApiKey || '';
    options.firebaseProjectId = options.firebaseProjectId || '';
    options.firebaseAppId = options.firebaseAppId || '';
    options.androidPackage = options.androidPackage || '';

    options.configPrefixes = ['SIXFLAGS'].concat(options.configPrefixes || []);

    super(options);

    if (!this.config.baseURL) throw new Error('Missing Six Flags Base URL');
    if (!this.config.firebaseApiKey) throw new Error('Missing Six Flags Firebase API Key');
    if (!this.config.firebaseProjectId) throw new Error('Missing Six Flags Firebase Project ID');
    if (!this.config.firebaseAppId) throw new Error('Missing Six Flags Firebase App ID');
    if (!this.config.androidPackage) throw new Error('Missing Six Flags Android Package');
  }

  /**
   * Generate a Firebase Installation ID
   */
  async generateFirebaseID() {
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
   * Fetch Firebase config to get list of all supported parks
   */
  async fetchFirebaseConfig() {
    '@cache|1d'; // cache for 1 day

    const fid = await this.generateFirebaseID();

    const resp = await this.http(
      'POST',
      `https://firebaseremoteconfig.googleapis.com/v1/projects/${this.config.firebaseProjectId}/namespaces/firebase:fetch`,
      {
        'appInstanceId': fid,
        'appId': this.config.firebaseAppId,
        'packageName': this.config.androidPackage,
        'languageCode': 'en_GB',
      }, {
      headers: {
        'X-Goog-Api-Key': this.config.firebaseApiKey,
      },
    },
    );

    return resp.body;
  }

  /**
   * Get park name from venue status endpoint
   * This fetches the actual park name from the API
   */
  async _fetchParkName(parkId) {
    try {
      const venueStatus = await this.fetchVenueStatus({parkID: parkId});
      return venueStatus?.parkName || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Get list of all parks from Firebase config
   */
  async _getParkData() {
    '@cache|1d'; // cache for 1 day
    const config = await this.fetchFirebaseConfig();

    // Parse the Firebase config to extract park information
    const entries = config?.entries || {};
    const parkTypeHourAvailability = entries['parkTypeHourAvailability'];

    if (!parkTypeHourAvailability) {
      throw new Error('No parkTypeHourAvailability found in Firebase config');
    }

    const parkHourSettings = JSON.parse(parkTypeHourAvailability);
    const parkSettings = parkHourSettings?.parkHourSettings || {};

    // Extract park names from oneShot config (for parks that have them)
    const parkNamesMap = {};
    if (entries['oneShot']) {
      const oneShot = JSON.parse(entries['oneShot']);
      const parksConfiguration = oneShot?.parks_configuration || [];
      parksConfiguration.forEach(park => {
        parkNamesMap[park.parkId] = park.parkName;
      });
    }

    // Extract park IDs and filter out water parks (showThemePark === false)
    const parkIds = Object.entries(parkSettings)
      .filter(([, settings]) => {
        return settings.showThemePark === true;
      })
      .map(([parkId, settings]) => ({
        parkId: parseInt(parkId),
        code: settings.code,
      }));

    // Fetch park names from venue status endpoint for parks not in oneShot
    const parks = await Promise.all(parkIds.map(async (park) => {
      let name = parkNamesMap[park.parkId];

      // If not in oneShot config, try to fetch from venue status
      if (!name) {
        name = await this._fetchParkName(park.parkId);
      }

      return {
        ...park,
        name,
      };
    }));

    return parks;
  }

  /**
   * Get list of all park IDs
   */
  async _getParkIDs() {
    '@cache|1d'; // cache for 1 day
    const parks = await this._getParkData();
    return parks.map(park => park.parkId);
  }

  /**
   * Fetch POI data for a specific park
   */
  async fetchPOI({parkID}) {
    '@cache|1d'; // cache for 1 day
    const resp = await this.http.get(`${this.config.baseURL}/poi/park/${parkID}`);
    return resp.body;
  }

  /**
   * Fetch venue status for a specific park
   */
  async fetchVenueStatus({parkID}) {
    '@cache|1m'; // cache for 1 minute
    const resp = await this.http.get(`${this.config.baseURL}/venue-status/park/${parkID}`);
    return resp.body;
  }

  /**
   * Fetch wait times for a specific park
   */
  async fetchWaitTimes({parkID}) {
    '@cache|1m'; // cache for 1 minute
    const resp = await this.http.get(
      `${this.config.baseURL}/wait-times/park/${parkID}`,
      undefined,
      {
        retries: 0, // do not retry on failure
      }
    );
    return resp.body;
  }

  /**
   * Fetch operating hours for a specific park and month
   */
  async fetchOperatingHours({parkID, date}) {
    '@cache|24h'; // cache for 24 hours
    const resp = await this.http.get(`${this.config.baseURL}/operating-hours/park/${parkID}?date=${date}`);
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

      // remove <p> </p> tags from name if present
      entity.name = entity.name.replace(/<\/?p>/g, '').trim();
    }

    if (data.location && data.location.latitude && data.location.longitude) {
      let longitude = parseFloat(data.location.longitude);
      let latitude = parseFloat(data.location.latitude);

      // Validate coordinates (latitude: -90 to +90, longitude: -180 to +180)
      // Also reject (0, 0) as it's a placeholder value
      if (isNaN(latitude) || isNaN(longitude) ||
        latitude < -90 || latitude > 90 ||
        longitude < -180 || longitude > 180 ||
        (latitude === 0 && longitude === 0)) {
        // Invalid coordinates, skip location data
      } else {
        // Fix: Six Flags API sometimes returns positive longitudes for Western Hemisphere
        // All Six Flags parks are in the Americas (Western Hemisphere), so longitude should be negative
        if (longitude > 0) {
          longitude = -longitude;
        }

        entity.location = {
          longitude: longitude,
          latitude: latitude,
        };
      }
    } else if (data.lat && data.lng) {
      let longitude = parseFloat(data.lng);
      let latitude = parseFloat(data.lat);

      // Validate coordinates
      // Also reject (0, 0) as it's a placeholder value
      if (isNaN(latitude) || isNaN(longitude) ||
        latitude < -90 || latitude > 90 ||
        longitude < -180 || longitude > 180 ||
        (latitude === 0 && longitude === 0)) {
        // Invalid coordinates, skip location data
      } else {
        // Fix: Six Flags API sometimes returns positive longitudes for Western Hemisphere
        if (longitude > 0) {
          longitude = -longitude;
        }

        entity.location = {
          longitude: longitude,
          latitude: latitude,
        };
      }
    }

    // Timezone is inherited from destination (set in base class)

    // Guess entity timezone from location, if we failed to get from parent
    if (entity.location && entity.location.latitude && entity.location.longitude) {
      try {
        entity.timezone = this.calculateTimezone(entity.location.latitude, entity.location.longitude);
      } catch (e) { }
    }

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    const parks = await this._getParkData();

    const destinations = [];
    for (const park of parks) {
      // Try to get location from venue status first
      let location = null;
      try {
        const venueStatus = await this.fetchVenueStatus({parkID: park.parkId});
        if (venueStatus.lat && venueStatus.lng) {
          location = {
            latitude: venueStatus.lat,
            longitude: venueStatus.lng,
          };
        }
      } catch (e) {
        this.log(`Failed to fetch venue status for park ${park.parkId}: ${e.message}`);
      }

      // If no location from venue status, try POI data
      if (!location) {
        try {
          const poiData = await this.fetchPOI({parkID: park.parkId});
          if (poiData && poiData.length > 0) {
            // Look for "Main Entrance" POI first, otherwise use first POI with location
            const mainEntrance = poiData.find(poi => poi.name && poi.name.toLowerCase().includes('main entrance'));
            const poiWithLocation = mainEntrance || poiData.find(poi => poi.location?.latitude && poi.location?.longitude);

            if (poiWithLocation && poiWithLocation.location) {
              let longitude = parseFloat(poiWithLocation.location.longitude);

              // Fix: Six Flags API sometimes returns positive longitudes for Western Hemisphere
              // All Six Flags parks are in the Americas (Western Hemisphere), so longitude should be negative
              if (longitude > 0) {
                longitude = -longitude;
              }

              location = {
                latitude: parseFloat(poiWithLocation.location.latitude),
                longitude: longitude,
              };
            }
          }
        } catch (e) {
          this.log(`Failed to fetch POI data for park ${park.parkId}: ${e.message}`);
        }
      }

      const entity = {
        ...this.buildBaseEntityObject(location ? {location} : null),
        _id: `sixflags_destination_${park.code}`,
        slug: park.name.replace(/\s+/g, '-').replace(/[^a-zA-Z-]/g, '').toLowerCase(),
        name: park.name,
        entityType: entityType.destination,
      };

      if (location) {
        entity.location = location;
      }

      destinations.push(entity);
    }

    return destinations;
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    const parks = await this._getParkData();

    const parkEntities = [];
    for (const park of parks) {
      // Try to get location from venue status first
      let location = null;
      try {
        const venueStatus = await this.fetchVenueStatus({parkID: park.parkId});
        if (venueStatus.lat && venueStatus.lng) {
          location = {
            latitude: venueStatus.lat,
            longitude: venueStatus.lng,
          };
        }
      } catch (e) {
        this.log(`Failed to fetch venue status for park ${park.parkId}: ${e.message}`);
      }

      // If no location from venue status, try POI data
      if (!location) {
        try {
          const poiData = await this.fetchPOI({parkID: park.parkId});
          if (poiData && poiData.length > 0) {
            // Look for "Main Entrance" POI first, otherwise use first POI with location
            const mainEntrance = poiData.find(poi => poi.name && poi.name.toLowerCase().includes('main entrance'));
            const poiWithLocation = mainEntrance || poiData.find(poi => poi.location?.latitude && poi.location?.longitude);

            if (poiWithLocation && poiWithLocation.location) {
              let longitude = parseFloat(poiWithLocation.location.longitude);

              // Fix: Six Flags API sometimes returns positive longitudes for Western Hemisphere
              // All Six Flags parks are in the Americas (Western Hemisphere), so longitude should be negative
              if (longitude > 0) {
                longitude = -longitude;
              }

              location = {
                latitude: parseFloat(poiWithLocation.location.latitude),
                longitude: longitude,
              };
            }
          }
        } catch (e) {
          this.log(`Failed to fetch POI data for park ${park.parkId}: ${e.message}`);
        }
      }

      const entity = {
        ...this.buildBaseEntityObject(location ? {location} : null),
        _id: `sixflags_park_${park.code}`,
        _destinationId: `sixflags_destination_${park.code}`,
        _parentId: `sixflags_destination_${park.code}`,
        name: park.name,
        entityType: entityType.park,
      };

      if (location) {
        entity.location = location;
      }

      parkEntities.push(entity);
    }

    return parkEntities;
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const parks = await this._getParkData();
    const destinations = await this.buildDestinationEntity();

    const attractionEntities = [];
    for (const park of parks) {
      const poiData = await this.fetchPOI({parkID: park.parkId});

      if (!poiData || !Array.isArray(poiData)) {
        continue;
      }

      // Get destination location for fallback
      const destinationEntity = destinations.find(d => d._id === `sixflags_destination_${park.code}`);

      // Filter for rides (venueId: 1) and ensure they belong to this park
      const rides = poiData.filter(poi => poi.venueId === 1 && poi.parkId === park.parkId);

      attractionEntities.push(...rides.map(attraction => {
        const entity = {
          ...this.buildBaseEntityObject(attraction),
          _id: attraction.fimsId,
          _parkId: `sixflags_park_${park.code}`,
          _parentId: `sixflags_park_${park.code}`,
          _destinationId: `sixflags_destination_${park.code}`,
          entityType: entityType.attraction,
          attractionType: attractionType.ride,
        };

        // Final fallback: if still no location, use destination location
        if (!entity.location && destinationEntity?.location) {
          entity.location = destinationEntity.location;
        }

        return entity;
      }));
    }

    return attractionEntities;
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    const parks = await this._getParkData();
    const destinations = await this.buildDestinationEntity();

    const showEntities = [];
    for (const park of parks) {
      const poiData = await this.fetchPOI({parkID: park.parkId});

      if (!poiData || !Array.isArray(poiData)) {
        continue;
      }

      // Get destination location for fallback
      const destinationEntity = destinations.find(d => d._id === `sixflags_destination_${park.code}`);

      // Filter for shows (venueId: 2) and ensure they belong to this park
      const shows = poiData.filter(poi => poi.venueId === 2 && poi.parkId === park.parkId);

      showEntities.push(...shows.map(show => {
        const entity = {
          ...this.buildBaseEntityObject(show),
          _id: show.fimsId,
          _parkId: `sixflags_park_${park.code}`,
          _parentId: `sixflags_park_${park.code}`,
          _destinationId: `sixflags_destination_${park.code}`,
          entityType: entityType.show,
        };

        // Final fallback: if still no location, use destination location
        if (!entity.location && destinationEntity?.location) {
          entity.location = destinationEntity.location;
        }

        return entity;
      }));
    }

    return showEntities;
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    const parks = await this._getParkData();
    const destinations = await this.buildDestinationEntity();

    const restaurantEntities = [];
    for (const park of parks) {
      const poiData = await this.fetchPOI({parkID: park.parkId});

      if (!poiData || !Array.isArray(poiData)) {
        continue;
      }

      // Get destination location for fallback
      const destinationEntity = destinations.find(d => d._id === `sixflags_destination_${park.code}`);

      // Filter for restaurants (venueId: 4) and ensure they belong to this park
      const restaurants = poiData.filter(poi => poi.venueId === 4 && poi.parkId === park.parkId);

      restaurantEntities.push(...restaurants.map(restaurant => {
        const entity = {
          ...this.buildBaseEntityObject(restaurant),
          _id: restaurant.fimsId,
          _parkId: `sixflags_park_${park.code}`,
          _parentId: `sixflags_park_${park.code}`,
          _destinationId: `sixflags_destination_${park.code}`,
          entityType: entityType.restaurant,
        };

        // Final fallback: if still no location, use destination location
        if (!entity.location && destinationEntity?.location) {
          entity.location = destinationEntity.location;
        }

        return entity;
      }));
    }

    return restaurantEntities;
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const parks = await this._getParkData();

    // Parks that don't have wait-times APIs (water parks, etc.)
    const parksWithoutWaitTimes = [942, 944, 947, 948, 959];

    const liveData = [];
    const addedIds = new Set(); // Track added IDs to prevent duplicates

    for (const park of parks) {
      const parkID = park.parkId;
      // Fetch venue status (always required)
      const venueStatus = await this.fetchVenueStatus({parkID});

      if (!venueStatus || !venueStatus.venues) {
        continue;
      }

      // Get rides venue from venue status (for status info)
      const ridesVenueStatus = venueStatus.venues.find(v => v.venueId === 1);
      if (!ridesVenueStatus || !ridesVenueStatus.details) {
        continue;
      }

      // Fetch wait times (optional - may fail for some parks)
      // Skip parks that don't have wait-times APIs
      let waitTimesData = null;
      if (!parksWithoutWaitTimes.includes(parkID)) {
        try {
          waitTimesData = await this.fetchWaitTimes({parkID});
        } catch (e) {
          // Wait times not available for this park, will use venue status only
        }
      }

      // Get rides venue from wait times (for wait time info)
      const ridesWaitTimes = waitTimesData?.venues?.find(v => v.venueId === 1);
      const waitTimesMap = {};
      if (ridesWaitTimes && ridesWaitTimes.details) {
        ridesWaitTimes.details.forEach(ride => {
          waitTimesMap[ride.fimsId] = ride;
        });
      }

      // Build live data for rides
      ridesVenueStatus.details.forEach(ride => {
        const entityId = ride.fimsId;

        // Skip if we've already added this entity
        if (addedIds.has(entityId)) {
          return;
        }
        addedIds.add(entityId);

        const rideLiveData = {
          _id: entityId,
          status: statusType.closed,
        };

        // Get wait time from wait times data (may be stale)
        const waitTimeInfo = waitTimesMap[ride.fimsId];
        let waitTime = null;

        if (waitTimeInfo?.regularWaittime?.waitTime != null) {
          waitTime = Number(waitTimeInfo.regularWaittime.waitTime);
          if (isNaN(waitTime)) {
            waitTime = null;
          }
        }

        // Determine status from venue status (authoritative source)
        const venueStatusStr = ride.status?.toLowerCase() || '';

        // Map venue status to our statusType
        if (venueStatusStr === 'open' || venueStatusStr === 'opened') {
          rideLiveData.status = statusType.operating;
        } else if (venueStatusStr === 'temp closed') {
          // Temporarily closed due to maintenance
          rideLiveData.status = statusType.down;
        } else if (venueStatusStr === 'temp closed due weather') {
          // Temporarily closed due to weather
          rideLiveData.status = statusType.down;
        } else if (venueStatusStr === 'not scheduled') {
          // Not scheduled for today
          rideLiveData.status = statusType.closed;
        } else if (venueStatusStr === '') {
          // No status from venue - use wait time as fallback
          if (waitTime != null && waitTime >= 0) {
            rideLiveData.status = statusType.operating;
          } else {
            rideLiveData.status = statusType.closed;
          }
        } else {
          // Unknown status - default to open
          rideLiveData.status = statusType.operating;
        }

        // Null out wait time if ride is not operating
        if (rideLiveData.status !== statusType.operating) {
          waitTime = null;
        }

        rideLiveData.queue = {
          [queueType.standBy]: {
            waitTime: waitTime,
          },
        };

        // Add fast lane queue if available (only if ride is operating and wait time > 0)
        if (rideLiveData.status === statusType.operating &&
            waitTimeInfo?.isFastLane &&
            waitTimeInfo.fastlaneWaittime?.waitTime != null) {
          const fastLaneWaitTime = Number(waitTimeInfo.fastlaneWaittime.waitTime);
          if (!isNaN(fastLaneWaitTime) && fastLaneWaitTime > 0) {
            rideLiveData.queue[queueType.paidStandBy] = {
              waitTime: fastLaneWaitTime,
            };
          }
        }

        liveData.push(rideLiveData);
      });

      // Get shows venue from venue status (for show times)
      const showsVenueStatus = venueStatus.venues.find(v => v.venueId === 2);
      if (showsVenueStatus && showsVenueStatus.details) {
        // Fetch today's operating hours to get show times
        const currentMonth = moment().format('YYYYMM');
        let todayShows = [];
        try {
          const hoursData = await this.fetchOperatingHours({parkID, date: currentMonth});
          if (hoursData && hoursData.dates) {
            const todayStr = moment().format('MM/DD/YYYY');
            const todayData = hoursData.dates.find(d => d.date === todayStr);
            if (todayData && todayData.shows) {
              todayShows = todayData.shows;
            }
          }
        } catch (e) {
          // If we can't fetch hours, just return shows without times
        }

        // Create a map of show times by show fimsId
        const showTimesMap = {};
        todayShows.forEach(show => {
          showTimesMap[show.fimsId] = show;
        });

        const parkEntity = await this.getParkEntities().then(entities =>
          entities.find(x => x._id === `sixflags_park_${park.code}`)
        );

        showsVenueStatus.details.forEach(show => {
          const entityId = show.fimsId;

          // Skip if we've already added this entity
          if (addedIds.has(entityId)) {
            return;
          }
          addedIds.add(entityId);

          const showLiveData = {
            _id: entityId,
            status: statusType.operating,
          };

          // Get show times from operating hours
          const showTimesInfo = showTimesMap[show.fimsId];
          if (showTimesInfo && showTimesInfo.items && parkEntity) {
            const showtimes = [];

            showTimesInfo.items.forEach(item => {
              if (item.times && item.times.trim()) {
                // Parse comma-separated times (e.g., "02:00 PM, 05:15 PM")
                const times = item.times.split(',').map(t => t.trim()).filter(t => t);

                times.forEach(timeStr => {
                  try {
                    // Parse time in format "HH:MM AM/PM"
                    const todayDate = moment().format('YYYY-MM-DD');
                    const startTime = moment.tz(`${todayDate} ${timeStr}`, 'YYYY-MM-DD hh:mm A', parkEntity.timezone);

                    if (startTime.isValid()) {
                      showtimes.push({
                        startTime: startTime.format(),
                        endTime: startTime.clone().add(30, 'minutes').format(), // Assume 30min default duration
                        type: "Performance Time",
                        location: item.assignmentLocation || undefined,
                      });
                    }
                  } catch (e) {
                    // Skip invalid times
                  }
                });
              }
            });

            if (showtimes.length > 0) {
              showLiveData.showtimes = showtimes;
            }
          }

          liveData.push(showLiveData);
        });
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
    const parks = await this._getParkData();
    const parkEntities = await this.getParkEntities();

    const schedules = [];

    // Get current month and next 2 months
    const now = moment();
    const months = [];
    for (let i = 0; i < 3; i++) {
      const date = now.clone().add(i, 'months');
      months.push(date.format('YYYYMM'));
    }

    for (const park of parks) {
      const parkID = park.parkId;
      const parkEntity = parkEntities.find(x => x._id === `sixflags_park_${park.code}`);
      if (!parkEntity) continue;

      const allDates = [];

      // Fetch hours for each month
      for (const month of months) {
        try {
          const hoursData = await this.fetchOperatingHours({parkID, date: month});
          if (hoursData && hoursData.dates) {
            allDates.push(...hoursData.dates);
          }
        } catch (e) {
          this.log(`Error fetching hours for park ${parkID}, month ${month}: ${e.message}`);
        }
      }

      // Build park schedule
      const parkSchedule = allDates.map(dateObj => {
        // Skip closed days
        if (dateObj.isParkClosed) {
          return null;
        }

        // Find rides venue to determine park hours
        const ridesVenue = dateObj.venues?.find(v => v.venueId === 1);
        if (!ridesVenue || !ridesVenue.detailHours || ridesVenue.detailHours.length === 0) {
          return null;
        }

        // Get earliest opening and latest closing from ride hours
        const validHours = ridesVenue.detailHours.filter(h => h.operatingTimeFrom && h.operatingTimeTo);
        if (validHours.length === 0) {
          return null;
        }

        const openingTimes = validHours.map(h => h.operatingTimeFrom).sort();
        const closingTimes = validHours.map(h => h.operatingTimeTo).sort();

        const earliestOpen = openingTimes[0];
        const latestClose = closingTimes[closingTimes.length - 1];

        const dateStr = moment(dateObj.date, 'MM/DD/YYYY').format('YYYY-MM-DD');

        return {
          date: dateStr,
          type: "OPERATING",
          openingTime: moment.tz(`${dateStr} ${earliestOpen}`, 'YYYY-MM-DD HH:mm', parkEntity.timezone).format(),
          closingTime: moment.tz(`${dateStr} ${latestClose}`, 'YYYY-MM-DD HH:mm', parkEntity.timezone).format(),
        };
      }).filter(x => !!x);

      // Always add a schedule entry for each park, even if empty
      schedules.push({
        _id: `sixflags_park_${park.code}`,
        schedule: parkSchedule,
      });
    }

    return schedules;
  }
}
