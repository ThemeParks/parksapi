// Support for Attractions.io v3 API
import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import {fileURLToPath} from 'url';

import moment from 'moment';

async function enumerateResorts() {
  const startId = 1;
  const endId = 250;

  const baseResort = new KnottsBerryFarm();

  const parks = [];

  const urlBase = baseResort.config.realTimeBaseURL;

  const checkResort = async (id) => {
    const response = await baseResort.http(
      'GET',
      `${urlBase}/wait-times/park/${id}`,
      null,
      {
        retries: 0,
      },
    );
    if (response.statusCode !== 200) {
      return null;
    }

    const parkConfig = response.body;
    if (!parkConfig || !parkConfig.parkName) {
      return null;
    }

    console.log(`  Found park ${id}: ${parkConfig.parkName}`);
    return {
      id: id,
      name: parkConfig.parkName,
    };
  };

  for (let i = startId; i <= endId; i++) {
    try {
      // cache for 24 hours
      const cacheTime = 1000 * 60 * 60 * 24;
      const parkMapping = await baseResort.cache.wrap(`parkdata_${i}`, async () => {
        try {
          return await checkResort(i);
        } catch (e) {
          return null;
        }
      }, cacheTime);
      if (parkMapping) {
        parks.push(parkMapping);
      }
    } catch (e) {
      //console.error(`Error checking park ${i}: ${e}`);
    }
  }

  console.log(`Found ${parks.length} parks`);
  for (const park of parks) {
    console.log(`${park.id}: ${park.name}`);
  }
}

export class AttractionsIOV3 extends Destination {
  constructor(options = {}) {
    options.baseURL = options.baseURL || 'https://api.attractions.io';
    options.realTimeBaseURL = options.realTimeBaseURL || "";
    options.parkId = options.parkId || "";

    // optional path to use for /config/ URL
    options.configPath = options.configPath || null;

    // optional latitude and longitude override for the park
    //  will try and search POI data for "Main Entrance" if not provided
    options.longitude = options.longitude || 0;
    options.latitude = options.latitude || 0;

    // optional extra category types to include
    //  the POI config can miss some categories, so we can add them here
    options.extraAttractionCategoryTypes = options.extraAttractionCategoryTypes || [];
    options.extraShowCategoryTypes = options.extraShowCategoryTypes || [];
    options.extraRestaurantCategoryTypes = options.extraRestaurantCategoryTypes || [];

    // category names for each type of entity
    //  we use these to filter POI data
    options.attractionCategories = options.attractionCategories || ['Rides'];
    options.showCategories = options.showCategories || ['Shows'];
    options.diningCategories = options.diningCategories || ['Dining'];

    // Android app ID (optional)
    options.appId = options.appId || null;
    options.appName = options.appName || null;

    options.configPrefixes = ['ATTRACTIONSIOV3'];

    super(options);

    if (!this.config.realTimeBaseURL) {
      throw new Error('realTimeBaseURL is required for Attractions.io v3 parks');
    }

    if (!this.config.parkId) {
      throw new Error('parkId is required for Attractions.io v3 parks');
    }

    // inject our user-agent into all requests
    const baseURLHostname = new URL(this.config.realTimeBaseURL).hostname;
    this.http.injectForDomain({
      hostname: baseURLHostname,
    },  async (method, url, data, options) => {
      options.headers = options.headers || {};

      if (this.config.appId && this.config.appName) {
        // get app version
        const appVersion = await this.getAndroidAPPVersion(this.config.appId);

        options.headers['user-agent'] = this.config.userAgent || `${this.config.appName}/${appVersion} (${this.config.appId}; Android 34)`;
      }
    });
  }

  async fetchWaitTimes() {
    '@cache|1'; // cache for 1 minute
    const response = await this.http('GET', `${this.config.realTimeBaseURL}/wait-times/park/${this.config.parkId}`);
    return response.body;
  }

  async fetchVenueStatus() {
    '@cache|1'; // cache for 1 minute
    const response = await this.http('GET', `${this.config.realTimeBaseURL}/venue-status/park/${this.config.parkId}`);
    return response.body;
  }

  async fetchParkConfig() {
    '@cache|1d'; // cache for 1 day
    const url = this.config.configPath ? `${this.config.realTimeBaseURL}/${this.config.configPath}` : `${this.config.realTimeBaseURL}/config/park/${this.config.parkId}`;
    const response = await this.http('GET', url);
    return response.body;
  }

  async fetchParkPOI() {
    '@cache|1d'; // cache for 1 day
    const response = await this.http('GET', `${this.config.realTimeBaseURL}/poi/park/${this.config.parkId}`);
    return response.body;
  }

