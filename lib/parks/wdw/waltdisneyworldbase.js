import moment from 'moment-timezone';
import {attractionType, boardingGroupState, entityType, queueType, scheduleType, statusType} from '../parkTypes.js';
import Destination from '../destination.js';
import {getEntityID, IndexedWDWDB} from './wdwdb.js';

let wdwDB = null;
/**
 * Get a reference to the WDW database
 * @return {IndexedWDWDB}
 */
export function getDatabase() {
  if (!wdwDB) {
    wdwDB = new IndexedWDWDB();
  }
  return wdwDB;
}

// entity types that count as "parks"
const parkTypes = [
  'theme-park',
  'water-park',
];

// scheduleTypes that are actually not a schedule
const invalidScheduleTypes = [
  'Closed',
  'No Performance',
];

/**
 * A Resort class for a Disney live resort (WDW, DLR, HKDR)
 */
export class DisneyLiveResort extends Destination {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.virtualQueueURL = options.virtualQueueURL || '';

    super(options);

    this.resortId = options.resortId;
    if (!this.resortId) {
      throw new Error('Missing Resort ID');
    }
    this.resortShortcode = options.resortShortcode;
    if (!this.resortShortcode) {
      throw new Error('Missing Resort Shortcode');
    }
    this.destinationDocumentIDRegex = new RegExp(`^${this.resortId};entityType=destination`);
    this.parkIds = options.parkIds || [];

