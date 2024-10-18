import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';
import moment from 'moment-timezone';

export class Liseberg extends Destination {
  constructor(options = {}) {
    options.timezone = options.timezone || 'Europe/Stockholm';
    options.resortId = options.resortId || 'liseberg';

    options.baseURL = options.baseURL || '';

    super(options);

    if (!this.config.resortId) throw new Error('Missing resortId');
    if (!this.config.baseURL) throw new Error('Missing baseURL');
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
      if (data.id) {
        entity._id = `${data.id}`;
      }

      if (data.title) {
        entity.name = data.title;
      }

      if (data.coordinates && data.coordinates.longitude && data.coordinates.latitude) {
        entity.location = {
          longitude: data.coordinates.longitude,
          latitude: data.coordinates.latitude,
        };
      }
    }

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    return {
      ...this.buildBaseEntityObject(null),
      _id: 'liseberg',
      slug: 'liseberg',
      name: 'Liseberg',
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
        _id: 'lisebergpark',
        _destinationId: 'liseberg',
        _parentId: 'liseberg',
        slug: 'lisebergpark',
        name: 'Liseberg',
        entityType: entityType.park,
        location: {
          latitude: 57.6945173,
          longitude: 11.9936954
        }
      }
    ];
  }

  /**
   * Fetch the attraction states from Liseberg API
   */
  async fetchAttractionStates() {
    '@cache|1';
    const resp = await this.http('GET', `${this.config.baseURL}app/attractions/`);
    return resp.body;
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const attractions = await this.fetchAttractionStates();

    if (!attractions || !Array.isArray(attractions)) {
      throw new Error('Failed to fetch attraction states');
    }

    return attractions.filter((x) => {
      return x?.type === 'attraction';
    }).map((attraction) => {
      return {
        ...this.buildBaseEntityObject(attraction),
        entityType: entityType.attraction,
        attractionType: attractionType.ride,
        _destinationId: 'liseberg',
        _parentId: 'lisebergpark',
        _parkId: 'lisebergpark',
      };
    });
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    return [];
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    return [];
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const attractions = await this.fetchAttractionStates();

    return attractions.map((attraction) => {
      const liveEntry = {
        _id: `${attraction.id}`,
        status: statusType.closed,
      };

      if (attraction.state) {
        liveEntry.status = attraction.state.isOpen ? statusType.operating : statusType.closed;
        liveEntry.queue = {
          [queueType.standBy]: {
            waitTime: attraction.state.maxWaitTime && attraction.state.maxWaitTime >= 0 ? attraction.state.maxWaitTime : null,
          },
        };
      }

      return liveEntry;
    });
  }

  /**
   * Fetch the calendar for a given date (and x days further)
   * @param {string} dateString Date in YYYY-MM-DD format 
   * @param {number} [datesToFetch=30] Number of dates to fetch from the dateString date 
   * @returns {object}
   */
  async fetchCalendarForDate(dateString, datesToFetch = 7) {
    '@cache|720'; // cache for 12 hours
    try {
      const resp = await this.http('GET', `${this.config.baseURL}calendar/${dateString}/${datesToFetch}`, undefined, {
        retries: 0,
      });
      return resp.body;
    } catch (e) {
      return [];
    }
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const now = this.getTimeNowMoment();
    const end = now.clone().add(60, 'days');

    const batchSize = 7;

    // loop through each 7 day block and fetch the calendar data for the next 30 days
    const calendarData = [];
    for (let i = now.clone(); i.isBefore(end); i.add(batchSize, 'days')) {
      const dateString = i.format('YYYY-MM-DD');
      const calendar = await this.fetchCalendarForDate(dateString, batchSize);
      calendarData.push(...calendar);
    }

    const times = [];

    calendarData.forEach((entry) => {
      if (entry.closed) return;
      const dateString = entry.dateRaw.slice(0, 10);
      const dateMoment = moment.tz(dateString, 'YYYY-MM-DD', this.config.timezone);

      const open = dateMoment.clone().hours(Number(entry.openingHoursDetailed.from)).minutes(0).seconds(0).milliseconds(0);
      const close = dateMoment.clone().hours(Number(entry.openingHoursDetailed.to)).minutes(0).seconds(0).milliseconds(0);

      times.push({
        date: dateString,
        type: "OPERATING",
        openingTime: open.format(),
        closingTime: close.format(),
      });

      // if we have evening hours, add these too
      if (entry.eveningEntranceFrom && entry.eveningEntranceFrom !== '00:00') {
        if (entry.eveningEntranceFrom.indexOf(':') >= 0) {
          const eveningOpen = dateMoment.clone().hours(Number(entry.eveningEntranceFrom.split(':')[0])).minutes(Number(entry.eveningEntranceFrom.split(':')[1])).seconds(0).milliseconds(0);
          if (eveningOpen.isBefore(close) && eveningOpen.isAfter(open)) {
            times.push({
              date: dateString,
              type: "INFO",
              description: "Evening Hours",
              openingTime: eveningOpen.format(),
              closingTime: close.format(),
            });
          }
        }
      }
    });

    return [
      {
        _id: 'lisebergpark',
        schedule: times,
      }
    ];
  }
}
