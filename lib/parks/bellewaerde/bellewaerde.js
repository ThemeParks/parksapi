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
      if (!entry?.open || !entry?.close || entry.open === '00:00') return null;

      // show times
      if (entry.shows) {
        // TODO - parse show times
        console.error('Bellewaerde show times not yet implemented');
        return null;
      }

      if (entry.wait === null) return null;

      const data = {
        _id: `${entry.id}`,
        status: statusType.operating,
      };


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

// all WalibiHolland rides returning "closed indefinitely" - do another pass once park is open
/*
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
}
*/
