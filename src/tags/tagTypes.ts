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
 * Standard location metadata — single source of truth.
 *
 * Each entry maps a builder method name to:
 *  - `id`: a stable identifier used in the tag (consistent across all parks)
 *  - `displayName`: the human-readable name shown to users
 *
 * Adding a new standard location: add an entry here. The corresponding
 * `TagBuilder.<key>(lat, lng)` helper is auto-generated from this table.
 *
 * Using consistent IDs makes it easy to query specific location types across
 * parks (e.g., find every entity with a `location-single-rider-entrance` tag).
 */
export const STANDARD_LOCATIONS = {
  mainEntrance:                 {id: 'location-main-entrance',                  displayName: 'Main Entrance'},
  exit:                         {id: 'location-exit',                           displayName: 'Exit'},
  singleRiderEntrance:          {id: 'location-single-rider-entrance',          displayName: 'Single Rider Entrance'},
  fastPassEntrance:             {id: 'location-fastpass-entrance',              displayName: 'Express Entrance'},
  photoPickup:                  {id: 'location-photo-pickup',                   displayName: 'Photo Pickup'},
  guestServices:                {id: 'location-guest-services',                 displayName: 'Guest Services'},
  restrooms:                    {id: 'location-restrooms',                      displayName: 'Restrooms'},
  firstAid:                     {id: 'location-first-aid',                      displayName: 'First Aid'},
  lostAndFound:                 {id: 'location-lost-and-found',                 displayName: 'Lost and Found'},
  wheelchairAccessibleEntrance: {id: 'location-wheelchair-accessible-entrance', displayName: 'Wheelchair Accessible Entrance'},
  strollerParking:              {id: 'location-stroller-parking',               displayName: 'Stroller Parking'},
  lockerArea:                   {id: 'location-locker-area',                    displayName: 'Locker Area'},
  viewingArea:                  {id: 'location-viewing-area',                   displayName: 'Viewing Area'},
  queueEntrance:                {id: 'location-queue-entrance',                 displayName: 'Queue Entrance'},
} as const satisfies Record<string, {id: string; displayName: string}>;

/** All keys of STANDARD_LOCATIONS — used as the parameter type for TagBuilder helpers. */
export type StandardLocationKey = keyof typeof STANDARD_LOCATIONS;

/**
 * Convenience constant exposing all standard location IDs by camelCase key
 * (e.g. `StandardLocationId.mainEntrance` → `'location-main-entrance'`).
 * Useful when filtering entities by location type in client code.
 */
export const StandardLocationId = Object.fromEntries(
  Object.entries(STANDARD_LOCATIONS).map(([key, val]) => [key, val.id])
) as {readonly [K in StandardLocationKey]: typeof STANDARD_LOCATIONS[K]['id']};