  /**
   * Helper function to build a basic entity document
   * Useful to avoid copy/pasting
   * @param {object} data 
   * @returns {object}
   */
  buildBaseEntityObject(data) {
    const entity = Destination.prototype.buildBaseEntityObject.call(this, data);

    if (data?.name) {
      entity.name = data.name;
    }

    // we are using the fimsId as our unique ID
    //  as this is also used for the live wait times
    if (data?.fimsId) {
      entity._id = `${data.fimsId}`;
    }

    if (data?.location && data.location.latitude && data.location.longitude) {
      entity.location = {
        latitude: Number(data.location.latitude),
        longitude: Number(data.location.longitude),
      };
    }

    return entity;
  }

  async getParkEntranceLocation() {
    // get POI data and search for Main Entrance
    const parkConfig = await this.fetchParkPOI();

    const searchForPOI = (name) => {
      // test if the POI name begins with the name we're looking for
      const poiEnt = parkConfig.find((poi) => poi && poi.name && poi.name.startsWith(name));
      if (!poiEnt || !poiEnt.location || !poiEnt.location.latitude || !poiEnt.location.longitude) {
        return null;
      }

      return {
        latitude: Number(poiEnt.location.latitude),
        longitude: Number(poiEnt.location.longitude),
      };
    };

    const entanceNames = [
      "Main Entrance",
      "Accessible Gate",
      "Front Gate",
    ];

    for (const name of entanceNames) {
      const location = searchForPOI(name);
      if (location) {
        return location;
      }
    }

    // otherwise, fallback on any configured latitude/longitude
    if (this.config.latitude && this.config.longitude) {
      return {
        latitude: this.config.latitude,
        longitude: this.config.longitude,
      };
    }

    return undefined;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    const parkConfig = await this.fetchParkConfig();
    const entranceLocation = await this.getParkEntranceLocation();

    const doc = {
      name: parkConfig.parkName,
    };
    return {
      ...this.buildBaseEntityObject(doc),
      _id: this.config.destinationId + "_destination",
      slug: this.config.destinationId,
      entityType: entityType.destination,
      location: entranceLocation,
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    const parkConfig = await this.fetchParkConfig();
    const entranceLocation = await this.getParkEntranceLocation();

    const doc = {
      name: parkConfig.parkName,
    };

    return [
      {
        ...this.buildBaseEntityObject(doc),
        _id: this.config.destinationId,
        _destinationId: this.config.destinationId + "_destination",
        _parentId: this.config.destinationId + "_destination",
        entityType: entityType.park,
        location: entranceLocation,
      }
    ];
  }

  async getTypesFromCategories(categories, fieldFilter = "type") {
    '@cache|1d'; // cache for 1 day

    // fetch attraction types from park config
    const parkConfig = await this.fetchParkConfig();

    if (!parkConfig || !parkConfig.poi_config || !parkConfig.poi_config.parkModes) {
      return [];
    }

    const types = [];
    // walk through all the park modes and find the valid categories
    //  then grab all the filter IDs from the "type" field
    parkConfig.poi_config.parkModes.forEach((mode) => {
      if (!mode.category || !mode.category.values) return;
      mode.category.values.forEach((cat) => {
        if (categories.indexOf(cat.label || cat.title) >= 0) {
          cat.filters.forEach((filter) => {
            if (!filter.fieldName || !filter.values) return;
            // check if this is the field we're looking for
            //  rides are "type", shows are "showType" etc.
            if (filter.fieldName == fieldFilter) {
              filter.values.forEach((filterValue) => {
                // don't duplicate types
                if (types.indexOf(filterValue.value) < 0) {
                  types.push(filterValue.value);
                }
              });
            }
          });
        }
      });
    });

    return types;
  }

  async getEntitiesForCategory(categories, fieldName, entityData, extraCategoryTypes = []) {
    const types = [].concat(await this.getTypesFromCategories(categories, fieldName)).concat(extraCategoryTypes);
    const poiData = await this.fetchParkPOI();

    // filter out any POI that doesn't have a valid type
    const entities = poiData.filter((poi) => {
      if (!poi || !poi[fieldName] || poi[fieldName]?.id === undefined) return false;
      return types.indexOf(poi[fieldName].id) >= 0;
    });

    return entities.map((ride) => {
      return {
        ...this.buildBaseEntityObject(ride),
        ...entityData,
        _destinationId: this.config.destinationId + "_destination",
        _parentId: this.config.destinationId,
        _parkId: this.config.destinationId,
      };
    });
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    return this.getEntitiesForCategory(this.config.attractionCategories, "type", {
      entityType: entityType.attraction,
      attractionType: attractionType.ride,
    }, this.config.extraAttractionCategoryTypes);
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    return this.getEntitiesForCategory(this.config.showCategories, "showType", {
      entityType: entityType.show,
    }, this.config.extraShowCategoryTypes);
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    return await this.getEntitiesForCategory(this.config.diningCategories, "foodTypes", {
      entityType: entityType.restaurant,
    }, this.config.extraRestaurantCategoryTypes);
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    // Fetch both wait times and venue status
    const [liveData, venueStatusData] = await Promise.all([
      this.fetchWaitTimes(),
      this.fetchVenueStatus().catch(() => null) // Don't fail if venue status is unavailable
    ]);

    // Create a lookup map for venue status by ID
    const venueStatusMap = {};
    if (venueStatusData && venueStatusData.venues) {
      venueStatusData.venues.forEach(venue => {
        if (venue.details) {
          venue.details.forEach(detail => {
            if (detail.fimsId) {
              venueStatusMap[detail.fimsId.toUpperCase()] = detail.status;
            }
          });
        }
      });
    }

    const entries = liveData.venues.reduce((x, venue) => {
      x.push(...venue.details);
      return x;
    }, []);

    return entries.map((x) => {
      const fimsId = `${x.fimsId}`.toUpperCase();
      
      const entry = {
        _id: fimsId,
        status: statusType.closed,
      };

      // Check venue status first - this is the authoritative source for operational status
      const venueStatus = venueStatusMap[fimsId];
      const isOpen = venueStatus === 'Opened';
      
      // add standby time (if present)
      if (x.regularWaittime && x.regularWaittime.createdDateTime) {
        if (!entry.queue) {
          entry.queue = {};
        }
        // Only set to operating if venue status says it's open (or no venue status available)
        if (isOpen || venueStatus === undefined) {
          entry.status = statusType.operating;
        }
        entry.queue[queueType.standBy] = {
          waitTime: x.regularWaittime.waitTime || 0,
        };
      }

      // add fastpass time (if present)
      if (x.fastlaneWaittime && x.fastlaneWaittime.createdDateTime) {
        if (!entry.queue) {
          entry.queue = {};
        }
        // Only set to operating if venue status says it's open (or no venue status available)
        if (isOpen || venueStatus === undefined) {
          entry.status = statusType.operating;
        }
        // paid standby type, basically normal queueing, but you get your own line
        entry.queue[queueType.paidStandBy] = {
          waitTime: x.fastlaneWaittime.waitTime || 0,
        };
      }

      // If venue status indicates closed, override status regardless of wait time data
      if (venueStatus && venueStatus !== 'Opened') {
        entry.status = statusType.closed;
      }

      return entry;
    });
  }

  async _fetchScheduleForDate(date) {
    '@cache|1d'; // cache for 1 day always, outside of the logic below

    // convert to moment object in the park's timezone
    const momentDate = moment(date, 'YYYYMMDD').tz(this.config.timezone, true);

    const cacheTime = momentDate.isBefore(moment().add(3, 'days')) ? 1000 * 60 * 60 * 4 : 1000 * 60 * 60 * 24;
    return this.cache.wrap(`park_schedule_${momentDate.format('YYYY-MM-DD')}`, async () => {
      const response = await this.http('GET', `${this.config.realTimeBaseURL}/operating-hours/park/${this.config.parkId}?date=${date}`);
      return response.body;
    }, cacheTime);
  }

  async fetchScheduleDataForDate(momentDate) {
    // cache this data for 1 day, unless it's in the next 3 days, then cache for 4 hours

    const date = momentDate.format('YYYYMMDD');
    const response = await this._fetchScheduleForDate(date);

    if (!response || !response.operatings || !response.operatings.length) {
      return null;
    }

    if (response.isParkClosed) {
      return [];
    }

    return response.operatings.reduce((arr, operating) => {
      if (!operating.items) return arr;

      operating.items.forEach((item) => {
        // skip items missing times or when isBuyout=true
        if (!item.timeFrom || !item.timeTo || item.isBuyout) return;

        const openTime = moment(`${date}T${item.timeFrom}`, "YYYYMMDDTHH:mm").tz(this.config.timezone, true);
        const closeTime = moment(`${date}T${item.timeTo}`, "YYYYMMDDTHH:mm").tz(this.config.timezone, true);

        arr.push({
          date: moment(date).format('YYYY-MM-DD'),
          type: statusType.operating,
          // opening time comes in format "HH:mm" in timeFrom field
          openingTime: openTime.format(),
          closingTime: closeTime.format(),
        });
      });
      return arr;
    }, []);
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    // fetch next 90 days of schedule data
    const now = moment();
    const nextMonth = moment().add(3, 'month');
    const datesToFetch = [];
    for (const date = now.clone(); date.isBefore(nextMonth); date.add(1, 'day')) {
      datesToFetch.push(date.clone());
    }

    const scheduleData = [];
    for (const date of datesToFetch) {
      const data = await this.fetchScheduleDataForDate(date);
      if (data) {
        scheduleData.push(...data);
      }
    }

    return [
      {
        _id: this.config.destinationId,
        schedule: scheduleData,
      }
    ];
  }
}

export class KnottsBerryFarm extends AttractionsIOV3 {
  constructor(options = {}) {
    options.timezone = 'America/Los_Angeles';
    options.parkId = options.parkId || "4";
    options.destinationId = 'knottsberryfarm';
    options.extraAttractionCategoryTypes = [19]; // 19 is missing from POI config data (water rides)

    options.appId = "com.cedarfair.knottsberry";
    options.appName = "Knott's Berry Farm";

    super(options);
  }
}

export class KingsIsland extends AttractionsIOV3 {
  constructor(options = {}) {
    options.timezone = 'America/New_York';
    options.parkId = options.parkId || "20";
    options.destinationId = 'kingsisland';

    options.appId = "com.cedarfair.kingsisland";
    options.appName = "Kings Island";

    super(options);
  }
}

export class Carowinds extends AttractionsIOV3 {
  constructor(options = {}) {
    options.timezone = 'America/New_York';
    options.parkId = options.parkId || "30";
    options.destinationId = 'carowinds';

    options.appId = "com.cedarfair.carowinds";
    options.appName = "Carowinds";

    super(options);
  }
}

export class CanadasWonderland extends AttractionsIOV3 {
  constructor(options = {}) {
    options.timezone = 'America/Toronto';
    options.parkId = options.parkId || "40";
    options.destinationId = 'canadaswonderland';

    options.appId = "com.cedarfair.canadaswonderland";
    options.appName = "Canada's Wonderland";

    super(options);
  }
}

export class CedarPoint extends AttractionsIOV3 {
  constructor(options = {}) {
    options.timezone = 'America/New_York';
    options.parkId = options.parkId || "1";
    options.destinationId = 'cedarpoint';

    options.appId = "com.cedarfair.cedarpoint";
    options.appName = "Cedar Point";

    super(options);
  }
}

export class CaliforniasGreatAmerica extends AttractionsIOV3 {
  constructor(options = {}) {
    options.timezone = 'America/Los_Angeles';
    options.parkId = options.parkId || "35";
    options.destinationId = 'californiasgreatamerica';

    options.appId = "com.cedarfair.cga";
    options.appName = "California's Great America";

    super(options);
  }
}

export class WorldsOfFun extends AttractionsIOV3 {
  constructor(options = {}) {
    options.timezone = 'America/Chicago';
    options.parkId = options.parkId || "6";
    options.destinationId = 'worldsoffun';

    options.configPath = "v2/config/park/wf";

    options.appId = "com.cedarfair.worldsoffun";
    options.appName = "Worlds of Fun";

    super(options);
  }
}

export class MichigansAdventure extends AttractionsIOV3 {
  constructor(options = {}) {
    options.timezone = 'America/Detroit';
    options.parkId = options.parkId || "12";
    options.destinationId = 'michigansadventure';

    options.configPath = "v2/config/park/ma";

    options.appId = "com.cedarfair.michigansadventure";
    options.appName = "Michigan's Adventure";

    super(options);
  }
}

export class KingsDominion extends AttractionsIOV3 {
  constructor(options = {}) {
    options.timezone = 'America/New_York';
    options.parkId = options.parkId || "25";
    options.destinationId = 'kingsdominion';

    options.configPath = "v2/config/park/kd";

    options.appId = "com.cedarfair.kingsdominion";
    options.appName = "Kings Dominion";

    super(options);
  }
}

export class ValleyFair extends AttractionsIOV3 {
  constructor(options = {}) {
    options.timezone = 'America/Chicago';
    options.parkId = options.parkId || "14";
    options.destinationId = 'valleyfair';

    options.configPath = "v2/config/park/vf";

    options.appId = "com.cedarfair.valleyfair";
    options.appName = "Valleyfair";

    super(options);
  }
}

export class DorneyPark extends AttractionsIOV3 {
  constructor(options = {}) {
    options.timezone = 'America/New_York';
    options.parkId = options.parkId || "8";
    options.destinationId = 'dorneypark';

    options.configPath = "v2/config/park/dp";

    options.appId = "com.cedarfair.dorneypark";
    options.appName = "Dorney Park";

    options.longitude = -75.4902;
    options.latitude = 40.5746;

    super(options);
  }
}

// check if we're being called directly (import style)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  enumerateResorts();
}