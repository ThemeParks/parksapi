/**
 * TagBuilder - Fluent API for creating validated entity tags
 *
 * Provides static methods for creating tags with automatic validation
 * and human-readable names.
 */

import {TagData} from '@themeparks/typelib';
import {TagType, TAG_NAMES, LocationTagValue, HeightTagValue, isSimpleTag, StandardLocationId} from './tagTypes.js';
import {validateTagValue} from './validators.js';
import {simpleTag, complexTag, locationHelper} from './tagMetadata.js';

/**
 * TagBuilder provides a fluent API for creating validated entity tags
 *
 * @example
 * ```typescript
 * const tags = [
 *   TagBuilder.fastPass(),
 *   TagBuilder.minimumHeight(107, 'cm'),
 *   TagBuilder.location(28.4743, -81.4677),
 * ];
 * ```
 */
export class TagBuilder {
  /**
   * Create a tag with the given type and value
   *
   * @param type The tag type
   * @param value The tag value (for complex tags)
   * @param tagName Optional custom tag name (defaults to human-readable name)
   * @param id Optional unique identifier for the tag
   * @returns A validated TagData object
   * @throws {Error} If the tag value is invalid
   */
  private static createTag(
    type: TagType,
    value?: any,
    tagName?: string,
    id?: string
  ): TagData {
    // Validate the tag value
    validateTagValue(type, value);

    // Use provided tagName or default to human-readable name
    const name = tagName ?? TAG_NAMES[type];

    // Simple tags don't have a value property
    if (isSimpleTag(type)) {
      return {
        tag: type,
        tagName: name,
        ...(id && {id}),
      };
    }

    // Complex tags include the value
    return {
      tag: type,
      tagName: name,
      value,
      ...(id && {id}),
    };
  }

  // ==================== Simple Tags ====================

  /**
   * Create a Paid Return Time tag (Express Pass, Lightning Lane, etc.)
   */
  @simpleTag(TagType.PAID_RETURN_TIME)
  static paidReturnTime(tagName?: string, id?: string): TagData {
    return TagBuilder.createTag(TagType.PAID_RETURN_TIME, undefined, tagName, id);
  }

  /**
   * Create a May Get Wet tag
   */
  @simpleTag(TagType.MAY_GET_WET)
  static mayGetWet(tagName?: string, id?: string): TagData {
    return TagBuilder.createTag(TagType.MAY_GET_WET, undefined, tagName, id);
  }

  /**
   * Create an Unsuitable for Pregnant People tag
   */
  @simpleTag(TagType.UNSUITABLE_PREGNANT)
  static unsuitableForPregnantPeople(tagName?: string, id?: string): TagData {
    return TagBuilder.createTag(TagType.UNSUITABLE_PREGNANT, undefined, tagName, id);
  }

  /**
   * Create an On-Ride Photo tag
   */
  @simpleTag(TagType.ONRIDE_PHOTO)
  static onRidePhoto(tagName?: string, id?: string): TagData {
    return TagBuilder.createTag(TagType.ONRIDE_PHOTO, undefined, tagName, id);
  }

  /**
   * Create a Single Rider tag
   */
  @simpleTag(TagType.SINGLE_RIDER)
  static singleRider(tagName?: string, id?: string): TagData {
    return TagBuilder.createTag(TagType.SINGLE_RIDER, undefined, tagName, id);
  }

  /**
   * Create a Child Swap tag
   */
  @simpleTag(TagType.CHILD_SWAP)
  static childSwap(tagName?: string, id?: string): TagData {
    return TagBuilder.createTag(TagType.CHILD_SWAP, undefined, tagName, id);
  }

  // ==================== Complex Tags ====================

  /**
   * Create a Location tag
   *
   * Location tags represent specific points of interest for an entity,
   * such as "Main Entrance", "Exit", "Single Rider Entrance", etc.
   *
   * @param latitude Latitude coordinate
   * @param longitude Longitude coordinate
   * @param tagName Human-readable name for this location (required) - e.g., "Main Entrance", "Exit", "Single Rider Queue"
   * @param id Optional unique identifier
   * @throws {Error} If latitude or longitude are invalid
   * @throws {Error} If tagName is not provided
   *
   * @example
   * ```typescript
   * TagBuilder.location(28.4743, -81.4677, 'Main Entrance')
   * TagBuilder.location(28.4744, -81.4678, 'Single Rider Entrance')
   * TagBuilder.location(28.4745, -81.4679, 'Exit')
   * ```
   */
  @complexTag(TagType.LOCATION)
  static location(
    latitude: number,
    longitude: number,
    tagName: string,
    id?: string
  ): TagData {
    if (!tagName || tagName.trim() === '') {
      throw new Error('Location tag requires a human-readable name (e.g., "Main Entrance", "Exit", "Single Rider Queue")');
    }
    const value: LocationTagValue = {latitude, longitude};
    return TagBuilder.createTag(TagType.LOCATION, value, tagName, id);
  }

  // ==================== Standard Location Helpers ====================

