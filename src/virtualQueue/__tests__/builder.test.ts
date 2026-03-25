/**
 * Tests for VQueueBuilder
 */

import {
  VQueueBuilder,
  ReturnTimeBuilder,
  PaidReturnTimeBuilder,
  BoardingGroupBuilder,
} from '../builder';

describe('VQueueBuilder', () => {
  describe('returnTime()', () => {
    it('should create a return time builder', () => {
      const builder = VQueueBuilder.returnTime();
      expect(builder).toBeInstanceOf(ReturnTimeBuilder);
    });

    it('should build available return time queue', () => {
      const queue = VQueueBuilder.returnTime()
        .available()
        .withWindow('2024-10-15T14:30:00-04:00', '2024-10-15T14:45:00-04:00')
        .build();

      expect(queue).toEqual({
        state: 'AVAILABLE',
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
      });
    });

    it('should build temporarily full queue', () => {
      const queue = VQueueBuilder.returnTime()
        .temporarilyFull()
        .build();

      expect(queue).toEqual({
        state: 'TEMP_FULL',
        returnStart: null,
        returnEnd: null,
      });
    });

    it('should build finished queue', () => {
      const queue = VQueueBuilder.returnTime()
        .finished()
        .build();

      expect(queue).toEqual({
        state: 'FINISHED',
        returnStart: null,
        returnEnd: null,
      });
    });

    it('should allow setting state directly', () => {
      const queue = VQueueBuilder.returnTime()
        .state('TEMP_FULL')
        .build();

      expect(queue.state).toBe('TEMP_FULL');
    });

    it('should handle null time windows', () => {
      const queue = VQueueBuilder.returnTime()
        .available()
        .withWindow(null, null)
        .build();

      expect(queue.returnStart).toBeNull();
      expect(queue.returnEnd).toBeNull();
    });

    it('should allow chaining methods', () => {
      const queue = VQueueBuilder.returnTime()
        .state('AVAILABLE')
        .withWindow('2024-10-15T14:30:00-04:00', '2024-10-15T14:45:00-04:00')
        .build();

      expect(queue.state).toBe('AVAILABLE');
      expect(queue.returnStart).toBe('2024-10-15T14:30:00-04:00');
    });
  });

  describe('paidReturnTime()', () => {
    it('should create a paid return time builder', () => {
      const builder = VQueueBuilder.paidReturnTime();
      expect(builder).toBeInstanceOf(PaidReturnTimeBuilder);
    });

    it('should build paid return time queue with price', () => {
      const queue = VQueueBuilder.paidReturnTime()
        .available()
        .withWindow('2024-10-15T14:30:00-04:00', '2024-10-15T14:45:00-04:00')
        .withPrice('USD', 1500)
        .build();

      expect(queue).toEqual({
        state: 'AVAILABLE',
        returnStart: '2024-10-15T14:30:00-04:00',
        returnEnd: '2024-10-15T14:45:00-04:00',
        price: {
          currency: 'USD',
          amount: 1500,
        },
      });
    });

    it('should handle null price amount', () => {
      const queue = VQueueBuilder.paidReturnTime()
        .available()
        .withWindow('2024-10-15T14:30:00-04:00', null)
        .withPrice('EUR', null)
        .build();

      // null is converted to 0 for compatibility with typelib PriceData
      expect(queue.price).toEqual({
        currency: 'EUR',
        amount: 0,
      });
    });

    it('should inherit return time builder methods', () => {
      const queue = VQueueBuilder.paidReturnTime()
        .finished()
        .withPrice('GBP', 1000)
        .build();

      expect(queue.state).toBe('FINISHED');
      expect(queue.price.currency).toBe('GBP');
    });
  });

  describe('boardingGroup()', () => {
    it('should create a boarding group builder', () => {
      const builder = VQueueBuilder.boardingGroup();
      expect(builder).toBeInstanceOf(BoardingGroupBuilder);
    });

    it('should build available boarding group queue', () => {
      const queue = VQueueBuilder.boardingGroup()
        .available()
        .currentGroups(45, 60)
        .estimatedWait(30)
        .build();

      expect(queue).toEqual({
        allocationStatus: 'AVAILABLE',
        currentGroupStart: 45,
        currentGroupEnd: 60,
        nextAllocationTime: null,
        estimatedWait: 30,
      });
    });

    it('should build paused boarding group queue', () => {
      const queue = VQueueBuilder.boardingGroup()
        .paused()
        .nextAllocationTime('2024-10-15T16:00:00-04:00')
        .build();

      expect(queue).toEqual({
        allocationStatus: 'PAUSED',
        currentGroupStart: null,
        currentGroupEnd: null,
        nextAllocationTime: '2024-10-15T16:00:00-04:00',
        estimatedWait: null,
      });
    });

    it('should build closed boarding group queue', () => {
      const queue = VQueueBuilder.boardingGroup()
        .closed()
        .build();

      expect(queue).toEqual({
        allocationStatus: 'CLOSED',
        currentGroupStart: null,
        currentGroupEnd: null,
        nextAllocationTime: null,
        estimatedWait: null,
      });
    });

    it('should allow setting status directly', () => {
      const queue = VQueueBuilder.boardingGroup()
        .status('PAUSED')
        .build();

      expect(queue.allocationStatus).toBe('PAUSED');
    });

    it('should handle null group ranges', () => {
      const queue = VQueueBuilder.boardingGroup()
        .available()
        .currentGroups(null, null)
        .build();

      expect(queue.currentGroupStart).toBeNull();
      expect(queue.currentGroupEnd).toBeNull();
    });

    it('should handle null estimated wait', () => {
      const queue = VQueueBuilder.boardingGroup()
        .available()
        .estimatedWait(null)
        .build();

      expect(queue.estimatedWait).toBeNull();
    });

    it('should allow chaining all methods', () => {
      const queue = VQueueBuilder.boardingGroup()
        .status('AVAILABLE')
        .currentGroups(1, 10)
        .nextAllocationTime('2024-10-15T10:00:00-04:00')
        .estimatedWait(15)
        .build();

      expect(queue.allocationStatus).toBe('AVAILABLE');
      expect(queue.currentGroupStart).toBe(1);
      expect(queue.currentGroupEnd).toBe(10);
      expect(queue.nextAllocationTime).toBe('2024-10-15T10:00:00-04:00');
      expect(queue.estimatedWait).toBe(15);
    });
  });

  describe('Real-world scenarios', () => {
    it('should build Universal Virtual Line queue', () => {
      // Universal pattern: explicit time slots from API
      const queue = VQueueBuilder.returnTime()
        .available()
        .withWindow('2024-10-15T15:00:00-04:00', '2024-10-15T15:15:00-04:00')
        .build();

      expect(queue.state).toBe('AVAILABLE');
      expect(queue.returnStart).toBeTruthy();
      expect(queue.returnEnd).toBeTruthy();
    });

    it('should build Disney Genie+ queue', () => {
      // Disney pattern: paid return time
      const queue = VQueueBuilder.paidReturnTime()
        .available()
        .withWindow('2024-10-15T14:30:00-04:00', '2024-10-15T15:30:00-04:00')
        .withPrice('USD', 0) // Included with Genie+
        .build();

      expect(queue.state).toBe('AVAILABLE');
      expect(queue.price.amount).toBe(0);
    });

    it('should build Disney Individual Lightning Lane queue', () => {
      // Disney pattern: paid individual selection
      const queue = VQueueBuilder.paidReturnTime()
        .available()
        .withWindow('2024-10-15T14:30:00-04:00', null)
        .withPrice('USD', 1500)
        .build();

      expect(queue.price.amount).toBe(1500);
      expect(queue.returnEnd).toBeNull();
    });

    it('should build Rise of Resistance boarding group', () => {
      // Disney pattern: boarding groups
      const queue = VQueueBuilder.boardingGroup()
        .available()
        .currentGroups(45, 60)
        .estimatedWait(30)
        .build();

      expect(queue.allocationStatus).toBe('AVAILABLE');
      expect(queue.currentGroupStart).toBe(45);
      expect(queue.currentGroupEnd).toBe(60);
    });

    it('should build paused boarding group with next allocation', () => {
      // Disney pattern: paused with next time
      const queue = VQueueBuilder.boardingGroup()
        .paused()
        .nextAllocationTime('2024-10-15T13:00:00-04:00')
        .build();

      expect(queue.allocationStatus).toBe('PAUSED');
      expect(queue.nextAllocationTime).toBeTruthy();
    });

    it('should build Efteling-style virtual queue (temp full)', () => {
      // Efteling pattern: no slots available right now
      const queue = VQueueBuilder.returnTime()
        .temporarilyFull()
        .build();

      expect(queue.state).toBe('TEMP_FULL');
      expect(queue.returnStart).toBeNull();
    });

    it('should build finished queue (all slots gone)', () => {
      const queue = VQueueBuilder.returnTime()
        .finished()
        .build();

      expect(queue.state).toBe('FINISHED');
    });
  });
});
