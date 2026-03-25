/**
 * Tests for State Determination Logic
 */

import { determineReturnTimeState, determineBoardingGroupState } from '../state';

describe('State Determination Logic', () => {
  describe('determineReturnTimeState()', () => {
    it('should return FINISHED when ride is closed', () => {
      const state = determineReturnTimeState({
        hasSlots: true,
        slotsAvailableNow: true,
        moreSlotsLater: true,
        isRideOpen: false,
      });

      expect(state).toBe('FINISHED');
    });

    it('should return FINISHED when no slots available', () => {
      const state = determineReturnTimeState({
        hasSlots: false,
        slotsAvailableNow: false,
        moreSlotsLater: false,
        isRideOpen: true,
      });

      expect(state).toBe('FINISHED');
    });

    it('should return AVAILABLE when slots available now', () => {
      const state = determineReturnTimeState({
        hasSlots: true,
        slotsAvailableNow: true,
        moreSlotsLater: true,
        isRideOpen: true,
      });

      expect(state).toBe('AVAILABLE');
    });

    it('should return TEMP_FULL when slots exist but not now', () => {
      const state = determineReturnTimeState({
        hasSlots: true,
        slotsAvailableNow: false,
        moreSlotsLater: true,
        isRideOpen: true,
      });

      expect(state).toBe('TEMP_FULL');
    });

    it('should return FINISHED when no future slots coming', () => {
      const state = determineReturnTimeState({
        hasSlots: true,
        slotsAvailableNow: false,
        moreSlotsLater: false,
        isRideOpen: true,
      });

      expect(state).toBe('FINISHED');
    });

    it('should prioritize ride status over slot availability', () => {
      // Even with available slots, closed ride = FINISHED
      const state = determineReturnTimeState({
        hasSlots: true,
        slotsAvailableNow: true,
        moreSlotsLater: true,
        isRideOpen: false,
      });

      expect(state).toBe('FINISHED');
    });
  });

  describe('determineBoardingGroupState()', () => {
    it('should return CLOSED when system is inactive', () => {
      const state = determineBoardingGroupState({
        isSystemActive: false,
        isPaused: false,
        hasNextAllocationTime: false,
        isRideOpen: true,
      });

      expect(state).toBe('CLOSED');
    });

    it('should return CLOSED when ride is closed', () => {
      const state = determineBoardingGroupState({
        isSystemActive: true,
        isPaused: false,
        hasNextAllocationTime: false,
        isRideOpen: false,
      });

      expect(state).toBe('CLOSED');
    });

    it('should return PAUSED when paused with next allocation time', () => {
      const state = determineBoardingGroupState({
        isSystemActive: true,
        isPaused: true,
        hasNextAllocationTime: true,
        isRideOpen: true,
      });

      expect(state).toBe('PAUSED');
    });

    it('should return CLOSED when paused without next allocation time', () => {
      const state = determineBoardingGroupState({
        isSystemActive: true,
        isPaused: true,
        hasNextAllocationTime: false,
        isRideOpen: true,
      });

      expect(state).toBe('CLOSED');
    });

    it('should return AVAILABLE when active and not paused', () => {
      const state = determineBoardingGroupState({
        isSystemActive: true,
        isPaused: false,
        hasNextAllocationTime: false,
        isRideOpen: true,
      });

      expect(state).toBe('AVAILABLE');
    });

    it('should prioritize system active and ride status', () => {
      const state = determineBoardingGroupState({
        isSystemActive: false,
        isPaused: false,
        hasNextAllocationTime: true,
        isRideOpen: false,
      });

      expect(state).toBe('CLOSED');
    });
  });

  describe('Real-world scenarios', () => {
    describe('Universal Virtual Line', () => {
      it('should handle slots available scenario', () => {
        const apiData = {
          hasSlots: true,
          nextSlotTime: new Date('2024-10-15T15:00:00'),
          rideStatus: 'OPERATING',
        };

        const state = determineReturnTimeState({
          hasSlots: apiData.hasSlots,
          slotsAvailableNow: apiData.nextSlotTime <= new Date(),
          moreSlotsLater: true,
          isRideOpen: apiData.rideStatus === 'OPERATING',
        });

        // If nextSlotTime is in future, should be TEMP_FULL
        expect(['AVAILABLE', 'TEMP_FULL']).toContain(state);
      });

      it('should handle ride closed scenario', () => {
        const state = determineReturnTimeState({
          hasSlots: true,
          slotsAvailableNow: true,
          moreSlotsLater: true,
          isRideOpen: false,
        });

        expect(state).toBe('FINISHED');
      });
    });

    describe('Disney Rise of Resistance', () => {
      it('should handle active boarding groups', () => {
        const apiData = {
          status: 'Virtual Queue',
          state: 'AVAILABLE',
        };

        const state = determineBoardingGroupState({
          isSystemActive: apiData.status === 'Virtual Queue',
          isPaused: apiData.state === 'PAUSED',
          hasNextAllocationTime: false,
          isRideOpen: true,
        });

        expect(state).toBe('AVAILABLE');
      });

      it('should handle paused with next open time', () => {
        const apiData = {
          status: 'Virtual Queue',
          state: 'PAUSED',
          nextScheduledOpenTime: '13:00:00',
        };

        const state = determineBoardingGroupState({
          isSystemActive: apiData.status === 'Virtual Queue',
          isPaused: apiData.state === 'PAUSED',
          hasNextAllocationTime: !!apiData.nextScheduledOpenTime,
          isRideOpen: true,
        });

        expect(state).toBe('PAUSED');
      });

      it('should handle closed system', () => {
        const apiData = {
          status: 'Standby',
          state: 'CLOSED',
        };

        const state = determineBoardingGroupState({
          isSystemActive: apiData.status === 'Virtual Queue',
          isPaused: false,
          hasNextAllocationTime: false,
          isRideOpen: true,
        });

        expect(state).toBe('CLOSED');
      });
    });

    describe('Efteling Virtual Queue', () => {
      it('should handle enabled state', () => {
        const apiData = {
          State: 'enabled',
          WaitingTime: 45,
        };

        const state = determineReturnTimeState({
          hasSlots: true,
          slotsAvailableNow: apiData.State === 'enabled',
          moreSlotsLater: true,
          isRideOpen: true,
        });

        expect(state).toBe('AVAILABLE');
      });

      it('should handle walkin state (not open yet)', () => {
        const apiData = {
          State: 'walkin',
        };

        const state = determineReturnTimeState({
          hasSlots: false,
          slotsAvailableNow: false,
          moreSlotsLater: true,
          isRideOpen: false,
        });

        expect(state).toBe('FINISHED');
      });

      it('should handle full state', () => {
        const apiData = {
          State: 'full',
        };

        const state = determineReturnTimeState({
          hasSlots: false,
          slotsAvailableNow: false,
          moreSlotsLater: false,
          isRideOpen: true,
        });

        expect(state).toBe('FINISHED');
      });
    });
  });
});
