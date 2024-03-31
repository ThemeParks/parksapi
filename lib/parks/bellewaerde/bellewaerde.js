import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';

export class BellewaerdeBase extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Europe/Brussels';

    options.name = options.name || '';
    options.destinationSlug = options.destinationSlug || '';
    options.parkId = options.parkId || '';
    options.baseURL = options.baseURL || 'https://www.bellewaerde.be/en/api/';
    options.realtimeURL = options.realtimeURL || '';

    super(options);

    if (!this.config.name) throw new Error('Bellewaerde park name is required');
    if (!this.config.destinationSlug) throw new Error('Bellewaerde park destination slug is required');
    if (!this.config.parkId) throw new Error('Bellewaerde park id is required');
    if (!this.config.baseURL) throw new Error('baseURL is required');
    if (!this.config.realtimeURL) throw new Error('realtimeURL is required');
  }

  /**
   * Return the park data for this destination
   */
  async fetchEntertainmentData() {
    '@cache|360'; // cache for 6 hours
    const url = `${this.config.baseURL}entertainments?_format=json`;
    const response = await this.http(url);
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

    if (data) {
      if (data.code) {
        entity._id = `${data.code}`;
      }

      if (data.title) {
        entity.name = data.title.trim();
      }

      if (data.location) {
        entity.location = {
          longitude: Number(data.location.lon),
          latitude: Number(data.location.lat),
        };
      }

      if (data.parameters) {
        // TODO - min height tags etc.
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
      _id: this.config.destinationSlug,
      slug: this.config.destinationSlug, // all destinations must have a unique slug
      name: this.config.name,
      entityType: entityType.destination,
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    return [
      {
        ...this.buildBaseEntityObject(null),
        _id: this.config.parkId,
        _destinationId: this.config.destinationSlug,
        _parentId: this.config.destinationSlug,
        slug: this.config.parkId,
        name: this.config.name,
        entityType: entityType.park,
      }
    ];
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const data = await this.fetchEntertainmentData();

    return data.entertainment.map(attraction => {
      return {
        ...this.buildBaseEntityObject(attraction),
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
        _parentId: this.config.parkId,
        _parkId: this.config.parkId,
        _destinationId: this.config.destinationSlug,
      };
    });
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    const data = await this.fetchEntertainmentData();

    return data.show.map(show => {
      return {
        ...this.buildBaseEntityObject(show),
        entityType: entityType.show,
        _parentId: this.config.parkId,
        _parkId: this.config.parkId,
        _destinationId: this.config.destinationSlug,
      };
    });
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    const data = await this.fetchEntertainmentData();

    return data.restaurant.map(show => {
      return {
        ...this.buildBaseEntityObject(show),
        entityType: entityType.restaurant,
        _parentId: this.config.parkId,
        _parkId: this.config.parkId,
        _destinationId: this.config.destinationSlug,
      };
    });
  }

  /**
   * Fetch raw realtime data from API
   */
  async fetchRealTimeData() {
    '@cache|1'; // cache for 1 minute
    const response = await this.http(this.config.realtimeURL);
    return response.body;
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const data = await this.fetchRealTimeData();

    return data.map((entry) => {
      // don't return any live data if there is no open/close time
      //  also ignore "00:00" opening times, these are things like "animals"
      if (!entry?.open || !entry?.close || (entry.open === '00:00' && !entry.shows)) return null;

      const data = {
        _id: `${entry.id}`,
        status: statusType.operating,
      };

      // show times
      if (entry.shows) {
        // parse show times
        const now = this.getTimeNowMoment().seconds(0).milliseconds(0);
        let latestPerformance = null;

        data.showtimes = entry.shows.map((time) => {
          const timeSplit = time.start.split(':');
          const showStartTime = now.clone().hours(timeSplit[0]).minutes(timeSplit[1]);
          const showEndTime = showStartTime.clone().add(Number(time.duration), 'minutes');
          
          if (latestPerformance == null || showEndTime.isAfter(latestPerformance)) {
            latestPerformance = showEndTime.clone();
          }
          
          return {
            startTime: showStartTime.format(),
            endTime: showEndTime.format(),
            type: "Performance",
          };
        });

        // close show after last performance ends
        if (latestPerformance && latestPerformance.isBefore(now)) {
          data.status = statusType.closed;
        }

        // early out to skip queue logic
        return data;
      }

      if (entry.wait === null) return null;

      // parse wait time
      const waitTime = Number(entry.wait);
      if (waitTime > 0) {
        data.queue = {
          [queueType.standBy]: {
            waitTime: waitTime,
          },
        };
      } else {
        // assume anything <0 means closed
        data.status = statusType.closed;
      }

      // parse opening times to mark ride as closed outside operating hours
      if (data.status != statusType.closed) {
        // get local time
        try {
          const now = this.getTimeNowMoment();
          const open = entry.open.split(":");
          const close = entry.close.split(":");
          const openingTime = now.clone().hour(Number(open[0])).minute(Number(open[1]));
          const closingTime = now.clone().hour(Number(close[0])).minute(Number(close[1]));
          if (closingTime.isBefore(openingTime)) {
            // closing time is tomorrow
            closingTime.add(1, 'day');
          }

          // if now is before opening time, set status to closed
          if (now.isBefore(openingTime) || now.isAfter(closingTime)) {
            data.status = statusType.closed;
          }
        } catch (e) {
          this.emit('error', entry.id, e);
          // console.error('Failed to parse Bellewarde attraction times', e);
        }
      }

      return data;
    }).filter((x) => !!x);
  }

  /**
   * Get raw calendar data for a given year
   */
  async fetchCalendarForYear(year) {
    '@cache|720'; // cache for 12 hours
    const url = `${this.config.baseURL}calendar/${year}?_format=json`;
    const response = await this.http(url);
    return response.body;
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    // since we can fetch a whole year at a time, fetch the next 6 months
    const now = this.getTimeNowMoment();
    const end = now.clone().add(6, 'months');
    const years = [];
    for (let year = now.year(); year <= end.year(); year++) {
      years.push(year);
    }

    const parkSchedule = [];

    for (const year of years) {
      const data = await this.fetchCalendarForYear(year);

      if (data?.opening_hours) {
        Object.keys(data.opening_hours).forEach((dateString) => {
          if (!data.opening_hours[dateString]?.status || data.opening_hours[dateString].status !== 'open') {
            // ignore closed dates
            return;
          }

          try {
            // parse date schedule
            const dateObj = data.opening_hours[dateString];
            const openingStr = dateObj.mo_time;
            const closingStr = dateObj.mc_time;
            const open = openingStr.split(":");
            const close = closingStr.split(":");
            const date = dateString.split('/');
            const month = Number(date[0]) - 1;
            const day = Number(date[1]);

            const openingTime = now.clone().set({second: 0, millisecond: 0}).year(year).month(month).date(day).hour(Number(open[0])).minute(Number(open[1]));
            const closingTime = openingTime.clone().hour(Number(close[0])).minute(Number(close[1]));

            parkSchedule.push({
              date: openingTime.format("YYYY-MM-DD"),
              type: scheduleType.operating,
              openingTime: openingTime.format(),
              closingTime: closingTime.format(),
            })
          } catch (e) {
            this.emit('error', this.config.parkId, `Failed to parse Bellewarde park schedule for ${year}`, e);
          }

        });
      }
    }

    return [
      {
        _id: this.config.parkId,
        schedule: parkSchedule,
      }
    ];
  }
}

export class Bellewaerde extends BellewaerdeBase {
  constructor(options = {}) {
    options.name = options.name || 'Bellewaerde';
    options.timezone = options.timezone || 'Europe/Brussels';

    options.destinationSlug = 'bellewaerde';
    options.parkId = 'bellewaerdepark';

    super(options);
  }
}

// quick solution to weird Walibi Holland API, see if we can figure this out properly
const walibiLiveMappings = [
  {
      "liveId": "090ca7ed-eb0e-4309-a4da-535b52365a61",
      "poiId": "80fed793-5d83-418d-8c76-4c779797ab8e"
  },
  {
      "liveId": "2e00b0e0-6c09-48ca-a5f7-7a0ee516ac55",
      "poiId": "97adc337-5c3c-4ea8-8841-499229481e48"
  },
  {
      "liveId": "69baad55-80e9-46df-96bd-e029c14edda9",
      "poiId": "7f4f86d2-4a98-4ae1-bda6-1df3248c8e67"
  },
  {
      "liveId": "9a0eae38-8e3e-43f3-8d20-e8045d21c8c7",
      "poiId": "6b2ad033-db04-48cc-84cc-fc2265c985fd"
  },
  {
      "liveId": "e2f673a7-8113-4535-af32-a714662ce7aa",
      "poiId": "82e51db3-f2ec-4ffb-854a-06907d77707d"
  },
  {
      "liveId": "3ec17cee-773e-4932-804d-3b50db031bb5",
      "poiId": "ed9d0410-f2f0-40bf-aa20-3c76eb3b811d"
  },
  {
      "liveId": "7d6fa728-5c7c-4e4b-9d5c-9cb8bd38fc1d",
      "poiId": "7f7459c3-1c9d-4c55-8aa8-386b3c2d11f3"
  },
  {
      "liveId": "825b9411-2145-449f-b49c-e4e6d0cd83c9",
      "poiId": "4fb5b0b1-418e-42bc-abcf-eee147bf4af4"
  },
  {
      "liveId": "8f600481-e36f-436e-8101-c06391b24ec6",
      "poiId": "25f9445f-26d3-4b11-8ca7-c656f79be563"
  },
  {
      "liveId": "7189c412-4bc2-49d6-99ef-4ee06773ece8",
      "poiId": "39e88649-c7ee-4809-8244-fb5e290488ea"
  },
  {
      "liveId": "8c3bf7c1-04cc-42e8-8e1b-154373e3d342",
      "poiId": "50ff42b1-a642-4ef9-b006-053907d19e77"
  },
  {
      "liveId": "61057d6a-2ef1-44af-bf5c-f33ea12ae8aa",
      "poiId": "d3528b4d-8b69-4520-9d95-2892f01d1aa3"
  }
];

export class WalibiHolland extends BellewaerdeBase {
  constructor(options = {}) {
    options.name = options.name || 'Walibi Holland';
    options.timezone = options.timezone || 'Europe/Amsterdam';

    options.destinationSlug = 'walibiholland';
    options.parkId = 'walibihollandpark';

    super(options);
  }

  buildBaseEntityObject(data) {
    const ent = super.buildBaseEntityObject(data);

    if (data?.uuid) {
      ent._id = data.uuid;
    }

    return ent;
  }

  // override live data fetching for walibi holland
  async buildEntityLiveData() {
    const data = await this.fetchRealTimeData();

    return data.map((entry) => {
      if (!entry?.id) return null;

      const idMapping = walibiLiveMappings.find((x) => x.liveId === entry.id);
      if (!idMapping) {
        return null;
      }
      const entId = idMapping.poiId;

      const data = {
        _id: `${entId}`,
        status: statusType.operating,
      };

      switch (entry.state) {
        case 'closed':
        case 'closed_indefinitely':
        case 'full_and_closed':
          data.status = statusType.closed;
          break;
        case 'not_operational':
          // (at time of writing) this is used for "Blast" and a dummy ride
          return null;
        case 'full': // ride if open, but the queue is full
          data.status = statusType.down;
          // waitTimeMins will be 0, so don't return a queue at all!
          break;
        case 'open':
          data.status = statusType.operating;
          // parse wait time
          const waitTime = Number(entry.waitTimeMins || 0);
          data.queue = {
            [queueType.standBy]: {
              waitTime: Math.floor(waitTime),
            },
          };
          break;
        default:
          // unknown ride status - assume open but with no queue... ?
          data.status = statusType.operating;
          console.error('error', entry.id, `Unknown ride status ${entry.state} for ${entry.id}`, entry);
          break;
      }

      return data;
    }).filter((x) => !!x);
  }
}
