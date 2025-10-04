/**
 * Tag validation functions
 *
 * Each complex tag type has a validator to ensure the value
 * structure is correct before creating the tag.
 */

import {TagType, LocationTagValue, HeightTagValue, isSimpleTag} from './tagTypes.js';

/**
 * Type guard for LocationTagValue
 */
export function isLocationValue(value: any): value is LocationTagValue {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const keys = Object.keys(value);
  if (keys.length !== 2) {
    return false;
  }

  if (!keys.includes('latitude') || !keys.includes('longitude')) {
    return false;
  }

  const {latitude, longitude} = value;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return false;
  }

  if (isNaN(latitude) || isNaN(longitude)) {
    return false;
  }

  return true;
}

/**
 * Type guard for HeightTagValue
 */
export function isHeightValue(value: any): value is HeightTagValue {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const keys = Object.keys(value);
  if (keys.length !== 2) {
    return false;
  }

  if (!keys.includes('height') || !keys.includes('unit')) {
    return false;
  }

  const {height, unit} = value;
  if (typeof height !== 'number' || isNaN(height) || height < 0) {
    return false;
  }

  if (unit !== 'cm' && unit !== 'in') {
    return false;
  }

  return true;
}

/**
 * Validate a tag value based on its type
 *
 * @param type The tag type
 * @param value The value to validate
 * @throws {Error} If the value is invalid for the given tag type
 */
export function validateTagValue(type: TagType, value: any): void {
  // Simple tags don't need value validation
  if (isSimpleTag(type)) {
    return;
  }

  // Complex tags must have a value
  if (value === undefined || value === null) {
    throw new Error(`Tag type ${type} requires a value`);
  }

  // Type-specific validation
  switch (type) {
    case TagType.LOCATION:
      if (!isLocationValue(value)) {
        throw new Error(
          `Invalid location tag value. Expected {latitude: number, longitude: number}, got: ${JSON.stringify(value)}`
        );
      }
      break;

    case TagType.MINIMUM_HEIGHT:
    case TagType.MAXIMUM_HEIGHT:
      if (!isHeightValue(value)) {
        throw new Error(
          `Invalid height tag value. Expected {height: number, unit: 'cm' | 'in'}, got: ${JSON.stringify(value)}`
        );
      }
      break;

    default:
      // Should never reach here if we've defined all tag types
      throw new Error(`Unknown tag type: ${type}`);
  }
}

/**
 * Helper function to validate that an object contains only the specified keys
 *
 * @param obj The object to validate
 * @param keys The expected keys
 * @returns True if the object contains exactly the specified keys
 */
export function hasOnlyKeys(obj: any, keys: string[]): boolean {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }

  const objKeys = Object.keys(obj);
  if (objKeys.length !== keys.length) {
    return false;
  }

  return keys.every(key => objKeys.includes(key));
}
