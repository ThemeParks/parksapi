/**
 * Test Destination virtual queue helper methods
 *
 * These tests verify that the VQ helpers on Destination correctly use
 * the subclass timezone property (not the config bag) for formatting dates.
 */

import {Destination} from '../destination.js';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';

/**
 * Minimal Destination subclass that sets timezone as a class property,
 * matching the pattern used by real parks (e.g., Universal).
 */
class TestPark extends Destination {
  timezone: string = 'America/New_York';

  protected async buildEntityList(): Promise<Entity[]> {
    return [];
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    return [];
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    return [];
  }

  async getDestinations(): Promise<Entity[]> {
    return [];
  }

  // Expose protected methods for testing
  public testBuildReturnTimeQueue(
    ...args: Parameters<Destination['buildReturnTimeQueue']>
  ) {
    return this.buildReturnTimeQueue(...args);
  }

  public testBuildPaidReturnTimeQueue(
    ...args: Parameters<Destination['buildPaidReturnTimeQueue']>
  ) {
    return this.buildPaidReturnTimeQueue(...args);
  }

  public testBuildBoardingGroupQueue(
    ...args: Parameters<Destination['buildBoardingGroupQueue']>
  ) {
    return this.buildBoardingGroupQueue(...args);
  }

  public testCalculateReturnWindow(
    ...args: Parameters<Destination['calculateReturnWindow']>
  ) {
    return this.calculateReturnWindow(...args);
  }
}

describe('Destination virtual queue helpers', () => {
  describe('timezone usage', () => {
    test('buildReturnTimeQueue should format dates in the park timezone, not UTC', () => {
      const park = new TestPark();

      // 2025-03-15T18:30:00Z = 2:30 PM EDT (UTC-4, DST active in March)
      const result = park.testBuildReturnTimeQueue(
        'AVAILABLE',
        new Date('2025-03-15T18:30:00Z'),
        new Date('2025-03-15T18:45:00Z')
      );

      // Should be formatted in America/New_York (EDT = UTC-4), NOT UTC
      expect(result.returnStart).toMatch(/14:30:00/); // 2:30 PM local, not 18:30 UTC
      expect(result.returnEnd).toMatch(/14:45:00/);
      // Should have EDT offset (-04:00 or GMT-4)
      expect(result.returnStart).toMatch(/(-04:00|GMT-4)/);
    });

    test('buildPaidReturnTimeQueue should format dates in the park timezone', () => {
      const park = new TestPark();

      const result = park.testBuildPaidReturnTimeQueue(
        'AVAILABLE',
        new Date('2025-03-15T18:30:00Z'),
        null,
        'USD',
        1500
      );

      expect(result.returnStart).toMatch(/14:30:00/);
      expect(result.returnStart).toMatch(/(-04:00|GMT-4)/);
    });

    test('buildBoardingGroupQueue should format nextAllocationTime in park timezone', () => {
      const park = new TestPark();

      const result = park.testBuildBoardingGroupQueue('AVAILABLE', {
        currentGroupStart: 45,
        currentGroupEnd: 60,
        nextAllocationTime: new Date('2025-03-15T18:30:00Z'),
      });

      expect(result.nextAllocationTime).toMatch(/14:30:00/);
      expect(result.nextAllocationTime).toMatch(/(-04:00|GMT-4)/);
    });

    test('calculateReturnWindow should use park timezone for formatting', () => {
      const park = new TestPark();
      // Fix baseTime so the test is deterministic
      const baseTime = new Date('2025-03-15T18:00:00Z'); // 2:00 PM EDT

      const result = park.testCalculateReturnWindow(30, {
        baseTime,
        windowMinutes: 15,
      });

      // Start should be baseTime + 30 min = 2:30 PM EDT
      expect(result.start).toMatch(/14:30:00/);
      expect(result.start).toMatch(/(-04:00|GMT-4)/);
      // End should be baseTime + 30 + 15 min = 2:45 PM EDT
      expect(result.end).toMatch(/14:45:00/);
    });

    test('default timezone should be UTC when subclass does not set timezone', () => {
      // Park with no timezone property set
      class UTCPark extends Destination {
        protected async buildEntityList(): Promise<Entity[]> { return []; }
        protected async buildLiveData(): Promise<LiveData[]> { return []; }
        protected async buildSchedules(): Promise<EntitySchedule[]> { return []; }
        async getDestinations(): Promise<Entity[]> { return []; }

        public testBuildReturnTimeQueue(
          ...args: Parameters<Destination['buildReturnTimeQueue']>
        ) {
          return this.buildReturnTimeQueue(...args);
        }
      }

      const park = new UTCPark();
      const result = park.testBuildReturnTimeQueue(
        'AVAILABLE',
        new Date('2025-03-15T18:30:00Z'),
        new Date('2025-03-15T18:45:00Z')
      );

      // Should fall back to UTC (18:30, not localized)
      expect(result.returnStart).toMatch(/18:30:00/);
    });
  });
});
