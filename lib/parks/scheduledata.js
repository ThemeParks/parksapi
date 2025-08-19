import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {scheduleType} from './parkTypes.js';
const ajv = new Ajv({allowUnionTypes: true});
addFormats(ajv);

const scheduleSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        // validate date format YYYY-MM-DD
        format: 'date',
      },
      type: {
        type: 'string',
        // limited to ENUM types scheduleType
        enum: Object.values(scheduleType),
      },
      description: {
        type: 'string',
      },
      openingTime: {
        type: 'string',
        format: 'date-time',
      },
      closingTime: {
        type: 'string',
        format: 'date-time',
      },
    },
    required: ['date', 'type', 'openingTime', 'closingTime'],
  },
};

/**
 * Validate a schedula data object. Containing _id and a schedule array of schedules
 * @param {object} scheduleData
 * @return {array<string>} Array of errors, or null if successful
 */
export function validateEntitySchedule(scheduleData) {
  const errors = [];
  if (!scheduleData._id) {
    errors.push('scheduleData missing _id field');
  }
  if (!scheduleData.schedule) {
    errors.push('scheduleData missing schedule field');
  }
  if (errors.length > 0) return errors;

  const validator = ajv.compile(scheduleSchema);
  if (!validator(scheduleData.schedule)) {
    return validator.errors;
  }
  return null;
}
