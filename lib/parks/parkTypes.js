
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
});
