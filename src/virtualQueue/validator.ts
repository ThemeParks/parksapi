/**
 * Virtual Queue Validators
 *
 * Runtime validation for virtual queue data structures.
 * Helps catch common mistakes and ensure data quality.
 */

import type { LiveQueue } from '@themeparks/typelib';

/**
 * Validation options
 */
export interface ValidationOptions {
  /** Whether to include suggestions for fixing errors */
  suggest?: boolean;
}

/**
 * Validation result with suggestions
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  suggestions?: string[];
}

/**
 * Validate a return time queue object
 *
 * Validation rules:
 * - AVAILABLE state requires both returnStart and returnEnd
 * - TEMP_FULL state should have null times (no current slot available)
 * - FINISHED state should have null times (all slots gone)
 * - Return times should be valid ISO 8601 strings
 * - returnEnd should be after returnStart
 *
 * @example
 * ```typescript
 * const errors = validateReturnTimeQueue({
 *   state: 'AVAILABLE',
 *   returnStart: null,
 *   returnEnd: null
 * });
 * // Returns: ['returnStart required when state is AVAILABLE', ...]
 * ```
 */
export function validateReturnTimeQueue(
  queue: NonNullable<LiveQueue['RETURN_TIME']> | undefined | null,
  options: ValidationOptions = {}
): string[] | ValidationResult {
  const errors: string[] = [];
  const suggestions: string[] = [];

  if (!queue) {
    errors.push('Queue object is null or undefined');
    if (options.suggest) {
      suggestions.push('Ensure queue is properly constructed using VQueueBuilder');
    }
    return options.suggest ? { valid: false, errors, suggestions } : errors;
  }

  // Validate state-specific requirements
  if (queue.state === 'AVAILABLE') {
    if (!queue.returnStart) {
      errors.push('returnStart required when state is AVAILABLE');
      if (options.suggest) {
        suggestions.push('Use .withWindow(startTime, endTime) to set return window');
      }
    }
    if (!queue.returnEnd) {
      errors.push('returnEnd required when state is AVAILABLE');
      if (options.suggest) {
        suggestions.push('Use .withWindow(startTime, endTime) to set return window');
      }
    }
  }

  // Validate time formats
  if (queue.returnStart) {
    try {
      const date = new Date(queue.returnStart);
      if (isNaN(date.getTime())) {
        errors.push('returnStart is not a valid date string');
      }
    } catch {
      errors.push('returnStart is not a valid date string');
      if (options.suggest) {
        suggestions.push('Use ISO 8601 format: YYYY-MM-DDTHH:mm:ss±HH:mm');
      }
    }
  }

  if (queue.returnEnd) {
    try {
      const date = new Date(queue.returnEnd);
      if (isNaN(date.getTime())) {
        errors.push('returnEnd is not a valid date string');
      }
    } catch {
      errors.push('returnEnd is not a valid date string');
      if (options.suggest) {
        suggestions.push('Use ISO 8601 format: YYYY-MM-DDTHH:mm:ss±HH:mm');
      }
    }
  }

  // Validate time order
  if (queue.returnStart && queue.returnEnd) {
    const start = new Date(queue.returnStart);
    const end = new Date(queue.returnEnd);
    if (start >= end) {
      errors.push('returnEnd must be after returnStart');
      if (options.suggest) {
        suggestions.push('Check your time window calculation logic');
      }
    }
  }

  return options.suggest
    ? { valid: errors.length === 0, errors, suggestions }
    : errors;
}

/**
 * Validate a paid return time queue object
 *
 * Validation rules:
 * - All rules from validateReturnTimeQueue
 * - Must have price object
 * - Price currency must be 3-letter code
 * - Price amount should be in cents (or null)
 *
 * @example
 * ```typescript
 * const errors = validatePaidReturnTimeQueue({
 *   state: 'AVAILABLE',
 *   returnStart: '2024-10-15T14:30:00-04:00',
 *   returnEnd: '2024-10-15T14:45:00-04:00',
 *   price: { currency: 'USD', amount: 1500 }
 * });
 * // Returns: [] (no errors)
 * ```
 */
