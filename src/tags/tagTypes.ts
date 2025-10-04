/**
 * Tag types and interfaces for entity tags
 *
 * Tags provide additional metadata about entities (attractions, shows, etc.)
 * such as height restrictions, location coordinates, and accessibility features.
 */

/**
 * All possible tag types in the system
 */
export enum TagType {
  LOCATION = 'LOCATION',
  PAID_RETURN_TIME = 'PAID_RETURN_TIME',
  MAY_GET_WET = 'MAY_GET_WET',
  UNSUITABLE_PREGNANT = 'UNSUITABLE_PREGNANT',
  MINIMUM_HEIGHT = 'MINIMUM_HEIGHT',
  MAXIMUM_HEIGHT = 'MAXIMUM_HEIGHT',
  ONRIDE_PHOTO = 'ONRIDE_PHOTO',
  SINGLE_RIDER = 'SINGLE_RIDER',
  CHILD_SWAP = 'CHILD_SWAP',
}

/**
 * Internal registry for tag metadata
 */
const tagRegistry = {
  names: {} as Record<TagType, string>,
  simpleTypes: new Set<TagType>(),
};

/**
 * Register a simple tag (boolean presence, no value)
 */
function registerSimple(type: TagType, name: string): void {
  tagRegistry.names[type] = name;
  tagRegistry.simpleTypes.add(type);
}

/**
 * Register a complex tag (has associated value/data)
 */
function registerComplex(type: TagType, name: string): void {
  tagRegistry.names[type] = name;
}

// Register all tag types
registerComplex(TagType.LOCATION, 'Location');
registerSimple(TagType.PAID_RETURN_TIME, 'Paid Return Time');
registerSimple(TagType.MAY_GET_WET, 'May Get Wet');
registerSimple(TagType.UNSUITABLE_PREGNANT, 'Unsuitable for Pregnant People');
registerComplex(TagType.MINIMUM_HEIGHT, 'Minimum Height');
registerComplex(TagType.MAXIMUM_HEIGHT, 'Maximum Height');
registerSimple(TagType.ONRIDE_PHOTO, 'On-Ride Photo');
registerSimple(TagType.SINGLE_RIDER, 'Single Rider');
registerSimple(TagType.CHILD_SWAP, 'Child Swap');

/**
 * Human-readable names for each tag type
 */
export const TAG_NAMES: Record<TagType, string> = tagRegistry.names;

/**
 * Location tag value structure
 */
export interface LocationTagValue {
  latitude: number;
  longitude: number;
}

/**
 * Height restriction tag value structure
 */
export interface HeightTagValue {
  height: number;
  unit: 'cm' | 'in';
}

/**
 * Simple tags that don't have a value (presence = true)
 */
export const SIMPLE_TAG_TYPES = tagRegistry.simpleTypes;

/**
 * Check if a tag type is a simple tag (boolean presence)
 */
export function isSimpleTag(type: TagType): boolean {
  return SIMPLE_TAG_TYPES.has(type);
}

/**
 * Check if a tag type is valid
 */
export function isValidTagType(type: string): type is TagType {
  return Object.values(TagType).includes(type as TagType);
}

/**
 * Standard location IDs for consistency across all destinations
 *
 * Using these IDs makes it easy to query specific location types
 * across all parks (e.g., find all single rider entrances)
 */
export enum StandardLocationId {
  MAIN_ENTRANCE = 'location-main-entrance',
  EXIT = 'location-exit',
  SINGLE_RIDER_ENTRANCE = 'location-single-rider-entrance',
  FASTPASS_ENTRANCE = 'location-fastpass-entrance',
  PHOTO_PICKUP = 'location-photo-pickup',
  GUEST_SERVICES = 'location-guest-services',
  RESTROOMS = 'location-restrooms',
  FIRST_AID = 'location-first-aid',
  LOST_AND_FOUND = 'location-lost-and-found',
  WHEELCHAIR_ACCESSIBLE_ENTRANCE = 'location-wheelchair-accessible-entrance',
  STROLLER_PARKING = 'location-stroller-parking',
  LOCKER_AREA = 'location-locker-area',
  VIEWING_AREA = 'location-viewing-area',
  QUEUE_ENTRANCE = 'location-queue-entrance',
}