  /**
   * Create a Main Entrance location tag with standard ID
   *
   * @param latitude Latitude coordinate
   * @param longitude Longitude coordinate
   */
  @locationHelper(StandardLocationId.MAIN_ENTRANCE)
  static mainEntrance(latitude: number, longitude: number): TagData {
    return TagBuilder.location(latitude, longitude, 'Main Entrance', StandardLocationId.MAIN_ENTRANCE);
  }

  /**
   * Create an Exit location tag with standard ID
   *
   * @param latitude Latitude coordinate
   * @param longitude Longitude coordinate
   */
  @locationHelper(StandardLocationId.EXIT)
  static exitLocation(latitude: number, longitude: number): TagData {
    return TagBuilder.location(latitude, longitude, 'Exit', StandardLocationId.EXIT);
  }

  /**
   * Create a Single Rider Entrance location tag with standard ID
   *
   * @param latitude Latitude coordinate
   * @param longitude Longitude coordinate
   */
  @locationHelper(StandardLocationId.SINGLE_RIDER_ENTRANCE)
  static singleRiderEntrance(latitude: number, longitude: number): TagData {
    return TagBuilder.location(latitude, longitude, 'Single Rider Entrance', StandardLocationId.SINGLE_RIDER_ENTRANCE);
  }

  /**
   * Create a Fast Pass/Express Entrance location tag with standard ID
   *
   * @param latitude Latitude coordinate
   * @param longitude Longitude coordinate
   */
  @locationHelper(StandardLocationId.FASTPASS_ENTRANCE)
  static fastPassEntrance(latitude: number, longitude: number): TagData {
    return TagBuilder.location(latitude, longitude, 'Express Entrance', StandardLocationId.FASTPASS_ENTRANCE);
  }

  /**
   * Create a Photo Pickup location tag with standard ID
   *
   * @param latitude Latitude coordinate
   * @param longitude Longitude coordinate
   */
  @locationHelper(StandardLocationId.PHOTO_PICKUP)
  static photoPickup(latitude: number, longitude: number): TagData {
    return TagBuilder.location(latitude, longitude, 'Photo Pickup', StandardLocationId.PHOTO_PICKUP);
  }

  /**
   * Create a Wheelchair Accessible Entrance location tag with standard ID
   *
   * @param latitude Latitude coordinate
   * @param longitude Longitude coordinate
   */
  @locationHelper(StandardLocationId.WHEELCHAIR_ACCESSIBLE_ENTRANCE)
  static wheelchairAccessibleEntrance(latitude: number, longitude: number): TagData {
    return TagBuilder.location(latitude, longitude, 'Wheelchair Accessible Entrance', StandardLocationId.WHEELCHAIR_ACCESSIBLE_ENTRANCE);
  }

  // ==================== Height Tags ====================

  /**
   * Create a Minimum Height tag
   *
   * @param height The minimum height value
   * @param unit The unit of measurement ('cm' or 'in')
   * @param tagName Optional custom tag name
   * @param id Optional unique identifier
   * @throws {Error} If height or unit are invalid
   */
  @complexTag(TagType.MINIMUM_HEIGHT)
  static minimumHeight(
    height: number,
    unit: 'cm' | 'in',
    tagName?: string,
    id?: string
  ): TagData {
    const value: HeightTagValue = {height, unit};
    return TagBuilder.createTag(TagType.MINIMUM_HEIGHT, value, tagName, id);
  }

  /**
   * Create a Maximum Height tag
   *
   * @param height The maximum height value
   * @param unit The unit of measurement ('cm' or 'in')
   * @param tagName Optional custom tag name
   * @param id Optional unique identifier
   * @throws {Error} If height or unit are invalid
   */
  @complexTag(TagType.MAXIMUM_HEIGHT)
  static maximumHeight(
    height: number,
    unit: 'cm' | 'in',
    tagName?: string,
    id?: string
  ): TagData {
    const value: HeightTagValue = {height, unit};
    return TagBuilder.createTag(TagType.MAXIMUM_HEIGHT, value, tagName, id);
  }

  // ==================== Validation Helpers ====================

  /**
   * Validate a single tag
   *
   * @param tag The tag to validate
   * @returns True if the tag is valid
   * @throws {Error} If the tag is invalid
   */
  static validate(tag: TagData): boolean {
    if (!tag.tag) {
      throw new Error('Tag must have a "tag" property');
    }

    if (!tag.tagName) {
      throw new Error('Tag must have a "tagName" property');
    }

    const tagType = tag.tag as TagType;
    validateTagValue(tagType, tag.value);

    return true;
  }

  /**
   * Validate an array of tags
   *
   * @param tags The tags to validate
   * @returns True if all tags are valid
   * @throws {Error} If any tag is invalid
   */
  static validateAll(tags: TagData[]): boolean {
    tags.forEach((tag, index) => {
      try {
        TagBuilder.validate(tag);
      } catch (error: any) {
        throw new Error(`Tag at index ${index} is invalid: ${error.message}`);
      }
    });

    return true;
  }
}
