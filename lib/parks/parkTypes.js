
/**
 * Possible types of queue
 * @enum
 */
export const queueType = Object.freeze({
  // your standard "stand-by queueing"
  standBy: 'STANDBY',
  // identical to standby, but one guest at a time
  singleRider: 'SINGLE_RIDER',
  // virtual queue or "classic" paper fast-pass style system
  //  can reserve a spot for a later time
  returnTime: 'RETURN_TIME',
  // special type, "boarding group"
  //  guests reserve a slot to enter the attracion, but the time is not known
  //  "boarding groups" are called in sequence when capacity allows
  // eg. Rise of the Resistance at Disney
  boardingGroup: 'BOARDING_GROUP',
  // upcharge type, "paid return time"
  //  example: Shanghai Disneyland or Disneyland Paris
  //  guests can pay to get a faster return time
  paidReturnTime: 'PAID_RETURN_TIME',
  // upcharge type, paid standby or "express pass"
  //  guests can pay for a day pass to use an "express" or separate "fast lane" queue
  // eg. Express Pass at Universal, or Fastlane at Knott's Berry Farm
  paidStandBy: 'PAID_STANDBY',
});

/**
 * Possible types of state for a return time queue
 * @enum
 */
export const returnTimeState = Object.freeze({
  // there are places still available
  available: 'AVAILABLE',
  // more slots will be available later
  temporarilyFull: 'TEMP_FULL',
  // all slots have been reserved for the day
  finished: 'FINISHED',
});

/**
 * Possible types for boarding groups
 * @enum
 */
export const boardingGroupState = Object.freeze({
  // new boarding groups are available
  available: 'AVAILABLE',
  // boarding group allocations are not currently available, but may be later
  paused: 'PAUSED',
  // boarding groups currently not open
  closed: 'CLOSED',
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
 * Entity types
 * @enum
 */
export const entityType = Object.freeze({
  destination: 'DESTINATION',
  park: 'PARK',
  attraction: 'ATTRACTION',
  restaurant: 'RESTAURANT',
  hotel: 'HOTEL',
  show: 'SHOW',
});

/**
 * All known attraction types (ride, show, etc.)
 * @enum
 */
export const attractionType = Object.freeze({
  unknown: 'UNKNOWN',
  ride: 'RIDE',
  show: 'SHOW',
  transport: 'TRANSPORT',
  parade: 'PARADE',
  meetAndGreet: 'MEET_AND_GREET',
  // TODO - water pool areas? what do we call these?
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
  informational: 'INFO', // some non-operating hours, listed for information (eg. "You can now park hop")
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
  childSwap: 'CHILD_SWAP',
});
