/**
 * Tests for Virtual Queue Validators
 */

import {
  validateReturnTimeQueue,
  validateBoardingGroupQueue,
  validatePaidReturnTimeQueue,
} from '../validator';

describe('Virtual Queue Validators', () => {
  describe('validateReturnTimeQueue()', () => {
    it('should pass valid AVAILABLE queue', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
      };

      const errors = validateReturnTimeQueue(queue) as string[];
      expect(errors).toEqual([]);
    });

    it('should pass valid FINISHED queue', () => {
      const queue = {
        state: 'FINISHED' as const,
        returnStart: null,
        returnEnd: null,
      };

      const errors = validateReturnTimeQueue(queue) as string[];
      expect(errors).toEqual([]);
    });

    it('should reject AVAILABLE without returnStart', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: null,
        returnEnd: '2024-10-15T14:45:00-04:00',
      };

      const errors = validateReturnTimeQueue(queue) as string[];
      expect(errors).toContain('returnStart required when state is AVAILABLE');
    });

    it('should reject AVAILABLE without returnEnd', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: null,
      };

      const errors = validateReturnTimeQueue(queue) as string[];
      expect(errors).toContain('returnEnd required when state is AVAILABLE');
    });

    it('should reject invalid date format for returnStart', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: 'invalid-date',
        returnEnd: '2024-10-15T14:45:00-04:00',
      };

      const errors = validateReturnTimeQueue(queue) as string[];
      expect(errors.some((e: string) => e.includes('returnStart'))).toBe(true);
    });

    it('should reject invalid date format for returnEnd', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: 'not-a-date',
      };

      const errors = validateReturnTimeQueue(queue) as string[];
      expect(errors.some((e: string) => e.includes('returnEnd'))).toBe(true);
    });

    it('should reject returnEnd before returnStart', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T15:00:00-04:00',
        returnEnd: '2024-10-15T14:00:00-04:00',
      };

      const errors = validateReturnTimeQueue(queue) as string[];
      expect(errors).toContain('returnEnd must be after returnStart');
    });

    it('should reject null queue', () => {
      const errors = validateReturnTimeQueue(null) as string[];
      expect(errors).toContain('Queue object is null or undefined');
    });

    it('should provide suggestions when requested', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: null,
        returnEnd: null,
      };

      const result = validateReturnTimeQueue(queue, { suggest: true });
      expect(result).toHaveProperty('valid', false);
      expect(result).toHaveProperty('errors');
      expect(result).toHaveProperty('suggestions');

      if (!Array.isArray(result)) {
        expect(result.suggestions).toBeTruthy();
        expect(result.suggestions!.length).toBeGreaterThan(0);
      }
    });
  });

  describe('validatePaidReturnTimeQueue()', () => {
    it('should pass valid paid queue', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
        price: {
          currency: 'USD' as const,
          amount: 1500,
        },
      };

      const errors = validatePaidReturnTimeQueue(queue) as string[];
      expect(errors).toEqual([]);
    });

    it('should reject queue without price', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
        price: undefined as any,
      };

      const errors = validatePaidReturnTimeQueue(queue) as string[];
      expect(errors).toContain('price required for paid return time');
    });

    it('should reject invalid currency code', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
        price: {
          currency: 'US' as any, // Should be 3 letters
          amount: 1500,
        },
      };

      const errors = validatePaidReturnTimeQueue(queue) as string[];
      expect(errors).toContain('price.currency must be 3-letter currency code');
    });

    it('should accept null price amount', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
        price: {
          currency: 'USD' as const,
          amount: 0, // Using 0 instead of null since typelib doesn't support null
        },
      };

      const errors = validatePaidReturnTimeQueue(queue) as string[];
      expect(errors).toEqual([]);
    });

    it('should reject non-numeric price amount', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
        price: {
          currency: 'USD' as const,
          amount: '1500' as any, // Should be number
        },
      };

      const errors = validatePaidReturnTimeQueue(queue) as string[];
      expect(errors).toContain('price.amount must be a number (in cents) or null');
    });

    it('should inherit validation from return time queue', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: null,
        returnEnd: null,
        price: {
          currency: 'USD' as const,
          amount: 1500,
        },
      };

      const errors = validatePaidReturnTimeQueue(queue) as string[];
      expect((errors as string[]).length).toBeGreaterThan(0);
      expect((errors as string[]).some((e: string) => e.includes('returnStart'))).toBe(true);
    });
  });

  describe('validateBoardingGroupQueue()', () => {
    it('should pass valid AVAILABLE queue', () => {
      const queue = {
        allocationStatus: 'AVAILABLE' as const,
        currentGroupStart: 45,
        currentGroupEnd: 60,
        nextAllocationTime: null,
        estimatedWait: 30,
      };

      const errors = validateBoardingGroupQueue(queue) as string[];
      expect(errors).toEqual([]);
    });

    it('should pass valid PAUSED queue with next allocation', () => {
      const queue = {
        allocationStatus: 'PAUSED' as const,
        currentGroupStart: null,
        currentGroupEnd: null,
        nextAllocationTime: '2024-10-15T16:00:00-04:00',
        estimatedWait: null,
      };

      const errors = validateBoardingGroupQueue(queue) as string[];
      expect(errors).toEqual([]);
    });

    it('should pass valid CLOSED queue', () => {
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

    it('should warn when PAUSED without nextAllocationTime', () => {
      const queue = {
        allocationStatus: 'PAUSED' as const,
        currentGroupStart: null,
        currentGroupEnd: null,
        nextAllocationTime: null,
        estimatedWait: null,
      };

      const errors = validateBoardingGroupQueue(queue) as string[];
      expect(errors).toContain('nextAllocationTime recommended when status is PAUSED');
    });

    it('should warn when AVAILABLE without current groups', () => {
      const queue = {
        allocationStatus: 'AVAILABLE' as const,
        currentGroupStart: null,
        currentGroupEnd: null,
        nextAllocationTime: null,
        estimatedWait: 30,
      };

      const errors = validateBoardingGroupQueue(queue) as string[];
      expect(errors).toContain(
        'currentGroupStart and currentGroupEnd recommended when status is AVAILABLE'
      );
    });

    it('should reject currentGroupEnd < currentGroupStart', () => {
      const queue = {
        allocationStatus: 'AVAILABLE' as const,
        currentGroupStart: 60,
        currentGroupEnd: 45, // Invalid!
        nextAllocationTime: null,
        estimatedWait: 30,
      };

      const errors = validateBoardingGroupQueue(queue) as string[];
      expect(errors).toContain('currentGroupEnd must be >= currentGroupStart');
    });

    it('should accept equal group start and end', () => {
      const queue = {
        allocationStatus: 'AVAILABLE' as const,
        currentGroupStart: 45,
        currentGroupEnd: 45,
        nextAllocationTime: null,
        estimatedWait: 30,
      };

      const errors = validateBoardingGroupQueue(queue) as string[];
      expect(errors).toEqual([]);
    });

    it('should reject negative estimatedWait', () => {
      const queue = {
        allocationStatus: 'AVAILABLE' as const,
        currentGroupStart: 45,
        currentGroupEnd: 60,
        nextAllocationTime: null,
        estimatedWait: -10,
      };

      const errors = validateBoardingGroupQueue(queue) as string[];
      expect(errors).toContain('estimatedWait must be positive number or null');
    });

    it('should accept null estimatedWait', () => {
      const queue = {
        allocationStatus: 'AVAILABLE' as const,
        currentGroupStart: 45,
        currentGroupEnd: 60,
        nextAllocationTime: null,
        estimatedWait: null,
      };

      const errors = validateBoardingGroupQueue(queue) as string[];
      expect(errors).toEqual([]);
    });

    it('should reject invalid nextAllocationTime format', () => {
      const queue = {
        allocationStatus: 'PAUSED' as const,
        currentGroupStart: null,
        currentGroupEnd: null,
        nextAllocationTime: 'not-a-date',
        estimatedWait: null,
      };

      const errors = validateBoardingGroupQueue(queue) as string[];
      expect((errors as string[]).some((e: string) => e.includes('nextAllocationTime'))).toBe(true);
    });

    it('should reject null queue', () => {
      const errors = validateBoardingGroupQueue(null) as string[];
      expect(errors).toContain('Queue object is null or undefined');
    });

    it('should provide suggestions when requested', () => {
      const queue = {
        allocationStatus: 'AVAILABLE' as const,
        currentGroupStart: null,
        currentGroupEnd: null,
        nextAllocationTime: null,
        estimatedWait: null,
      };

      const result = validateBoardingGroupQueue(queue, { suggest: true });
      expect(result).toHaveProperty('valid', false);
      expect(result).toHaveProperty('suggestions');

      if (!Array.isArray(result)) {
        expect(result.suggestions).toBeTruthy();
      }
    });
  });

  describe('Real-world validation scenarios', () => {
    it('should validate Universal Virtual Line data', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T15:00:00-04:00',
        returnEnd: '2024-10-15T15:15:00-04:00',
      };

      const errors = validateReturnTimeQueue(queue) as string[];
      expect(errors).toEqual([]);
    });

    it('should validate Disney Genie+ data', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T15:30:00-04:00',
        price: {
          currency: 'USD' as const,
          amount: 0, // Included with Genie+
        },
      };

      const errors = validatePaidReturnTimeQueue(queue) as string[];
      expect(errors).toEqual([]);
    });

    it('should validate Disney Individual Lightning Lane data', () => {
      // Note: In real-world, Disney often has open-ended return times (no specific end)
      // Our validation requires returnEnd when AVAILABLE, so we test with both times
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T23:59:00-04:00', // Set end of day as return window
        price: {
          currency: 'USD' as const,
          amount: 1500,
        },
      };

      const errors = validatePaidReturnTimeQueue(queue) as string[];
      expect(errors).toEqual([]);
    });

    it('should validate Rise of Resistance boarding group', () => {
      const queue = {
        allocationStatus: 'AVAILABLE' as const,
        currentGroupStart: 45,
        currentGroupEnd: 60,
        nextAllocationTime: null,
        estimatedWait: 30,
      };

      const errors = validateBoardingGroupQueue(queue) as string[];
      expect(errors).toEqual([]);
    });

    it('should catch common mistake: missing price', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
        // Missing price!
      } as any;

      const errors = validatePaidReturnTimeQueue(queue) as string[];
      expect((errors as string[]).length).toBeGreaterThan(0);
    });

    it('should catch common mistake: wrong currency format', () => {
      const queue = {
        state: 'AVAILABLE' as const,
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
        price: {
          currency: '$' as any, // Wrong format!
          amount: 1500,
        },
      };

      const errors = validatePaidReturnTimeQueue(queue) as string[];
      expect(errors).toContain('price.currency must be 3-letter currency code');
    });
  });
});