    this.db = getDatabase();
  }

  /**
   * Initialise our Disney resort class
   */
  async _init() {
    await this.db.init();

    // setup our live status updating
    this.initLiveStatusUpdates();
  }

  /**
   * Get the channel ID for the facility status live update documents
   * @return {string}
   */
  getFacilityStatusChannelID() {
    return `${this.resortShortcode}.facilitystatus.1_0`;
  }

  /**
   * @private
   */
  async fetchVirtualQueueData() {
    // cache for 1 minute
    '@cache|1';

    if (!this.config.virtualQueueURL) return undefined;

    return (await this.http('GET', this.config.virtualQueueURL, undefined, {
      rejectUnauthorized: false,
    })).body.queues;
  }

  /**
   * Given a status doc, build a live data object
   * @param {object} doc
   */
  async _buildLiveDataObject(doc) {
    // get full facility doc
    const entityId = getEntityID(doc.id || doc._id);
    const entityDoc = await this.db.getEntityOne(entityId);
    // if can't find it, or "soft deleted", or we get back the same facility update doc, return nothing
    if (!entityDoc || entityDoc.softDeleted || entityDoc._id === doc._id) {
      return undefined;
    }

    // get our entity type
    const docEntityType = entityDoc.type;

    // skip if this doc is not a valid entity type
    /* if (docEntityType === undefined) {
      this.emit('error', doc.id || doc._id, 'LIVEDATA_MISSING_ENTITYTYPE', {
        message: `Live data for ${doc.id || doc._id} is missing a type. Expecting "Attraction", "Entertainment"...`,
        entityDoc,
      });
      return undefined;
    }*/

    // figure out entity status
    let status = statusType.operating;

    // if name contains "Temporarily Unavailable", mark as closed
    //  will be overriden by better metrics later, if any exist
    if (entityDoc.name && entityDoc.name.indexOf('Temporarily Unavailable') > 0) {
      // not refurb, as this more often than not "unavailable" is marked as just "closed"
      status = statusType.closed;
    }

    // restaurants can have status "Capacity", "Walk-Up Disabled"
    //  currently these fallback to "Operating", which matches the resturant state well enough
    if (doc.status === 'Down') {
      status = statusType.down;
    } else if (doc.status === 'Closed') {
      status = statusType.closed;
    } else if (doc.status === 'Refurbishment') {
      status = statusType.refurbishment;
    }

    // create base data object
    const data = {
      _id: entityDoc.id,
      status: status,
    };

    // get our vqueue data
    const vQueueData = await this.fetchVirtualQueueData();
    if (vQueueData) {
      // find matching queue data for this entity
      const attractionVQueueData = vQueueData.find((x) => {
        return x.externalDefinitionId === entityDoc.id;
      });
      if (attractionVQueueData) {
        // we have found a virtual queue!
        if (!data.queue) data.queue = {}; // make sure our queue object exists

        // figure out our allocation status
        //  default to available
        let allocationStatus = boardingGroupState.available;

        if (doc.status !== 'Virtual Queue' || attractionVQueueData.state === 'CLOSED') {
          allocationStatus = boardingGroupState.closed;
        }

        // PAUSED state
        if (attractionVQueueData.state === 'PAUSED') {
          // if we have an upcoming allocation time, then we are temporarily paused
          if (attractionVQueueData.nextScheduledOpenTime) {
            allocationStatus = boardingGroupState.paused;
          } else {
            // otherwise... no future times? we're closed for the day
            allocationStatus = boardingGroupState.closed;
          }
        }

        // extract allocation time and present as a full datetime string
        let nextAllocationTime = null;
        if (attractionVQueueData.nextScheduledOpenTime) {
          const nowDate = this.getTimeNowMoment().format('YYYY-MM-DD');
          nextAllocationTime = moment.tz(
            `${nowDate}T${attractionVQueueData.nextScheduledOpenTime}`,
            this.config.timezone,
          ).format();
        }

        // pull estimated wait data, if valid/exists
        let estimatedWait = null;
        if (allocationStatus === boardingGroupState.available) {
          estimatedWait = attractionVQueueData.waitTimeMin || null;
        }

        data.queue[queueType.boardingGroup] = {
          allocationStatus: allocationStatus,
          currentGroupStart: attractionVQueueData.currentArrivingGroupStart || null,
          currentGroupEnd: attractionVQueueData.currentArrivingGroupEnd || null,
          nextAllocationTime: nextAllocationTime || null,
          estimatedWait,
        };
      }
    }

    // inject prediction data from Genie
    const forecastDocId = `${this.resortShortcode}.forecastedwaittimes.1_0.en_us.${data._id}`;
    try {
      const forecastDoc = await this.db.get(forecastDocId);
      if (forecastDoc && forecastDoc.forecasts && forecastDoc.forecasts.length > 0) {
        // check forecast data is relevant for current time

        // get the largest timestamp from forecast data
        const now = this.getTimeNowMoment();
        const lastTimeslot = forecastDoc.forecasts.reduce((prev, curr) => {
          if (!curr) return prev;
          if (prev && prev.timestamp > curr.timestamp) {
            return prev;
          }
          return curr;
        });

        if (lastTimeslot && lastTimeslot.timestamp) {
          // forecasts are in hour slots, so add an hour to the last timestamp
          const lastHour = moment(lastTimeslot.timestamp).add(1, 'hour');
          if (lastHour.isAfter(now)) {
            // we have a valid forecast for today, return it
            data.forecast = forecastDoc.forecasts.map((x) => {
              if (!x) return null;
              return {
                time: moment(x.timestamp).tz(this.config.timezone).format(),
                waitTime: isNaN(x.forecastedWaitMinutes) ? null : x.forecastedWaitMinutes,
                percentage: isNaN(x.percentage) ? null : x.percentage,
              };
            }).filter((x) => !!x);
          }
        }
      }
    } catch (e) { }

    // add any data from daily Entertainment feed
    if (docEntityType === 'Entertainment') {
      // grab entity showtimes
      const entertainmentToday = await this.db.get(`${this.resortShortcode}.today.1_0.Entertainment`);
      if (entertainmentToday && entertainmentToday.facilities) {
        const showtimes = (entertainmentToday.facilities[doc.id] || []).filter((x) => {
          // ignore invalid schedule types
          return invalidScheduleTypes.indexOf(x.scheduleType) < 0;
        });

        if (showtimes.length === 0) {
          data.status = statusType.closed;
        }

        // add showtimes to livedata
        data.showtimes = showtimes.map((time) => {
          return {
            startTime: moment(time.startTime).tz(this.config.timezone).format(),
            endTime: moment(time.endTime).tz(this.config.timezone).format(),
            type: time.scheduleType,
          };
        });
      }
    } else if (docEntityType === 'restaurant') {
      // TODO - restaurant specific live data
    } else if (docEntityType === 'Attraction') {
      // attraction-specific live data

      // check today's schedule for refurbishments!
      const attractionsToday = await this.db.get(`${this.resortShortcode}.today.1_0.Attraction`);
      if (attractionsToday !== undefined && attractionsToday.facilities) {
        const attractionSchedule = attractionsToday.facilities[doc.id];
        if (attractionSchedule) {
          // look for schedules with "Closed" or "Refurb"
          if (attractionSchedule.length === 1) {
            if (attractionSchedule[0].scheduleType === 'Closed') {
              data.status = statusType.closed;
            } else if (attractionSchedule[0].scheduleType === 'Refurbishment') {
              data.status = statusType.refurbishment;
            }
          }

          // TODO - store attraction operating hours in live data
        }
      }
    }

    // before we do any queue stuff, check if the lastUpdate is vaguely recent
    const lastUpdateTime = moment(doc.lastUpdate || 0);
    const now = moment();

    // if status was updated in past ~2 months, then push queue data
    //  otherwise, ignore, queues not used
    const daysSinceLastUpdate = now.diff(lastUpdateTime, 'days');
    if (daysSinceLastUpdate < 60) {
      // report wait minutes for standBy line (if present)
      //  pretty much any entity can have waitMinutes
      // ignore if doc status is "Virtual Queue", which means only Virtual Queue is available for this attraction (right now)
      if (doc.waitMinutes !== undefined && doc.status !== 'Virtual Queue') {
        if (!data.queue) data.queue = {};
        data.queue[queueType.standBy] = {
          waitTime: doc.waitMinutes || null,
        };
      }

      // populate the single ride queue status if this ride offers single rider
      if (doc.singleRider) {
        if (!data.queue) data.queue = {};
        data.queue[queueType.singleRider] = {
          // TODO - can we get single ride wait time?
          waitTime: null,
        };
      }
    }

    return data;
  }

  /**
   * Return all current live entity data
   */
  async buildEntityLiveData() {
    // fetch the current attraction times
    const allStatusDocs = await this.db.getByChannel(this.getFacilityStatusChannelID());
    const docs = [];
    for (let i = 0; i < allStatusDocs.length; i++) {
      const liveDoc = await this._buildLiveDataObject(allStatusDocs[i]);
      if (liveDoc) {
        docs.push(liveDoc);
      }
    }

    // loop over entertainment and pretend we have facility update docs for them
    const entertainmentToday = await this.db.get(`${this.resortShortcode}.today.1_0.Entertainment`);
    if (entertainmentToday && entertainmentToday.facilities) {
      const entertainmentEntities = Object.keys(entertainmentToday.facilities);
      for (let i = 0; i < entertainmentEntities.length; i++) {
        const facId = entertainmentEntities[i];
        // look for existing live data doc that has a facility status entry
        const liveDataIdx = docs.findIndex((x) => x._id === facId);
        if (liveDataIdx < 0) {
          // if we don't have a doc already, we create a "fake" one
          // build a pretend facilitystatus doc and push to docs
          const liveData = await this._buildLiveDataObject({
            id: facId,
          });
          if (liveData) {
            docs.push(liveData);
          }
        }
      }
    }

    // TODO - do something with invalid objects (?!)
    // const errors = docs.filter((x) => x.status !== 'fulfilled');

    return docs;
  }

  /**
   * Setup our live status update subscriptions
   */
  async initLiveStatusUpdates() {
    // subscribe to any live facility status updates
    this.db.subscribeToChannel(this.getFacilityStatusChannelID(), async (doc) => {
      // create our live data object and submit to resort
      const livedata = await this._buildLiveDataObject(doc);
      if (!livedata) return; // skip any invalid livedata objects

      try {
        this.updateEntityLiveData(doc.id, livedata);
      } catch (e) {
        console.error(e);
      }
    });
  }

  /**
   * Given a name for an entity, clean up any strings we don't want
   * @param {string} name
   * @return {string}
   */
  sanitizeEntityName(name) {
    let newName = `${name}`;

    // trim any name endings we don't want to transfer to our entity object
    const cutoffExcessiveNameEndings = [
      ' – Opens',
      ' - Opens',
      ' – Reopening',
      ' - Reopening',
      ' – Temporarily Unavailable',
      ' - Temporarily Unavailable',
      ' – Temporarily ',
      ' - Temporarily ',
      ' – Coming ',
      ' - Coming ',
      ' – Legacy Passholder Dining',
      ' - Legacy Passholder Dining',
      ' – Opening ',
      ' - Opening ',
      ' - Returning',
      ' – Returning',
      ' – Now Open!',
    ];
    cutoffExcessiveNameEndings.forEach((str) => {
      const substrFound = newName.indexOf(str);
      if (substrFound > 0) {
        newName = newName.slice(0, substrFound);
      }
    });

    return newName;
  }

  /**
   * Given a basic document build a generic entity doc.
   * This should include all fields that are in any entity type.
   * @param {object} doc
   * @return {object}
   */
  buildBaseEntityObject(doc) {
    const entity = {
      // add any resort-agnostic data from the parent first
      ...super.buildBaseEntityObject(doc),
      _id: doc.id,
      _docId: doc._id,
      name: this.sanitizeEntityName(doc.name),
    };

    if (doc.longitude && doc.latitude) {
      entity.location = {
        longitude: Number(doc.longitude),
        latitude: Number(doc.latitude),
        // TODO - return entrance/exit/shop/etc. interesting points
        //  that aren't neccessarily the "main location"
        pointsOfInterest: [],
      };
    }

    // search for any related locations that is a theme-park - this tells us this entity is within this park!
    //  set this so we can correctly build our entity heirarchy
    // skip if our type is actuall "theme-park", as parks aren't parented to themselves
    if (
      parkTypes.indexOf(doc.type) < 0 &&
      doc.relatedLocations &&
      doc.relatedLocations.length > 0 &&
      doc.relatedLocations[0].ancestors
    ) {
      // try to find parkId (if it exists)
      const park = doc.relatedLocations[0].ancestors.find((x) => {
        return parkTypes.indexOf(x.type) >= 0;
      });
      if (park) {
        entity._parkId = park.id;
      }
    }

    // tags
    if (doc.facets) {
      if (doc.facets.find((x) => x.id === 'expectant-mothers')) {
        entity.unsuitableForPregnantPeople = true;
      }
    }

    // TODO - rename so something park-agnostic?
    if (doc.fastPassPlus !== undefined) {
      entity.fastPass = !!doc.fastPassPlus;
    }

    // if we're not inside a park, parent ourselves to the *something*
    const nonParkParentPriority = [
      'theme-park',
      'water-park',
      'Entertainment-Venue', // eg. Disney Springs
      'destination',
    ];
    // look through list in order until we find an entity we can attach to
    let parentDoc;
    if (doc.relatedLocations && doc.relatedLocations.length > 0 && doc.relatedLocations[0].ancestors) {
      for (let parentTypeIdx = 0; parentTypeIdx < nonParkParentPriority.length; parentTypeIdx++) {
        const parentType = nonParkParentPriority[parentTypeIdx];
        parentDoc = doc.relatedLocations[0].ancestors.find((x) => {
          return x.type === parentType && x.id !== doc.relatedLocations[0].id;
        });
        if (parentDoc) break;
      }

      if (parentDoc) {
        entity._parentId = parentDoc.id;
      }
    }

    return entity;
  }

  /**
   * Return entity document for this destination
   */
  async buildDestinationEntity() {
    const resortIndex = await this.db.getEntityIndex(this.resortId, {
      entityType: 'destination',
    });
    if (resortIndex.length === 0) return undefined;

    const doc = await this.db.get(resortIndex[0]._id);

    return {
      ...this.buildBaseEntityObject(doc),
      entityType: entityType.destination,
      slug: doc.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(),
    };
  }

  /**
   * Return all park entities for this resort
   */
  async buildParkEntities() {
    const parkData = (await Promise.all(this.parkIds.map(async (parkID) => {
      return this.db.getEntityOne(parkID);
    }))).filter((x) => !!x);

    const resort = await this.getDestinationEntity();

    return parkData.map((park) => {
      return {
        ...this.buildBaseEntityObject(park),
        entityType: entityType.park,
        // parks are parented to the resort
        _parentId: resort._id,
        slug: park.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(),
      };
    });
  }

  /**
   * @inheritdoc
   */
  async buildAttractionEntities() {
    const attractions = await this.db.find({
      type: 'Attraction',
      relatedLocations: {
        $elemMatch: {
          ancestors: {
            $elemMatch: {
              id: {
                $regex: this.destinationDocumentIDRegex,
              },
            },
          },
        },
      },
      // ignore any attractions with zero facets
      facets: {
        $exists: true,
      },
    });

    // filter out known bad names
    const ignoreAttractions = [
      /^Disney Park Pass$/,
      /Park Pass \- Afternoon$/,
      /Play Disney Parks/,
      /^Temporarily Unavailable Entertainment/,
    ];

    const entities = attractions.filter((attr) => {
      return !ignoreAttractions.find((x) => {
        return !!attr.name.match(x);
      });
    }).map((attraction) => {
      // turn into entity objects

      // TODO - add extra meta data to entity objects
      let type = attractionType.unknown;
      const hasFacet = (facet) => {
        if (!attraction?.facets) return false;
        return !!attraction.facets.find((x) => {
          return x.id === facet;
        });
      };

      // figure out ride type from available facets...
      if (
        hasFacet('slow-rides') ||
        hasFacet('small-drops') ||
        hasFacet('thrill-rides') ||
        hasFacet('spinning')
      ) {
        type = attractionType.ride;
      }

      return {
        ...this.buildBaseEntityObject(attraction),
        entityType: entityType.attraction,
        attractionType: type,
      };
    });

    return entities;
  }

  /**
   * @inheritdoc
   */
  async buildShowEntities() {
    // filter out known bad names
    const ignoreShows = [
      /^Temporarily Unavailable Entertainment/,
    ];

    return (await this.db.find({
      type: 'Entertainment',
      relatedLocations: {
        $elemMatch: {
          ancestors: {
            $elemMatch: {
              id: {
                $regex: this.destinationDocumentIDRegex,
              },
            },
          },
        },
      },
    })).filter((show) => {
      return !ignoreShows.find((x) => {
        return !!show.name.match(x);
      });
    }).map((re) => {
      return {
        ...this.buildBaseEntityObject(re),
        entityType: entityType.show,
      };
    });
  }

  /**
   * Fetch restaurant menu JSON
   * @param {string} id
   * @private
   */
  async _fetchRestaurantMenu(id) {
    // TODO - implement a separate menu service
    //  this API returns errors *a lot*, so we should fetch on a very gentle cycle and cache heavily
    return null;

    return this.cache.wrap(
      `menu_${id}`,
      async () => {
        try {
          const data = await this.http(
            'GET',
            `https://dining-menu-svc.wdprapps.disney.com/diningMenuSvc/orchestration/menus/${id}`,
            null,
            {
              retries: 0,
            },
          );
          if (data && data.body) {
            return data.body;
          }
        } catch (e) { }
        return null;
      },
      1000 * 60 * 60 * 6, // cache for 6 hours
    );
  }

  /**
   * Get the menu for a given resturant entity ID
   * @param {string} id
   */
  async getRestaurantMenu(id) {
    try {
      const menu = await this._fetchRestaurantMenu(id);
      if (!menu) return undefined;

      const menuData = menu.menus.map((menuGroup) => {
        if (!menuGroup.menuGroups) {
          return undefined;
        }

        const items = [];

        let groupPrice = null;

        // WDW menus are split into Entree,Desert etc. "menuGroups" - loop through them all and build them into a list
        menuGroup.menuGroups.forEach((group) => {
          // look for buffet pricings
          // extract characters and digits to find pricing categories
          const findBuffetPrices = /([^\/\(]+\d+\.\d+)/g;
          let match;
          while (match = findBuffetPrices.exec(group.names.PCLong)) {
            // split each buffet price into name and USD
            const nameAndPrice = /(.*)\s+(\d+\.\d+)/;
            const priceData = nameAndPrice.exec(match[1]);
            if (priceData) {
              if (groupPrice === null) {
                groupPrice = [];
              }

              // add each unique price name once
              const priceName = priceData[1].trim();
              if (groupPrice.findIndex((x) => x.name === priceName) < 0) {
                groupPrice.push({
                  name: priceData[1].trim(),
                  USD: Number(priceData[2]) * 100,
                });
              }
            }
          }

          group.menuItems.forEach((dish) => {
            const newDish = {
              name: dish.names.PCLong || dish.names.MobileLong || dish.names.PCShort || dish.names.MobileShort || null,
              description: dish?.descriptions?.PCLong?.text ||
                dish?.descriptions?.MobileLong?.text ||
                dish?.descriptions?.MobileShort?.text ||
                null,
              group: group.menuGroupType,
              price: null,
            };

            if (dish?.prices?.PerServing?.withoutTax) {
              // standard per-serving prices
              newDish.price = [{
                USD: dish.prices.PerServing.withoutTax * 100,
              }];
            } else if (dish.prices) {
              // not per serving price
              newDish.price = Object.keys(dish.prices).map((x) => {
                return {
                  name: dish.prices[x].type,
                  USD: dish.prices[x].withoutTax * 100,
                };
              });
            }

            items.push(newDish);
          });
        });

        return {
          type: menuGroup.menuType,
          description: `${menuGroup.primaryCuisineType} - ${menuGroup.serviceStyle} - ${menuGroup.experienceType}`,
          items,
          price: groupPrice, // a menu can have a price (buffets etc.)
        };
      }).filter((x) => !!x);

      return menuData;
    } catch (e) {
      console.error(e);
    }
    return undefined;
  }

  /**
   * @inheritdoc
   */
  async buildRestaurantEntities() {
    const restaurants = (await this.db.find({
      type: 'restaurant',
      relatedLocations: {
        $elemMatch: {
          ancestors: {
            $elemMatch: {
              id: {
                $regex: this.destinationDocumentIDRegex,
              },
            },
          },
        },
      },
    })).filter((restaurant) => {
      // only include "proper" resturants
      //  avoid listing every coffee stand etc.

      // determine resturant type using available facets
      if (!restaurant.facets) return false;
      const tableService = restaurant.facets.find((x) => x.id === 'table-service');
      // some resturants are missing the 'table-service' facet, but have other facets that are similar
      const tableReservations = restaurant.facets.find((x) => x.id === 'reservations-accepted');
      // TODO - also add quick service
      return !!tableService || !!tableReservations;
    }).map((re) => {
      // TODO - populate with any other interesting restaurant detail
      return {
        ...this.buildBaseEntityObject(re),
        entityType: entityType.restaurant,
        // list of available cuisines
        cuisines: re.facets.filter((x) => x.group === 'cuisine').map((x) => {
          return x.name;
        }),
      };
    });

    // fetch menus
    /* for (let i = 0; i < restaurants.length; i++) {
      restaurants[i].menus = (await this.getRestaurantMenu(restaurants[i]._id)) || null;
    }*/

    return restaurants;
  }

  /**
   *
   * @param {array<string>} ids document IDs to get schedules for
   * @param {moment} date Moment date to get schedule data for
   * @return {array<object>} Array of objects containing _id and schedule
   */
  async _getSchedulesForDate(ids, date) {
    const dateCalendar = await this.db.getByChannel(
      `${this.config.resortShortcode}.calendar.1_0`,
      {
        'id': date.format('DD-MM'),
      },
    );

    if (dateCalendar.length === 0) {
      return [];
    }
    const calendar = dateCalendar[0];

    const hours = calendar.parkHours.filter((h) => {
      // filter for hours for any of our parks
      return ids.indexOf(h.facilityId) >= 0 &&
        // that aren't closed hours (just ignore these)
        h.scheduleType !== 'Closed' &&
        // ignore annual pass blockout data
        h.scheduleType.indexOf('blockout') < 0;
    }).reduce((p, x) => {
      let hoursType = scheduleType.operating;

      switch (x.scheduleType) {
        case 'Operating':
          hoursType = scheduleType.operating;
          break;
        case 'Park Hopping':
          hoursType = scheduleType.informational;
          break;
        default:
          // default to a ticketed event
          hoursType = scheduleType.ticketed;
          break;
      }

      p[ids.indexOf(x.facilityId)].schedule.push({
        date: moment(x.startTime).tz(this.config.timezone).format('YYYY-MM-DD'),
        openingTime: moment(x.startTime).tz(this.config.timezone).format(),
        closingTime: moment(x.endTime).tz(this.config.timezone).format(),
        type: hoursType,
        description: hoursType != scheduleType.operating ? x.scheduleType : undefined,
      });

      return p;
    }, ids.map((x) => {
      return {
        _id: x,
        schedule: [],
      };
    }));

    return hours;
  }

  /**
   * @inheritdoc
   */
  async buildEntityScheduleData() {
    // grab park IDs!
    const parks = await this.getParkEntities();
    const parkIds = parks.map((x) => {
      return x._id;
    });

    // grab schedules for our parks
    const daysToReturn = 150;
    const now = this.getTimeNowMoment();
    const endDate = now.clone().add(daysToReturn, 'day');
    const returnData = parkIds.map((x) => {
      return {
        _id: x,
        schedule: [],
      };
    });
    for (; now.isSameOrBefore(endDate, 'day'); now.add(1, 'day')) {
      const dateData = await this._getSchedulesForDate(parkIds, now);
      dateData.forEach((entity) => {
        returnData[parkIds.indexOf(entity._id)].schedule.push(...entity.schedule);
      });
    }
    return returnData;
  }
};

