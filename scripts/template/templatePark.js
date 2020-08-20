import {Park} from '../park.js';
import {attractionType, statusType, queueType, tagType, scheduleType} from '../parkTypes.js';

/**
 * Sample Park Object
 */
export class SamplePark extends Park {
  /**
   * Create a new Sample Park object
   * @param {object} options
   */
  constructor(options = {}) {
    options.name = options.name || 'Sample Park';
    options.timezone = options.timezone || 'Europe/London';

    // options that can be supplied to each instance of this park
    //  anything that can be overridden by environment variable needs to be declared,
    //  event if it is just an empty string
    // we will validate our inputs after running super, which will populate outr this.config object
    //  with any overridden configs from environment variables
    options.apiKey = '';

    // bump cache to invalidate the POI data that has been updated
    // options.cacheVersion = 1;

    super(options);

    // here we can validate the resulting this.config object
    if (!this.config.apiKey) throw new Error('Missing Sample Park apiKey');

    // setup any HTTP injections (optional)
    // this makes it easier to write API requests without repeating sending API keys etc.
    // the requesting URL is parsed using the NodeJS "new URL()"
    //  all fields in the URL object are available for mongo-style querying here
    // if the URL matches, the function supplied is called against all the incoming needle options
    // you cannot change the method or URL (these are passed-by-value), but can modify the data and options
    this.injectForDomain({
      $or: [
        {
          hostname: 'api.samplepark.com',
        },
        {
          hostname: 'tickets.samplepark.com',
        },
      ],
    }, async (method, url, data, options) => { // this function can be async (optional)
      // make sure our API key is passed in for all requests to these domains
      // at this stage we can guarantee the headers object has been created
      options.headers['x-api-key'] = this.config.apiKey;
    });
  }

  /**
   * @inheritdoc
   */
  async _init() {
    // you must implement an _init() function to setup the park class
    //  here you should perform any data-intensive initial setup tasks like
    //  fetching attraction data for long-term storage
    // not all park APIs require this, so can be left as a blank function if not needed

    // example use-case:
    //  fetch all the attraction data here, or start some live feed connection
  }

  /**
   * @inheritdoc
   */
  async _buildAttractionObject(attractionID) {
    // this function is called whenever findAttractionByID is called and the attraction doesn't exist yet
    // given an attractionID, this function should return an object containing
    //  some basic information about the attraction
    // you should also try to tag the attraction with as many valid tags as you can

    // first we would want to get the park's (cached) attraction data
    const attractionData = await this.getSampleParkAttractionData();

    // look-up our attraction's data in whatever form makes sense for how we're storing it
    const data = attractionData[attractionID];
    // if we return undefined, the park API will ignore this attraction request
    //  do this if we cannot find a match for the ID, or it's for an obscure attraction type
    //  that doesn't make sense here (eg. a "area of theme park coming soon!" non-attraction)
    if (!data) return undefined;

    // we should return an object with at least "type" and "name"
    // see parkTypes.attractionType for possible types

    // we can also add tags to the attraction
    //  tags are semi-strict metadata elements attractions can contain
    //  see tags.js for the supported tags (feel free to pull request to add more)
    //  some tags will have stricter rules on their content than others
    //   eg. location tag must contain longitude, latitude values, which must be valid numbers
    //  some tags are binary, meaning they are either present or not, needing no value
    //   eg. fastPass, mayGetWet - these are either present or not
    const tags = [];

    // example of a non-boolean tag, location
    if (data.attractionLocation) {
      tags.push({
        // tag id can be anything, rides can have multiple tags of the same type if they have different names
        //  standard is to use "location" for the attraction's main location
        //  but can add more for ride entrance, exit, fastpass queue, etc.
        // try to keep the main location called "location" so APIs can find it easily
        //  and use other locations if they want
        id: 'location',
        type: tagType.location,
        // location tag requires longitude and latitude numbers to be valid
        value: {
          longitude: 3.1415,
          latitude: 0.1337,
        },
      });
    }

    // example of a boolean tag,
    //  if our park's API has the field "pregnantWarning", we can add the unsuitableForPregnantPeople tag
    if (data.pregnantWarning) {
      tags.push({
        type: tagType.unsuitableForPregnantPeople,
        // even though this is a "boolean" tag, we need to give it a boolean value here
        //  if you set this to true, it will remove the tag from the attraction
        value: true,
      });
    }

    return {
      name: data.name,
      type: data.type === 'ride' ? attractionType.ride : attractionType.other,
      tags,
    };

    // example of the type of response expected
    return {
      name: 'Splash Mountain',
      type: attractionType.ride,
      tags: [
        {
          type: tagType.mayGetWet,
          value: true,
        },
      ],
    };
  }

  /**
   * @inheritdoc
   */
  async _update() {
    // _update() is called at an interval to fetch the latest state of the park
    // here you should request updated wait times etc.
    // call updateAttractionState and updateAttractionQueue to update an attraction

    const waitTimes = await this.fetchWaitTimes(); // call some custom method we have made

    // process all our wait times
    await Promise.allSettled(waitTimes.map(async (time) => {
      // update attraction state
      await this.updateAttractionState(
          time.attractionID,
          statusType.operating, // use statusType enum
      );

      // update queue status
      await this.updateAttractionQueue(
          time.attractionID,
          time.waitTime,
          queueType.standBy, // always pass in a queue type
      );
    }));
  }

  /**
   * @inheritdoc
   */
  async _getOperatingHoursForDate(date) {
    // date will be a Momentjs object
    // you need to supply an array of opening times for this date (or undefined if we can't or closed)

    // call some method we have created to fetch calendar data
    const cal = await this.getCalendarMonth(date.format('M'), date.format('YYYY'));
    if (cal === undefined) return undefined;

    // search our data object to find the right data based on however our data is stored
    const dateFormatted = date.format('YYYY-MM-DD');
    if (cal[dateFormatted] !== undefined) {
      return cal[dateFormatted];
    }

    return undefined;

    // example of the type of response expected
    return [
      {
        openingTime: '2020-08-20T10:00:00+01:00',
        closingTime: '2020-08-20T17:00:00+01:00',
        type: scheduleType.operating,
      },
    ];
  }
}

export default SamplePark;
