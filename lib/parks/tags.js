// this file handles storing different tag types

import {tagType} from './parkTypes.js';

/**
 * Validate a rider height tag. Used for min/max heights
 * @param {string} key
 * @param {*} data
 * @return {boolean}
 */
const riderHeightValidate = (key, data) => {
  if (!validateObjectContainsOnlyGivenKeys(data, ['height', 'unit'])) {
    return false;
  }

  const validUnits = ['cm', 'in'];
  if (validUnits.indexOf(data.unit) < 0) {
    return false;
  }

  return !isNaN(data.height) && data.height >= 0;
};

/**
 * Simple tags that don't have a value entry.
 * Instead, these tags are either present or not.
 */
const simpleTags = {
  [tagType.fastPass]: true,
  [tagType.mayGetWet]: true,
  [tagType.unsuitableForPregnantPeople]: true,
  [tagType.onRidePhoto]: true,
  [tagType.singleRider]: true,
};

/**
 * Each tag type must have a validator function to confirm the incoming tag value is correct
 */
const validators = {
  // Location tags
  [tagType.location]: (key, data) => {
    // make sure we have our longitude and latitude keys
    if (!validateObjectContainsOnlyGivenKeys(data, ['longitude', 'latitude'])) {
      return false;
    }

    // make sure our keys are valid numbers
    if (isNaN(data.longitude) || isNaN(data.latitude)) {
      return false;
    }

    return true;
  },
  // minimum height allowed to ride
  //  must contain "height" as a number, and a "unit" which can be 'cm' (centimeters) or 'in' (inches)
  [tagType.minimumHeight]: riderHeightValidate,
  // maximum height allowed to ride
  //  must contain "height" as a number, and a "unit" which can be 'cm' (centimeters) or 'in' (inches)
  [tagType.maximumHeight]: riderHeightValidate,
};


/**
 * Given an object, validate that it only contains the given keys
 * Will return false if the object is missing any keys, or has additional keys not listed
 * @param {object} data
 * @param {array<string>} keys
 * @return {boolean}
 */
function validateObjectContainsOnlyGivenKeys(data, keys) {
  // make sure our input is an object
  if (typeof data !== 'object' || data === null) return false;

  // make sure our incoming keys is an array
  keys = [].concat(keys);

  // get the keys of our incoming object
  const dataKeys = Object.keys(data);
  // early bail if we have a different number of keys
  if (dataKeys.length !== keys.length) return false;

  // filter all our keys against our data key
  // TODO - this may get slow for large objects, look to optimise
  const matchingKeys = keys.filter((key) => {
    return dataKeys.indexOf(key) >= 0;
  });
  // if our filtered keys is still the same length, we have all the keys we want
  return (matchingKeys.length === dataKeys.length);
}

/**
 * Is the supplied tag type supported?
 * @param {tagType} type
 * @return {boolean}
 */
export function isValidTagType(type) {
  return validators[type] !== undefined || simpleTags[type] !== undefined;
}

/**
 * Is the given type a "simple tag" (one with no actual value)
 * @param {tagType} type
 * @return {boolean}
 */
export function isSimpleTagType(type) {
  return simpleTags[type] !== undefined;
}

/**
 * Validate a tag value based on its type
 * @param {string} key Tag name - some tags must have a valid name
 * @param {tagType} type The type for this tag entry
 * @param {*} value The tag data to validate matches this tag format's data structure
 * @return {boolean}
 */
export function isValidTag(key, type, value) {
  if (!isValidTagType(type)) {
    return false;
  }

  // simple tags don't need to run a validator
  if (isSimpleTagType(type)) {
    return true;
  }

  // run tag validator to confirm we are a valid tag
  const validator = validators[type];
  return (validator(key, value));
}

/**
 * Given a tag key, type, and value - parse, validate, and return the full expected tag object
 * @param {string} key Tag name - some tags must have a valid name
 * @param {tagType} type The type for this tag entry
 * @param {*} value The tag data to validate matches this tag format's data structure
 * @return {object} The tag object to use, or undefined if it isn't valid
 */
export function getValidTagObject(key, type, value) {
  if (!isValidTag(key, type, value)) {
    return undefined;
  }

  // return data structure based on tag type
  if (isSimpleTagType(type)) {
    return {
      type,
    };
  } else {
    return {
      key,
      value,
      type,
    };
  }
}
