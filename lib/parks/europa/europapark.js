import EuropaParkDB from './europaparkdb.js';
import Park from '../park.js';
import {statusType, queueType, scheduleType, returnTimeState} from '../parkTypes.js';
import moment from 'moment-timezone';

/**
 * Europa Park Base Class
 */
export class EuropaParkBase extends Park {
  /**
   * @inheritdoc
   * @param {object} options
   */
  constructor(options = {}) {
    options.timezone = 'Europe/Berlin';

    options.parkId = options.parkId || '';

    super(options);

    if (!this.config.parkId) throw new Error('Missing Europa Park Id');
  }

  /**
   * Get our resort database
   */
  get db() {
    return EuropaParkDB.get();
  }

  /**
   * @inheritdoc
   */
  async _init() {
    // add all park attractions
    const attractions = await this.db.getEntities({
      // filter entities by our park ID
      '_src.scopes': {
        $elemMatch: {
          $eq: this.config.parkId,
        },
      },
    });

    // force inject each attraction so it appears in the attraction list, even if it has no wait times
    await Promise.allSettled(attractions.map(async (a) => {
      await this.findAttractionByID(a.id);
    }));
  }

  /**
   * @inheritdoc
   */
  async _buildAttractionObject(attractionID) {
    return await this.db.findEntity({
      'id': `${attractionID}`,
      // filter entities by our park ID
      '_src.scopes': {
        $elemMatch: {
          $eq: this.config.parkId,
        },
      },
    });
  }

  /**
   * @inheritdoc
   */
  async _update() {
    const waits = await this.db.getWaitingTimes();

    // just push all wait times, let our _buildAttractionObject filter out ones for other parks
    await Promise.allSettled(waits.waitingtimes.map(async (wait) => {
      let status = statusType.operating;
      let queue = queueType.standBy;

      // check to see if we're a virtual queue for another ride
      const realRide = await this.db.findEntity({
        '_src.vQueue.code': {
          $eq: wait.code,
        },
      });
      if (realRide !== undefined) {
        // we have a virtual queue!
        queue = queueType.returnTime;

        let state = returnTimeState.available;
        switch (wait.time) {
          case 666:
            state = returnTimeState.temporarilyFull;
            break;
          case 777:
            state = returnTimeState.finished;
            break;
          case (wait.time <= 91):
            state = returnTimeState.available;
            break;
        }

        // update return time queue
        await this.updateAttractionQueue(realRide._src.code, {
          returnStart: wait.startAt,
          returnEnd: wait.endAt,
          state,
        }, queueType.returnTime);

        // skip regular updating if we're a "return time" queue entry
        //  the standby version of the right will handle normal states
        return;
      }

      // if time == 90, wait time is reported as 90+ in-app
      // time == 91, virtual queue is open
      // time == 999, down
      // time == 222, closed refurb
      // time == 333, closed
      // time == 444, closed becaue weather
      // time == 555, closed because ice
      // time == 666, virtual queue is "temporarily full"
      // time == 777, virtual queue is completely full
      switch (wait.time) {
        case 999:
        case 444: // weather
        case 555: // ice
          status = statusType.down;
          break;
        case 222:
          status = statusType.refurbishment;
          break;
        case 333:
          status = statusType.closed;
          break;
      }

      await this.updateAttractionState(wait.code, status);

      if (queue == queueType.standBy) {
        await this.updateAttractionQueue(wait.code, wait.time <= 90 ? wait.time : null, queue);
      }
    }));
  }

  /**
   * @inheritdoc
   */
  async _getOperatingHoursForDate(date) {
    const cal = await this.db.getCalendar();
    const parkTimes = cal.seasons.filter(
        // filter opening hours for actual opening times (ignore closed times)
        // filter by scopes including our park Id
        (x) => !x.closed && x.scopes.indexOf(this.config.parkId) >= 0,
    ).find(
        // find valid season for the supplied date
        (x) => date.isBetween(x.startAt, x.endAt, 'day'),
    );

    if (parkTimes !== undefined) {
      const times = [];

      const buildDateString = (inDate) => {
        return moment.tz(inDate, this.config.timezone).set({
          year: date.year(),
          month: date.month(),
          date: date.date(),
        }).format();
      };

      times.push({
        openingTime: buildDateString(parkTimes.startAt),
        closingTime: buildDateString(parkTimes.endAt),
        type: scheduleType.operating,
      });

      // hotel extra hours
      if (parkTimes.hotelStartAt && parkTimes.hotelEndAt) {
        times.push({
          openingTime: buildDateString(parkTimes.hotelStartAt),
          closingTime: buildDateString(parkTimes.hotelEndAt),
          type: scheduleType.extraHours,
          description: 'Open To Hotel Guests',
        });
      }

      return times;
    }

    return undefined;
  }
}

/**
 * Europa Park
 */
export class EuropaPark extends EuropaParkBase {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.name = 'Europa-Park';
    options.parkId = 'europapark';
    super(options);
  }
}

/**
 * Rulantica
 */
export class Rulantica extends EuropaParkBase {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.name = 'Rulantica';
    options.parkId = 'rulantica';
    super(options);
  }
}

/**
 * Yullbe
 */
export class Yullbe extends EuropaParkBase {
  /**
   * @inheritdoc
   */
  constructor(options = {}) {
    options.name = 'Yullbe';
    options.parkId = 'yullbe';
    super(options);
  }
}

export default EuropaParkBase;

