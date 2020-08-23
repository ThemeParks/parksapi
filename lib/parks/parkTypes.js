
/**
 * Possible types of queue
 * @enum
 */
export const queueType = Object.freeze({
  standBy: 'STANDBY',
  singleRider: 'SINGLE_RIDER',
  virtual: 'VIRTUAL',
  fastPass: 'FAST_PASS',
});

/**
 * Status an attraction can be in (Operating, Down, etc.)
 * @enum
 */
export const statusType = Object.freeze({
  operating: 'OPERATING',
  down: 'DOWN',
  closed: 'CLOSED',
  refurbishment: 'REFURBISHMENT',
});

/**
 * All known attraction types (ride, show, etc.)
 * @enum
 */
export const attractionType = Object.freeze({
  ride: 'RIDE',
  show: 'SHOW',
  transport: 'TRANSPORT',
  parade: 'PARADE',
  meetAndGreet: 'MEET_AND_GREET',
  other: 'OTHER',
});

/**
 * All possible schedule types
 * @enum
 */
export const scheduleType = Object.freeze({
  operating: 'OPERATING', // normal park operating hours
  ticketed: 'TICKETED_EVENT', // ticketed event. Halloween Horror nights etc.
  private: 'PRIVATE_EVENT',
  extraHours: 'EXTRA_HOURS', // "extra magic hours", "early park admission", etc.
});

/**
 * All possible Tag types for attractions
 * @enum
 */
export const tagType = Object.freeze({
  location: 'LOCATION',
  fastPass: 'FASTPASS',
  mayGetWet: 'MAY_GET_WET',
  unsuitableForPregnantPeople: 'UNSUITABLE_PREGNANT',
  minimumHeight: 'MINIMUM_HEIGHT',
  maximumHeight: 'MAXIMUM_HEIGHT',
  onRidePhoto: 'ONRIDE_PHOTO',
  singleRider: 'SINGLE_RIDER',
});