/**
 * Walt Disney World Resort
 */
export class WaltDisneyWorldResort extends DisneyLiveResort {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.name = options.name || 'Walt Disney World Resort';
    options.timezone = options.timezone || 'America/New_York';

    options.resortId = options.resortId || 80007798;
    options.resortShortcode = options.resortShortcode || 'wdw';

    options.parkIds = options.parkIds || [
      80007944, // Magic Kingdom
      80007838, // Epcot
      80007998, // Hollywood Studios
      80007823, // Animal Kingdom
      // water parks
      80007981, // Typhoon Lagoon
      80007834, // Blizzard Beach
    ];

    super(options);
  }
}

/**
 * Disneyland Resort
 */
export class DisneylandResort extends DisneyLiveResort {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.name = options.name || 'Disneyland Resort';
    // TODO - calculate this from resort entity's location
    options.timezone = options.timezone || 'America/Los_Angeles';

    options.resortId = options.resortId || 80008297;
    options.resortShortcode = options.resortShortcode || 'dlr';

    options.parkIds = options.parkIds || [
      330339, // Disneyland Park
      336894, // California Adventure
    ];

    super(options);
  }
}

/**
 * Hong Kong Disneyland Resort
 */
export class HongKongDisneyland extends DisneyLiveResort {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.name = options.name || 'HongKong Disneyland';
    // TODO - calculate this from resort entity's location
    options.timezone = options.timezone || 'Asia/Hong_Kong';

    options.resortId = options.resortId || 'hkdl';
    options.resortShortcode = options.resortShortcode || 'hkdl';

    options.parkIds = options.parkIds || [
      'desHongKongDisneyland',
    ];

    super(options);
  }

  /**
   * HK stores menus as PDFs, this function does nothing (yet?)
   * @return {null}
   */
  async _fetchRestaurantMenu() {
    return null;
  }
}
