import EuropaParkDB from './europaparkdb.js';
import {statusType, queueType, scheduleType, returnTimeState, entityType, attractionType} from '../parkTypes.js';
import moment from 'moment-timezone';
import Destination from '../destination.js';

export class EuropaPark extends Destination {
  constructor(options = {}) {
    options.name = options.name || "Europa-Park";
    options.timezone = options.timezone || 'Europe/Berlin';

    options.parks = [
      {
        id: 493,
        scope: 'europapark',
      },
      {
        id: 494,
        scope: 'rulantica',
      },
    ];

    super(options);

    if (!this.config.parks) throw new Error('Missing Europa Park Configs');
  }

  /**
   * Get our resort database
   */
  get db() {
    return EuropaParkDB.get();
  }

  static idToString(id) {
    return `europa_${id}`;
  }

  /**
   * @inheritdoc
   */
  buildBaseEntityObject(data) {
    const entity = Destination.prototype.buildBaseEntityObject.call(this, data);

    entity.name = data?.name;

    // add any entity locations
    if (data?.longitude && data?.latitude) {
      entity.location = {
        latitude: data.latitude,
        longitude: data.longitude,
      };
    } else if (data?._src?.longitude && data?._src?.latitude) {
      entity.location = {
        latitude: data._src.latitude,
        longitude: data._src.longitude,
      };
    }

    if (data?.id) {
      entity._id = `${data.id}`;
    }

    return entity;
  }

  /**
   * Build the destination entity representing this resort
   */
  async buildDestinationEntity() {
    return {
      ...this.buildBaseEntityObject({
        name: this.config.name,
      }),
      _id: 'europapark',
      slug: 'europa',
      entityType: entityType.destination,
    };
  }

  /**
   * Build the park entities for this resort
   */
  async buildParkEntities() {
    // find all our parks
    const poiData = await this.db.getParkData();

    const parks = poiData.filter((x) => {
      return x.type === 'park';
    });

    const destination = await this.buildDestinationEntity();

    return this.config.parks.map((parkConfig) => {
      const park = parks.find((x) => x.id === parkConfig.id);
      if (!park) return undefined;

      return {
        ...this.buildBaseEntityObject(park),
        _id: `park_${park.id}`,
        _destinationId: destination._id,
        _parentId: destination._id,
        entityType: entityType.park,
        slug: parkConfig.scope,
      };
    }).filter((x) => !!x);
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    const attr = [];
    const destination = await this.buildDestinationEntity();

    for (let i = 0; i < this.config.parks.length; i++) {
      const scope = this.config.parks[i].scope;
      const parkId = `park_${this.config.parks[i].id}`;

      // get attractions for each park scope
      const attractions = await this.db.getEntities({
        '_src.scopes': {
          $elemMatch: {
            $eq: scope,
          },
        },
        entityType: {
          $ne: 'SHOW',
        },
      });

      attractions.filter((x) => {
        // don't send + Pass entrances as separate entities
        if (x?._src?.name && x._src.name.indexOf('+ Pass entrance') > 0) {
          return false;
        }
        return true;
      }).forEach((a) => {
        // push all our attractions into a big array
        attr.push({
          ...this.buildBaseEntityObject(a),
          _parentId: parkId,
          _parkId: parkId,
          _destinationId: destination._id,
          entityType: entityType.attraction,
          // TODO - detect other types
          attractionType: attractionType.ride,
        });
      });
    }

    return attr;
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    const destination = await this.buildDestinationEntity();

    const attrs = await this.db.getEntities({
      entityType: 'SHOW',
    });

    const shows = [];

    const parkId = `park_${this.config.parks[0].id}`;
    attrs.forEach((a) => {
      shows.push({
        ...this.buildBaseEntityObject(a),
        _parentId: parkId,
        _parkId: parkId,
        _destinationId: destination._id,
        entityType: entityType.show,
      });
    });

    return shows;
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    // TODO
    return [];
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const attrs = await this.db.getEntities();

    const codeToEntityId = attrs.filter((x) => {
      return !!x._src.code;
    }).reduce((acc, x) => {
      if (x.id) {
        acc[x._src.code] = x.id;
      }
      return acc;
    }, {});

    const waits = await this.db.getWaitingTimes();
    const showtimes = await this.db.getShowTimes();

    const livedata = [];

    // first, extract out all the virtual queue data
    const vQueueData = [];
    for (let i = 0; i < waits.waitingtimes.length; i++) {
      const wait = waits.waitingtimes[i];

      const realRide = await this.db.findEntity({
        '_src.vQueue.code': {
          $eq: wait.code,
        },
      });

      if (realRide !== undefined) {
        // we found a "ride" that has a matching virtual queue
        //  so this is a "dummy" ride that we want to inject back into the actual ride entity
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

        // store vqueue data so we can pull this when looping over the actual wait time data
        const entityId = codeToEntityId[realRide._src.code];
        if (entityId) {
          vQueueData.push({
            _id: `${entityId}`,
            _ignoreCode: wait.code,
            returnStart: wait.startAt,
            returnEnd: wait.endAt,
            state,
          });
        }
      }
    }

    const getLiveDataEntry = (id) => {
      // search livedata for existing entry with this ID
      const existing = livedata.find((x) => x._id === id);
      if (existing) {
        return existing;
      }

      // create a new entry
      const newEntry = {
        _id: id,
        status: statusType.operating,
      };
      livedata.push(newEntry);
      return newEntry;
    };

    // now actually loop over the wait data
    for (let i = 0; i < waits.waitingtimes.length; i++) {
      const wait = waits.waitingtimes[i];

      // first check if this is a virtual queue "dummy" entry, and ignore
      if (vQueueData.find((x) => x._ignoreCode === wait.code)) {
        continue;
      }

      // get entity Id from waittime code
      const entityId = codeToEntityId[wait.code];
      if (!entityId) continue;

      const live = getLiveDataEntry(entityId);

      // if time <= 90, wait time is value in minutes
      // time == 91, wait time is reported as 90+ in-app
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
          live.status = statusType.down;
          break;
        case 222:
          live.status = statusType.refurbishment;
          break;
        case 333:
          live.status = statusType.closed;
          break;
      }

      // stand-by wait time
      if (!live.queue) live.queue = {};
      live.queue[queueType.standBy] = {
        waitTime: wait.time <= 91 ? Math.min(wait.time, 90) : null,
      };

      // look for any virtual queue data
      const vQ = vQueueData.find((x) => `${x._id}` === `${entityId}`);
      if (vQ) {
        live.queue[queueType.returnTime] = {
          returnStart: vQ.returnStart,
          returnEnd: vQ.returnEnd,
          state: vQ.state,
        };
      }
    }

