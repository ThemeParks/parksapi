/**
 * State Determination Logic
 *
 * Utilities for determining virtual queue states from API responses.
 * Encapsulates common business logic for state determination.
 */

import type { ReturnTimeState, BoardingGroupState } from '@themeparks/typelib';

/**
 * Conditions for determining return time state
 */
export interface ReturnTimeConditions {
  /** Whether the system has any slots available today */
  hasSlots: boolean;
  /** Whether slots are available right now (not just later) */
  slotsAvailableNow: boolean;
  /** Whether more slots will become available later */
  moreSlotsLater: boolean;
  /** Whether the ride is currently open */
  isRideOpen: boolean;
}

/**
 * Determine return time queue state based on conditions
 *
 * Business logic:
 * - FINISHED: No slots available today OR ride is closed
 * - TEMP_FULL: Slots exist but not available now, more coming later
 * - AVAILABLE: Slots available right now
 *
 * @example
 * ```typescript
 * const state = determineReturnTimeState({
 *   hasSlots: true,
 *   slotsAvailableNow: false,
 *   moreSlotsLater: true,
 *   isRideOpen: true
 * });
 * // Returns: 'TEMP_FULL'
 * ```
 */
export function determineReturnTimeState(
  conditions: ReturnTimeConditions
): ReturnTimeState {
  // Ride closed or no slots today = FINISHED
  if (!conditions.isRideOpen || !conditions.hasSlots) {
    return 'FINISHED';
  }

  // Slots available right now = AVAILABLE
  if (conditions.slotsAvailableNow) {
    return 'AVAILABLE';
  }

  // Slots exist but not now, more coming = TEMP_FULL
  if (conditions.moreSlotsLater) {
    return 'TEMP_FULL';
  }

  // No slots now, no more coming = FINISHED
  return 'FINISHED';
}

/**
 * Conditions for determining boarding group state
 */
export interface BoardingGroupConditions {
  /** Whether the boarding group system is active */
  isSystemActive: boolean;
  /** Whether allocation is temporarily paused */
  isPaused: boolean;
  /** Whether there's a next allocation time scheduled */
  hasNextAllocationTime: boolean;
  /** Whether the ride is currently open */
  isRideOpen: boolean;
}

/**
 * Determine boarding group queue state based on conditions
 *
 * Business logic:
 * - CLOSED: System inactive, ride closed, or paused with no resume time
 * - PAUSED: Temporarily paused but will resume (has next allocation time)
 * - AVAILABLE: System active and accepting groups
 *
 * @example
 * ```typescript
 * const state = determineBoardingGroupState({
 *   isSystemActive: true,
 *   isPaused: true,
 *   hasNextAllocationTime: true,
 *   isRideOpen: true
 * });
 * // Returns: 'PAUSED'
 * ```
 */
export function determineBoardingGroupState(
  conditions: BoardingGroupConditions
): BoardingGroupState {
  // System inactive or ride closed = CLOSED
  if (!conditions.isSystemActive || !conditions.isRideOpen) {
    return 'CLOSED';
  }

  // Paused with next allocation time = PAUSED
  if (conditions.isPaused && conditions.hasNextAllocationTime) {
    return 'PAUSED';
  }

  // Paused without next allocation time = CLOSED
  if (conditions.isPaused) {
    return 'CLOSED';
  }

  // Active and not paused = AVAILABLE
  return 'AVAILABLE';
}
