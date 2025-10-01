/**
 * Additional park-related types not provided by @themeparks/typelib
 *
 * Most types are re-exported from @themeparks/typelib
 */

// Re-export all types from typelib
export * from '@themeparks/typelib';

/**
 * AttractionType enum - NOT in typelib, park-specific classification
 */
export enum AttractionType {
  UNKNOWN = 'UNKNOWN',
  RIDE = 'RIDE',
  SHOW = 'SHOW',
  TRANSPORT = 'TRANSPORT',
  PARADE = 'PARADE',
  MEET_AND_GREET = 'MEET_AND_GREET',
  OTHER = 'OTHER',
}

/**
 * Queue type enum - for internal use when mapping to LiveQueue
 */
export enum QueueType {
  STANDBY = 'STANDBY',
  SINGLE_RIDER = 'SINGLE_RIDER',
  RETURN_TIME = 'RETURN_TIME',
  BOARDING_GROUP = 'BOARDING_GROUP',
  PAID_RETURN_TIME = 'PAID_RETURN_TIME',
  PAID_STANDBY = 'PAID_STANDBY',
}
