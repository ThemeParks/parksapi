/**
 * Test Destination lifecycle (template method pattern)
 *
 * Validates that getEntities/getLiveData/getSchedules follow the correct
 * calling sequence: init() -> build*() -> post-processing
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { Destination, DestinationConstructor } from '../destination.js';
import config from '../config.js';
import { Entity, LiveData, EntitySchedule, LocalisedString, LanguageCode } from '@themeparks/typelib';

// A concrete subclass that tracks method calls for lifecycle verification
@config
class TestDestination extends Destination {
  public callLog: string[] = [];
  public initCount = 0;

  protected async _init(): Promise<void> {
    this.callLog.push('_init');
    this.initCount++;
  }

  protected async buildEntityList(): Promise<Entity[]> {
    this.callLog.push('buildEntityList');
    return [
      {
        id: 'dest1',
        name: 'Test Destination',
        entityType: 'DESTINATION',
        timezone: 'America/New_York',
      } as Entity,
      {
        id: 'park1',
        name: 'Test Park',
        entityType: 'PARK',
        parentId: 'dest1',
        timezone: 'America/New_York',
      } as Entity,
      {
        id: 'ride1',
        name: 'Test Ride',
        entityType: 'ATTRACTION',
        parentId: 'park1',
        timezone: 'America/New_York',
      } as Entity,
    ];
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    this.callLog.push('buildLiveData');
    return [
      {
        id: 'ride1',
        status: 'OPERATING',
        queue: {
          STANDBY: { waitTime: 30 },
        },
      } as LiveData,
    ];
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    this.callLog.push('buildSchedules');
    return [
      {
        id: 'park1',
        schedule: [
          {
            date: '2024-10-15',
            type: 'OPERATING',
            openingTime: '09:00',
            closingTime: '22:00',
          },
        ],
      } as EntitySchedule,
    ];
  }

  // Expose protected getLocalizedString for edge case testing
  public testGetLocalizedString(
    value: LocalisedString,
    language?: LanguageCode,
    fallbackLanguage?: LanguageCode
  ): string {
    return this.getLocalizedString(value, language, fallbackLanguage);
  }

  public setLanguage(lang: LanguageCode) {
    this.language = lang;
  }
}

describe('Destination Lifecycle', () => {
  let destination: TestDestination;

  beforeEach(() => {
    destination = new TestDestination();
  });

  describe('getEntities()', () => {
    test('should call init() then buildEntityList() then resolveEntityHierarchy()', async () => {
      const entities = await destination.getEntities();

      expect(destination.callLog).toEqual(['_init', 'buildEntityList']);
      // Verify hierarchy was resolved (ride1 should have parkId and destinationId set)
      const ride = entities.find(e => e.id === 'ride1');
      expect(ride).toBeDefined();
      expect(ride!.parkId).toBe('park1');
      expect(ride!.destinationId).toBe('dest1');
    });

    test('should set destinationId on DESTINATION entities to self', async () => {
      const entities = await destination.getEntities();
      const dest = entities.find(e => e.id === 'dest1');
      expect(dest!.destinationId).toBe('dest1');
      expect(dest!.parkId).toBeUndefined();
    });

    test('should set destinationId on PARK entities from parent', async () => {
      const entities = await destination.getEntities();
      const park = entities.find(e => e.id === 'park1');
      expect(park!.destinationId).toBe('dest1');
      expect(park!.parkId).toBeUndefined();
    });
  });

  describe('getLiveData()', () => {
    test('should call init() then buildLiveData()', async () => {
      const liveData = await destination.getLiveData();

      expect(destination.callLog).toEqual(['_init', 'buildLiveData']);
      expect(liveData).toHaveLength(1);
      expect(liveData[0].id).toBe('ride1');
    });
  });

  describe('getSchedules()', () => {
    test('should call init() then buildSchedules()', async () => {
      const schedules = await destination.getSchedules();

      expect(destination.callLog).toEqual(['_init', 'buildSchedules']);
      expect(schedules).toHaveLength(1);
      expect(schedules[0].id).toBe('park1');
    });
  });

  describe('init() runs only once', () => {
    test('should run _init() only once across multiple getEntities calls', async () => {
      await destination.getEntities();
      await destination.getEntities();
      await destination.getEntities();

      // _init should appear only once
      expect(destination.initCount).toBe(1);
      const initCalls = destination.callLog.filter(c => c === '_init');
      expect(initCalls).toHaveLength(1);
    });

    test('should run _init() only once across different data methods', async () => {
      await destination.getEntities();
      await destination.getLiveData();
      await destination.getSchedules();

      expect(destination.initCount).toBe(1);
    });
  });

  describe('getDestinations()', () => {
    test('should throw by default on base Destination class', async () => {
      // Use a bare subclass that does not override getDestinations
      class BareDestination extends Destination {
        protected async buildEntityList(): Promise<Entity[]> {
          return [];
        }
        protected async buildLiveData(): Promise<LiveData[]> {
          return [];
        }
        protected async buildSchedules(): Promise<EntitySchedule[]> {
          return [];
        }
      }

      const bare = new BareDestination();
      await expect(bare.getDestinations()).rejects.toThrow('getDestinations not implemented');
    });
  });

  describe('Default build methods throw on base class', () => {
    test('buildEntityList() should throw when not overridden', async () => {
      class MinimalDestination extends Destination {}
      const minimal = new MinimalDestination();
      // Access through getEntities which calls buildEntityList
      await expect(minimal.getEntities()).rejects.toThrow('buildEntityList not implemented');
    });

    test('buildLiveData() should throw when not overridden', async () => {
      class MinimalDestination extends Destination {}
      const minimal = new MinimalDestination();
      await expect(minimal.getLiveData()).rejects.toThrow('buildLiveData not implemented');
    });

    test('buildSchedules() should throw when not overridden', async () => {
      class MinimalDestination extends Destination {}
      const minimal = new MinimalDestination();
      await expect(minimal.getSchedules()).rejects.toThrow('buildSchedules not implemented');
    });
  });

  describe('getLocalizedString edge cases', () => {
    test('should return empty string for empty string input', () => {
      const result = destination.testGetLocalizedString('');
      expect(result).toBe('');
    });

    test('should handle object with only non-priority languages', () => {
      const localized = {
        ja: '日本語名',
        ko: '한국어 이름',
      };

      // Default language is 'en', neither ja nor ko match, and no 'en' fallback
      const result = destination.testGetLocalizedString(localized);
      // Should return first available value
      expect(['日本語名', '한국어 이름']).toContain(result);
    });

    test('should return empty string for object with all undefined values', () => {
      const localized = {
        en: undefined,
        fr: undefined,
      } as unknown as Record<LanguageCode, string>;

      const result = destination.testGetLocalizedString(localized);
      expect(result).toBe('');
    });

    test('should handle language with variant when base language also unavailable', () => {
      // Requesting en-gb, no 'en' either, should fall through to fallback then first available
      destination.setLanguage('en-gb' as LanguageCode);
      const localized = {
        de: 'Deutsch',
        fr: 'Francais',
      };

      const result = destination.testGetLocalizedString(localized, undefined, 'de');
      expect(result).toBe('Deutsch');
    });

    test('should prefer explicit language parameter over instance language', () => {
      destination.setLanguage('fr');
      const localized = {
        en: 'English',
        fr: 'Francais',
        de: 'Deutsch',
      };

      const result = destination.testGetLocalizedString(localized, 'de');
      expect(result).toBe('Deutsch');
    });

    test('should handle single-language object matching exactly', () => {
      const localized = { nl: 'Alleen Nederlands' };
      const result = destination.testGetLocalizedString(localized, 'nl');
      expect(result).toBe('Alleen Nederlands');
    });
  });
});
