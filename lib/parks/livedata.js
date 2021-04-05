import Ajv from 'ajv';
const ajv = new Ajv();

import {entityType, queueType, returnTimeState, statusType} from './parkTypes.js';

// queue schema, can be applied to various entity types
const queueSchema = {
  type: 'object',
  properties: {
    [queueType.standBy]: {
      type: 'object',
      properties: {
        waitTime: {
          type: ['integer', 'null'],
          minimum: 0,
        },
      },
      required: ['waitTime'],
    },
    // single rider is pretty much identical to standby
    [queueType.singleRider]: {
      type: 'object',
      properties: {
        waitTime: {
          type: ['integer', 'null'],
          minimum: 0,
        },
      },
      required: ['waitTime'],
    },
    [queueType.returnTime]: {
      type: 'object',
      properties: {
        returnStart: {
          // TODO - replace with regexed time? timestamp?
          type: 'string',
        },
        returnEnd: {
          type: 'string',
        },
        state: {
          type: 'string',
          enum: Object.values(returnTimeState),
        },
      },
      required: ['returnStart', 'returnEnd', 'state'],
    },
  },
};

// showtimes schema, an array of show start times
const showtimesSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      startTime: {
        type: ['string', 'null'],
        format: 'date-time',
      },
      endTime: {
        type: ['string', 'null'],
        format: 'date-time',
      },
      // freeform text to describe this schedule entry
      type: {
        type: 'string',
      },
    },
    required: ['startTime'],
  },
};

const statusSchema = {
  type: 'string',
  enum: Object.values(statusType),
};

// if any of these keys are present in livedata, we must run the schema validation against it
const schemas = {
  status: statusSchema,
  showtimes: showtimesSchema,
  queue: queueSchema,
};

/**
 * Given an entity doc, and a live data object - validate the live data
 * @param {object} liveData
 * @return {Array<string>} Array of errors, of null if passes validation
 */
export function getLiveDataErrors(liveData) {
  if (liveData === undefined) return null;

  // find all keys that need validating
  const keys = Object.keys(schemas).filter((key) => {
    return !!liveData[key];
  });

  const errors = [];

  // test each schema-driven key and build an array of any errors
  keys.forEach((key) => {
    const validator = ajv.compile(schemas[key]);
    if (!validator(liveData[key])) {
      errors.push(...validator.errors);
    }
  });

  if (errors.length > 0) {
    return errors;
  }
  return null;
}
