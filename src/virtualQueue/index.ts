/**
 * Virtual Queue Framework
 *
 * Utilities for building and managing virtual queue systems across theme parks.
 * Provides builders and helpers for return time queues, boarding groups,
 * and paid virtual queue systems. Output is checked by `npm run audit:live`.
 *
 * @module virtualQueue
 */

export { VQueueBuilder } from './builder.js';
export {
  calculateReturnWindow,
  findNextAvailableSlot,
  parseTimeSlots,
} from './timeWindows.js';
export {
  determineReturnTimeState,
  determineBoardingGroupState,
} from './state.js';

// Re-export types from typelib for convenience
export type {
  LiveQueue,
  ReturnTimeState,
  BoardingGroupState,
  QueueType,
} from '@themeparks/typelib';
