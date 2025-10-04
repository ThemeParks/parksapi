/**
 * Metadata system for tag builders using decorators
 *
 * This eliminates boilerplate by auto-registering tag methods
 * for completeness validation.
 */

import {TagType, StandardLocationId} from './tagTypes.js';

// Registry of tag builder methods
const simpleTagRegistry = new Map<TagType, string>();
const complexTagRegistry = new Map<TagType, string>();
const locationHelperRegistry = new Map<StandardLocationId, string>();

/**
 * Decorator for simple tag builder methods
 *
 * Automatically registers the method for validation
 *
 * @example
 * ```typescript
 * @simpleTag(TagType.FASTPASS)
 * static fastPass(tagName?: string, id?: string): TagData {
 *   return TagBuilder.createTag(TagType.FASTPASS, undefined, tagName, id);
 * }
 * ```
 */
export function simpleTag(tagType: TagType) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    simpleTagRegistry.set(tagType, propertyKey);
    return descriptor;
  };
}

/**
 * Decorator for complex tag builder methods
 *
 * Automatically registers the method for validation
 *
 * @example
 * ```typescript
 * @complexTag(TagType.MINIMUM_HEIGHT)
 * static minimumHeight(height: number, unit: 'cm' | 'in', tagName?: string, id?: string): TagData {
 *   const value: HeightTagValue = {height, unit};
 *   return TagBuilder.createTag(TagType.MINIMUM_HEIGHT, value, tagName, id);
 * }
 * ```
 */
export function complexTag(tagType: TagType) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    complexTagRegistry.set(tagType, propertyKey);
    return descriptor;
  };
}

/**
 * Decorator for standard location helper methods
 *
 * Automatically registers the method for validation
 *
 * @example
 * ```typescript
 * @locationHelper(StandardLocationId.MAIN_ENTRANCE)
 * static mainEntrance(latitude: number, longitude: number): TagData {
 *   return TagBuilder.location(latitude, longitude, 'Main Entrance', StandardLocationId.MAIN_ENTRANCE);
 * }
 * ```
 */
export function locationHelper(locationId: StandardLocationId) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    locationHelperRegistry.set(locationId, propertyKey);
    return descriptor;
  };
}

/**
 * Get all registered simple tag methods
 */
export function getSimpleTagRegistry(): ReadonlyMap<TagType, string> {
  return simpleTagRegistry;
}

/**
 * Get all registered complex tag methods
 */
export function getComplexTagRegistry(): ReadonlyMap<TagType, string> {
  return complexTagRegistry;
}

/**
 * Get all registered location helper methods
 */
export function getLocationHelperRegistry(): ReadonlyMap<StandardLocationId, string> {
  return locationHelperRegistry;
}
