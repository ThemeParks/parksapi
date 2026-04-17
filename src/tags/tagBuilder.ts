/**
 * TagBuilder - Fluent API for creating validated entity tags
 *
 * Provides static methods for creating tags with automatic validation
 * and human-readable names.
 */

import {TagData} from '@themeparks/typelib';
import {TagType, TAG_NAMES, LocationTagValue, HeightTagValue, isSimpleTag, STANDARD_LOCATIONS, StandardLocationKey} from './tagTypes.js';
import {validateTagValue} from './validators.js';
import {simpleTag, complexTag} from './tagMetadata.js';

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
   * Location tags mark DISTINCT named sub-points of interest for an entity,
   * such as "Main Entrance", "Exit", "Single Rider Entrance", etc. They
   * are additional to the entity's primary `location` — never a duplicate
   * of it.
   *
   * **Do not use this tag to mirror `entity.location`.** The entity's
   * main coordinate belongs in `entity.location` (populated via
   * `mapEntities`' `locationFields`). A LOCATION tag with the same
   * coordinates as the main location adds nothing and should be omitted.
   * If your API only exposes one point per entity, do not emit any
   * LOCATION tag — the primary `entity.location` is sufficient.
   *
   * For standard POIs like baby care centres, first aid, smoking areas,
   * prefer the dedicated `TagBuilder.mainEntrance()`,
   * `TagBuilder.babyCareCenter()`, etc. helpers.
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
   * // Correct: distinct sub-locations beyond the primary entity.location
   * TagBuilder.location(28.4743, -81.4677, 'Main Entrance')
   * TagBuilder.location(28.4744, -81.4678, 'Single Rider Entrance')
   * TagBuilder.location(28.4745, -81.4679, 'Exit')
   *
   * // Wrong: duplicates entity.location — don't do this
   * // TagBuilder.location(ride.lat, ride.lng, ride.name)
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
  //
  // Each helper below is a one-line delegate to `standardLocation()`, which
  // reads name + id from the STANDARD_LOCATIONS table in tagTypes.ts.
  // To add a new standard location: add an entry to STANDARD_LOCATIONS, then
  // add a one-line static method below. Both the name and the id come from
  // the table — there is no duplicated data.

  /** Build a location tag using a key from STANDARD_LOCATIONS. */
  private static standardLocation(key: StandardLocationKey, latitude: number, longitude: number): TagData {
    const {id, displayName} = STANDARD_LOCATIONS[key];
    return TagBuilder.location(latitude, longitude, displayName, id);
  }

  static mainEntrance(latitude: number, longitude: number): TagData {
    return TagBuilder.standardLocation('mainEntrance', latitude, longitude);
  }

  static exit(latitude: number, longitude: number): TagData {
    return TagBuilder.standardLocation('exit', latitude, longitude);
  }

  static singleRiderEntrance(latitude: number, longitude: number): TagData {
    return TagBuilder.standardLocation('singleRiderEntrance', latitude, longitude);
  }

  static fastPassEntrance(latitude: number, longitude: number): TagData {
    return TagBuilder.standardLocation('fastPassEntrance', latitude, longitude);
  }

  static photoPickup(latitude: number, longitude: number): TagData {
    return TagBuilder.standardLocation('photoPickup', latitude, longitude);
  }

  static guestServices(latitude: number, longitude: number): TagData {
    return TagBuilder.standardLocation('guestServices', latitude, longitude);
  }

  static restrooms(latitude: number, longitude: number): TagData {
    return TagBuilder.standardLocation('restrooms', latitude, longitude);
  }

  static firstAid(latitude: number, longitude: number): TagData {
    return TagBuilder.standardLocation('firstAid', latitude, longitude);
  }

  static lostAndFound(latitude: number, longitude: number): TagData {
    return TagBuilder.standardLocation('lostAndFound', latitude, longitude);
  }

  static wheelchairAccessibleEntrance(latitude: number, longitude: number): TagData {
    return TagBuilder.standardLocation('wheelchairAccessibleEntrance', latitude, longitude);
  }

  static strollerParking(latitude: number, longitude: number): TagData {
    return TagBuilder.standardLocation('strollerParking', latitude, longitude);
  }

  static lockerArea(latitude: number, longitude: number): TagData {
    return TagBuilder.standardLocation('lockerArea', latitude, longitude);
  }

  static viewingArea(latitude: number, longitude: number): TagData {
    return TagBuilder.standardLocation('viewingArea', latitude, longitude);
  }

  static queueEntrance(latitude: number, longitude: number): TagData {
    return TagBuilder.standardLocation('queueEntrance', latitude, longitude);
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
   * Create a Minimum Height (Unaccompanied) tag
   *
   * The minimum height for a rider to ride without an accompanying adult.
   * Typically higher than the standard minimum height.
   *
   * @param height The minimum unaccompanied height value
   * @param unit The unit of measurement ('cm' or 'in')
   * @param tagName Optional custom tag name
   * @param id Optional unique identifier
   * @throws {Error} If height or unit are invalid
   */
  @complexTag(TagType.MINIMUM_HEIGHT_UNACCOMPANIED)
  static minimumHeightUnaccompanied(
    height: number,
    unit: 'cm' | 'in',
    tagName?: string,
    id?: string
  ): TagData {
    const value: HeightTagValue = {height, unit};
    return TagBuilder.createTag(TagType.MINIMUM_HEIGHT_UNACCOMPANIED, value, tagName, id);
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
