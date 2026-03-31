/**
 * Edge case tests for Virtual Queue Validators
 *
 * Covers uncovered branches and unusual inputs not tested by the main validator.test.ts
 */

import { describe, test, expect } from 'vitest';
import {
  validateReturnTimeQueue,
  validateBoardingGroupQueue,
  validatePaidReturnTimeQueue,
} from '../validator.js';

describe('Virtual Queue Validator Edge Cases', () => {
  describe('validateReturnTimeQueue edge cases', () => {
    test('should reject undefined queue', () => {
      const errors = validateReturnTimeQueue(undefined) as string[];
      expect(errors).toContain('Queue object is null or undefined');
    });

    test('should return ValidationResult with suggestions for null queue', () => {
      const result = validateReturnTimeQueue(null, { suggest: true });
      expect(result).not.toBeInstanceOf(Array);
      if (!Array.isArray(result)) {
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Queue object is null or undefined');
        expect(result.suggestions!.length).toBeGreaterThan(0);
      }
    });

    test('should reject returnStart without returnEnd for AVAILABLE state', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: null,
      };

      const errors = validateReturnTimeQueue(queue) as string[];
      expect(errors).toContain('returnEnd required when state is AVAILABLE');
      expect(errors).not.toContain('returnStart required when state is AVAILABLE');
    });

    test('should reject returnEnd without returnStart for AVAILABLE state', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: null,
        returnEnd: '2024-10-15T14:45:00-04:00',
      };

      const errors = validateReturnTimeQueue(queue) as string[];
      expect(errors).toContain('returnStart required when state is AVAILABLE');
      expect(errors).not.toContain('returnEnd required when state is AVAILABLE');
    });

    test('should pass TEMP_FULL state with null times', () => {
      const queue = {
        state: 'TEMP_FULL' as const,
        returnStart: null,
        returnEnd: null,
      };

      const errors = validateReturnTimeQueue(queue) as string[];
      expect(errors).toEqual([]);
    });

    test('should reject when returnStart equals returnEnd', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:30:00-04:00',
      };

      const errors = validateReturnTimeQueue(queue) as string[];
      expect(errors).toContain('returnEnd must be after returnStart');
    });

    test('should detect invalid returnStart via isNaN check with suggest option', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: 'not-a-real-date',
        returnEnd: '2024-10-15T14:45:00-04:00',
      };

      const result = validateReturnTimeQueue(queue, { suggest: true });
      if (!Array.isArray(result)) {
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('returnStart is not a valid date string');
      }
    });

    test('should detect invalid returnEnd via isNaN check with suggest option', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: 'xyz',
      };

      const result = validateReturnTimeQueue(queue, { suggest: true });
      if (!Array.isArray(result)) {
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('returnEnd is not a valid date string');
      }
    });

    test('should provide time order suggestion when end before start with suggest option', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T16:00:00-04:00',
        returnEnd: '2024-10-15T14:00:00-04:00',
      };

      const result = validateReturnTimeQueue(queue, { suggest: true });
      if (!Array.isArray(result)) {
        expect(result.suggestions!.some(s => s.includes('time window'))).toBe(true);
      }
    });
  });

  describe('validatePaidReturnTimeQueue edge cases', () => {
    test('should reject null queue and return errors', () => {
      const errors = validatePaidReturnTimeQueue(null) as string[];
      expect(errors).toContain('Queue object is null or undefined');
    });

    test('should reject undefined queue', () => {
      const errors = validatePaidReturnTimeQueue(undefined) as string[];
      expect(errors).toContain('Queue object is null or undefined');
    });

    test('should return ValidationResult with suggestions for null queue', () => {
      const result = validatePaidReturnTimeQueue(null, { suggest: true });
      if (!Array.isArray(result)) {
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Queue object is null or undefined');
      }
    });

    test('should accept price with amount zero', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
        price: {
          currency: 'USD' as const,
          amount: 0,
        },
      };

      const errors = validatePaidReturnTimeQueue(queue) as string[];
      expect(errors).toEqual([]);
    });

    test('should reject price with empty string currency', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
        price: {
          currency: '' as any,
          amount: 1500,
        },
      };

      const errors = validatePaidReturnTimeQueue(queue) as string[];
      expect(errors).toContain('price.currency must be 3-letter currency code');
    });

    test('should reject price with 4-letter currency code', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
        price: {
          currency: 'USDD' as any,
          amount: 1500,
        },
      };

      const errors = validatePaidReturnTimeQueue(queue) as string[];
      expect(errors).toContain('price.currency must be 3-letter currency code');
    });

    test('should reject price with null currency', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
        price: {
          currency: null as any,
          amount: 1500,
        },
      };

      const errors = validatePaidReturnTimeQueue(queue) as string[];
      expect(errors).toContain('price.currency must be 3-letter currency code');
    });

    test('should reject boolean amount', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
        price: {
          currency: 'USD' as const,
          amount: true as any,
        },
      };

      const errors = validatePaidReturnTimeQueue(queue) as string[];
      expect(errors).toContain('price.amount must be a number (in cents) or null');
    });

    test('should accept negative amount (negative price is a number)', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
        price: {
          currency: 'USD' as const,
          amount: -100,
        },
      };

      // The validator only checks that amount is a number or null; it does not reject negative
      const errors = validatePaidReturnTimeQueue(queue) as string[];
      expect(errors).not.toContain('price.amount must be a number (in cents) or null');
    });

    test('should provide price suggestion when price missing with suggest option', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
      } as any;

      const result = validatePaidReturnTimeQueue(queue, { suggest: true });
      if (!Array.isArray(result)) {
        expect(result.suggestions!.some(s => s.includes('withPrice'))).toBe(true);
      }
    });

    test('should provide currency suggestion for invalid currency with suggest option', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
        price: {
          currency: 'X' as any,
          amount: 1500,
        },
      };

      const result = validatePaidReturnTimeQueue(queue, { suggest: true });
      if (!Array.isArray(result)) {
        expect(result.suggestions!.some(s => s.includes('ISO 4217'))).toBe(true);
      }
    });

    test('should provide amount suggestion for non-numeric amount with suggest option', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
        price: {
          currency: 'EUR' as const,
          amount: 'free' as any,
        },
      };

      const result = validatePaidReturnTimeQueue(queue, { suggest: true });
      if (!Array.isArray(result)) {
        expect(result.suggestions!.some(s => s.includes('cents'))).toBe(true);
      }
    });

    test('should combine base return time errors with price errors', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: null,
        returnEnd: null,
        price: {
          currency: 'AB' as any,
          amount: 'nope' as any,
        },
      };

      const errors = validatePaidReturnTimeQueue(queue) as string[];
      // Should have return time errors AND price errors
      expect(errors).toContain('returnStart required when state is AVAILABLE');
      expect(errors).toContain('returnEnd required when state is AVAILABLE');
      expect(errors).toContain('price.currency must be 3-letter currency code');
      expect(errors).toContain('price.amount must be a number (in cents) or null');
    });

    test('should report valid=true for a correct paid queue with suggest option', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
        price: {
          currency: 'GBP' as const,
          amount: 2500,
        },
      };

      const result = validatePaidReturnTimeQueue(queue, { suggest: true });
      if (!Array.isArray(result)) {
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      }
    });
  });

  describe('validateBoardingGroupQueue edge cases', () => {
    test('should reject undefined queue', () => {
      const errors = validateBoardingGroupQueue(undefined) as string[];
      expect(errors).toContain('Queue object is null or undefined');
    });

    test('should return ValidationResult with suggestions for undefined queue', () => {
      const result = validateBoardingGroupQueue(undefined, { suggest: true });
      if (!Array.isArray(result)) {
        expect(result.valid).toBe(false);
        expect(result.suggestions!.length).toBeGreaterThan(0);
      }
    });

    test('should reject string estimatedWait', () => {
      const queue = {
        allocationStatus: 'AVAILABLE' as const,
        currentGroupStart: 1,
        currentGroupEnd: 10,
        nextAllocationTime: null,
        estimatedWait: '30' as any,
      };

      const errors = validateBoardingGroupQueue(queue) as string[];
      expect(errors).toContain('estimatedWait must be positive number or null');
    });

    test('should accept estimatedWait of zero', () => {
      const queue = {
        allocationStatus: 'AVAILABLE' as const,
        currentGroupStart: 1,
        currentGroupEnd: 10,
        nextAllocationTime: null,
        estimatedWait: 0,
      };

      const errors = validateBoardingGroupQueue(queue) as string[];
      // 0 is non-negative, should pass
      expect(errors).not.toContain('estimatedWait must be positive number or null');
    });

    test('should report multiple errors simultaneously', () => {
      const queue = {
        allocationStatus: 'AVAILABLE' as const,
        currentGroupStart: null,
        currentGroupEnd: null,
        nextAllocationTime: null,
        estimatedWait: -5,
      };

      const errors = validateBoardingGroupQueue(queue) as string[];
      expect(errors).toContain('currentGroupStart and currentGroupEnd recommended when status is AVAILABLE');
      expect(errors).toContain('estimatedWait must be positive number or null');
    });

    test('should pass CLOSED status with all null fields', () => {
      const queue = {
        allocationStatus: 'CLOSED' as const,
        currentGroupStart: null,
        currentGroupEnd: null,
        nextAllocationTime: null,
        estimatedWait: null,
      };

      const errors = validateBoardingGroupQueue(queue) as string[];
      expect(errors).toEqual([]);
    });

    test('should provide suggestion for PAUSED without nextAllocationTime', () => {
      const queue = {
        allocationStatus: 'PAUSED' as const,
        currentGroupStart: null,
        currentGroupEnd: null,
        nextAllocationTime: null,
        estimatedWait: null,
      };

      const result = validateBoardingGroupQueue(queue, { suggest: true });
      if (!Array.isArray(result)) {
        expect(result.suggestions!.some(s => s.includes('nextAllocationTime'))).toBe(true);
      }
    });

    test('should provide suggestion for AVAILABLE without groups', () => {
      const queue = {
        allocationStatus: 'AVAILABLE' as const,
        currentGroupStart: null,
        currentGroupEnd: null,
        nextAllocationTime: null,
        estimatedWait: null,
      };

      const result = validateBoardingGroupQueue(queue, { suggest: true });
      if (!Array.isArray(result)) {
        expect(result.suggestions!.some(s => s.includes('currentGroups'))).toBe(true);
      }
    });

    test('should detect invalid nextAllocationTime via isNaN check with suggest option', () => {
      const queue = {
        allocationStatus: 'PAUSED' as const,
        currentGroupStart: null,
        currentGroupEnd: null,
        nextAllocationTime: 'tomorrow morning',
        estimatedWait: null,
      };

      const result = validateBoardingGroupQueue(queue, { suggest: true });
      if (!Array.isArray(result)) {
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('nextAllocationTime is not a valid date string');
      }
    });

    test('should provide suggestion for negative estimatedWait', () => {
      const queue = {
        allocationStatus: 'AVAILABLE' as const,
        currentGroupStart: 1,
        currentGroupEnd: 10,
        nextAllocationTime: null,
        estimatedWait: -1,
      };

      const result = validateBoardingGroupQueue(queue, { suggest: true });
      if (!Array.isArray(result)) {
        expect(result.suggestions!.some(s => s.includes('minutes'))).toBe(true);
      }
    });

    test('should provide suggestion for reversed group range', () => {
      const queue = {
        allocationStatus: 'AVAILABLE' as const,
        currentGroupStart: 100,
        currentGroupEnd: 50,
        nextAllocationTime: null,
        estimatedWait: null,
      };

      const result = validateBoardingGroupQueue(queue, { suggest: true });
      if (!Array.isArray(result)) {
        expect(result.suggestions!.some(s => s.includes('group range'))).toBe(true);
      }
    });

    test('should report valid=true for a correct queue with suggest option', () => {
      const queue = {
        allocationStatus: 'AVAILABLE' as const,
        currentGroupStart: 1,
        currentGroupEnd: 20,
        nextAllocationTime: null,
        estimatedWait: 15,
      };

      const result = validateBoardingGroupQueue(queue, { suggest: true });
      if (!Array.isArray(result)) {
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      }
    });
  });
});