    // showtimes
    showtimes.showtimes.forEach((show) => {
      const live = getLiveDataEntry(`shows_${show.showId}`);

      const showEnt = attrs.find((x) => x.id === `shows_${show.showId}`);
      if (!showEnt) {
        return;
      }

      live.showtimes = show.today.map((startTime) => {
        // startTime is a time string
        return {
          startTime: moment(startTime).tz(this.config.timezone).format(),
          endTime: moment(startTime).add(showEnt._src.duration || 0, 'minutes').tz(this.config.timezone).format(),
          type: 'Performance',
        };
      });

      // show status based on showtimes available
      if (live.showtimes.length === 0) {
        live.status = statusType.closed;
      } else {
        // if last show has ended, then mark as closed
        const lastTime = live.showtimes.reduce((acc, x) => {
          if (moment(x.endTime).isAfter(acc)) {
            return moment(x.endTime);
          }
          return acc;
        }, moment(live.showtimes[0].startTime));

        const now = this.getTimeNowMoment();
        if (now.isAfter(lastTime)) {
          live.status = statusType.closed;
        }
      }
    });

    return livedata;
  }

  async _getCalendarForPark(parkConfig) {
    const cal = await this.db.getCalendar();
    const now = this.getTimeNowMoment();

    const parkTimes = cal.seasons.filter(
      // filter opening hours for actual opening times (ignore closed times)
      // filter by scopes including our park Id
      (x) => !x.closed && x.scopes.indexOf(parkConfig.scope) >= 0,
    );

    const times = [];

    const buildDateString = (inDate, date) => {
      return moment.tz(inDate, this.config.timezone).set({
        year: date.year(),
        month: date.month(),
        date: date.date(),
      }).format();
    };

    parkTimes.forEach((hoursRange) => {

      const start = moment(hoursRange.startAt);
      const end = moment(hoursRange.endAt);

      for (let date = start.clone(); date.isSameOrBefore(end, 'day'); date.add(1, 'day')) {
        // ignore dates before now
        if (date.isBefore(now, 'day')) continue;

        times.push({
          date: date.format('YYYY-MM-DD'),
          openingTime: buildDateString(hoursRange.startAt, date),
          closingTime: buildDateString(hoursRange.endAt, date),
          type: scheduleType.operating,
        });

        // hotel extra hours
        if (hoursRange.hotelStartAt && hoursRange.hotelEndAt) {
          times.push({
            date: date.format('YYYY-MM-DD'),
            openingTime: buildDateString(hoursRange.hotelStartAt, date),
            closingTime: buildDateString(hoursRange.hotelEndAt, date),
            type: scheduleType.extraHours,
            description: 'Open To Hotel Guests',
          });
        }
      }
    });

    // fetch live opening times to inject on top
    if (parkConfig.scope === 'europapark') { // only do this for the actual theme park
      const livedata = await this.db.getLiveCalendar();
      if (livedata?.opentime?.today) {
        const date = livedata.opentime.today.date.substring(0, 10);
        const matchingDates = times.find((x) => x.date === date);
        if (matchingDates) {
          // replace existing opening times with live data
          matchingDates.openingTime = livedata.opentime.today.start;
          matchingDates.closingTime = livedata.opentime.today.end;
        }
      }
    }

    return {
      _id: `park_${parkConfig.id}`,
      schedule: times,
    };
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    const scheds = [];
    for (let i = 0; i < this.config.parks.length; i++) {
      scheds.push(await this._getCalendarForPark(this.config.parks[i]));
    }
    return scheds;
  }
}

export default EuropaPark;