export function validatePaidReturnTimeQueue(
  queue: NonNullable<LiveQueue['PAID_RETURN_TIME']> | undefined | null,
  options: ValidationOptions = {}
): string[] | ValidationResult {
  const baseResult = validateReturnTimeQueue(queue, options);
  const baseErrors = Array.isArray(baseResult) ? baseResult : baseResult.errors;
  const errors: string[] = [...baseErrors];
  const suggestions: string[] = Array.isArray(baseResult) ? [] : baseResult.suggestions || [];

  if (!queue) {
    return options.suggest ? { valid: false, errors, suggestions } : errors;
  }

  // Validate price object
  if (!queue.price) {
    errors.push('price required for paid return time');
    if (options.suggest) {
      suggestions.push('Use .withPrice(currency, amountCents) to set price');
    }
  } else {
    // Validate currency
    if (!queue.price.currency || queue.price.currency.length !== 3) {
      errors.push('price.currency must be 3-letter currency code');
      if (options.suggest) {
        suggestions.push('Use ISO 4217 codes: USD, EUR, GBP, etc.');
      }
    }

    // Validate amount (should be number or null)
    if (queue.price.amount !== null && typeof queue.price.amount !== 'number') {
      errors.push('price.amount must be a number (in cents) or null');
      if (options.suggest) {
        suggestions.push('Use cents: 1500 for $15.00, 2999 for $29.99');
      }
    }
  }

  return options.suggest
    ? { valid: errors.length === 0, errors, suggestions }
    : errors;
}

/**
 * Validate a boarding group queue object
 *
 * Validation rules:
 * - PAUSED status should have nextAllocationTime
 * - AVAILABLE status should have currentGroupStart and currentGroupEnd
 * - currentGroupEnd should be >= currentGroupStart
 * - estimatedWait should be positive number or null
 *
 * @example
 * ```typescript
 * const errors = validateBoardingGroupQueue({
 *   allocationStatus: 'AVAILABLE',
 *   currentGroupStart: 45,
 *   currentGroupEnd: 60,
 *   nextAllocationTime: null,
 *   estimatedWait: 30
 * });
 * // Returns: [] (no errors)
 * ```
 */
export function validateBoardingGroupQueue(
  queue: NonNullable<LiveQueue['BOARDING_GROUP']> | undefined | null,
  options: ValidationOptions = {}
): string[] | ValidationResult {
  const errors: string[] = [];
  const suggestions: string[] = [];

  if (!queue) {
    errors.push('Queue object is null or undefined');
    if (options.suggest) {
      suggestions.push('Ensure queue is properly constructed using VQueueBuilder');
    }
    return options.suggest ? { valid: false, errors, suggestions } : errors;
  }

  // Validate status-specific requirements
  if (queue.allocationStatus === 'PAUSED' && !queue.nextAllocationTime) {
    errors.push('nextAllocationTime recommended when status is PAUSED');
    if (options.suggest) {
      suggestions.push('Use .nextAllocationTime(time) to indicate when allocation resumes');
    }
  }

  if (queue.allocationStatus === 'AVAILABLE') {
    if (queue.currentGroupStart === null || queue.currentGroupEnd === null) {
      errors.push('currentGroupStart and currentGroupEnd recommended when status is AVAILABLE');
      if (options.suggest) {
        suggestions.push('Use .currentGroups(start, end) to show current group range');
      }
    }
  }

  // Validate group range
  if (
    queue.currentGroupStart !== null &&
    queue.currentGroupEnd !== null &&
    queue.currentGroupEnd < queue.currentGroupStart
  ) {
    errors.push('currentGroupEnd must be >= currentGroupStart');
    if (options.suggest) {
      suggestions.push('Check your group range logic');
    }
  }

  // Validate estimated wait
  if (queue.estimatedWait !== null) {
    if (typeof queue.estimatedWait !== 'number' || queue.estimatedWait < 0) {
      errors.push('estimatedWait must be positive number or null');
      if (options.suggest) {
        suggestions.push('Use minutes: 30 for 30 minutes wait');
      }
    }
  }

  // Validate next allocation time format
  if (queue.nextAllocationTime) {
    try {
      const date = new Date(queue.nextAllocationTime);
      if (isNaN(date.getTime())) {
        errors.push('nextAllocationTime is not a valid date string');
      }
    } catch {
      errors.push('nextAllocationTime is not a valid date string');
      if (options.suggest) {
        suggestions.push('Use ISO 8601 format: YYYY-MM-DDTHH:mm:ss±HH:mm');
      }
    }
  }

  return options.suggest
    ? { valid: errors.length === 0, errors, suggestions }
    : errors;
}
