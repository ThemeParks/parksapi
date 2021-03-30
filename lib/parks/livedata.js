import Ajv from 'ajv';
const ajv = new Ajv();

import {entityType, queueType, returnTimeState} from './parkTypes.js';

// queue schema, can be applied to various entity types
const queueSchema = {
  type: 'object',
  properties: {
    [queueType.standBy]: {
      type: 'object',
      properties: {
        waitTime: {
          type: 'integer',
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
          type: 'integer',
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

// configure entity schemas here
const entitySchemas = {
  [entityType.attraction]: {
    type: 'object',
    properties: {
      // attractions can have a queue live data object
      queue: queueSchema,
    },
  },
  [entityType.show]: {
    type: 'object',
    properties: {
      // shows can have a queue live data object
      queue: queueSchema,
      // TODO - live show times for the current operating day
    },
  },
  [entityType.restaurant]: {
    type: 'object',
    properties: {
      // restaurants can have a queue live data object
      queue: queueSchema,
      // TODO - reservation availability
      // TODO - availability by party size
    },
  },
};

/**
 * Fetch the validator function for a given entity type
 * @param {entityType} entityType
 * @return {function}
 */
function getSchema(entityType) {
  // check if we have a source schema...
  if (!entitySchemas[entityType]) {
    // if not, return undefined
    return undefined;
  }

  // ... otherwise, compile our schema
  return ajv.compile(entitySchemas[entityType]);
}

/**
 * Given an entity doc, and a live data object - validate the live data
 * @param {object} entity
 * @param {object} liveData
 * @return {Array<string>} Array of errors, of null if passes validation
 */
export function getLiveDataErrors(entity, liveData) {
  const entityType = entity.entityType;

  // get our validator function
  const validator = getSchema(entityType);
  if (!validator) {
    return ['Missing schema for entity type'];
  }

  // run validator
  //  results available validator.errors
  if (!validator(liveData)) {
    return validator.errors;
  }
  return null;
}
