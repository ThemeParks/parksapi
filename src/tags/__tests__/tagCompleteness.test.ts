/**
 * Comprehensive validation tests to ensure all tags are properly implemented
 *
 * These tests catch common mistakes when adding new tags:
 * - Missing TAG_NAMES entries
 * - Missing SIMPLE_TAG_TYPES entries
 * - Missing validators for complex tags
 * - Missing TagBuilder methods
 * - Missing StandardLocationId helper methods
 */

import {TagType, TAG_NAMES, SIMPLE_TAG_TYPES, StandardLocationId} from '../tagTypes';
import {TagBuilder} from '../tagBuilder';
import {validateTagValue} from '../validators';
import {getSimpleTagRegistry, getComplexTagRegistry, getLocationHelperRegistry} from '../tagMetadata';

describe('Tag System Completeness', () => {
  describe('TagType enum coverage', () => {
    it('every TagType should have a TAG_NAME', () => {
      const allTagTypes = Object.values(TagType);
      const missingNames: string[] = [];

      allTagTypes.forEach(tagType => {
        if (!TAG_NAMES[tagType]) {
          missingNames.push(tagType);
        }
      });

      expect(missingNames).toEqual([]);
      if (missingNames.length > 0) {
        throw new Error(
          `Missing TAG_NAMES for: ${missingNames.join(', ')}\n` +
          `Add them to TAG_NAMES in tagTypes.ts`
        );
      }
    });

    it('every TAG_NAME should have a valid TagType', () => {
      const allTagTypes = Object.values(TagType);
      const extraNames: string[] = [];

      Object.keys(TAG_NAMES).forEach(tagType => {
        if (!allTagTypes.includes(tagType as TagType)) {
          extraNames.push(tagType);
        }
      });

      expect(extraNames).toEqual([]);
      if (extraNames.length > 0) {
        throw new Error(
          `TAG_NAMES contains invalid TagTypes: ${extraNames.join(', ')}\n` +
          `Remove them or add to TagType enum`
        );
      }
    });

    it('every TagType should be categorized as simple or complex', () => {
      const allTagTypes = Object.values(TagType);
      const uncategorized: string[] = [];

      allTagTypes.forEach(tagType => {
        const isSimple = SIMPLE_TAG_TYPES.has(tagType);

        // Try validation with undefined to check if it's complex
        let isComplex = false;
        try {
          validateTagValue(tagType, undefined);
          // If it doesn't throw, it accepts undefined (simple tag)
        } catch (error: any) {
          // If it throws "requires a value", it's a complex tag
          if (error.message.includes('requires a value')) {
            isComplex = true;
          }
        }

        if (!isSimple && !isComplex) {
          uncategorized.push(tagType);
        }
      });

      expect(uncategorized).toEqual([]);
      if (uncategorized.length > 0) {
        throw new Error(
          `Uncategorized TagTypes: ${uncategorized.join(', ')}\n` +
          `Add to SIMPLE_TAG_TYPES or add validator in validators.ts`
        );
      }
    });
  });

  describe('TagBuilder method coverage', () => {
    it('every simple tag should have a TagBuilder method with @simpleTag decorator', () => {
      const simpleTagTypes = Array.from(SIMPLE_TAG_TYPES);
      const simpleTagRegistry = getSimpleTagRegistry();
      const missingMethods: string[] = [];

      simpleTagTypes.forEach(tagType => {
        const methodName = simpleTagRegistry.get(tagType);
        if (!methodName) {
          missingMethods.push(tagType);
        } else if (typeof TagBuilder[methodName as keyof typeof TagBuilder] !== 'function') {
          missingMethods.push(`${tagType} (method exists but is not a function)`);
        }
      });

      expect(missingMethods).toEqual([]);
      if (missingMethods.length > 0) {
        throw new Error(
          `Missing TagBuilder methods for simple tags: ${missingMethods.join(', ')}\n` +
          `Add static method to TagBuilder class with @simpleTag(TagType.XXX) decorator`
        );
      }
    });

    it('every complex tag should have a TagBuilder method with @complexTag decorator', () => {
      const allTagTypes = Object.values(TagType);
      const complexTagTypes = allTagTypes.filter(t => !SIMPLE_TAG_TYPES.has(t));
      const complexTagRegistry = getComplexTagRegistry();
      const missingMethods: string[] = [];

      complexTagTypes.forEach(tagType => {
        const methodName = complexTagRegistry.get(tagType);
        if (!methodName) {
          missingMethods.push(tagType);
        } else if (typeof TagBuilder[methodName as keyof typeof TagBuilder] !== 'function') {
          missingMethods.push(`${tagType} (method exists but is not a function)`);
        }
      });

      expect(missingMethods).toEqual([]);
      if (missingMethods.length > 0) {
        throw new Error(
          `Missing TagBuilder methods for complex tags: ${missingMethods.join(', ')}\n` +
          `Add static method to TagBuilder class with @complexTag(TagType.XXX) decorator`
        );
      }
    });

    it('all simple TagBuilder methods should return correct tag type', () => {
      const simpleTagRegistry = getSimpleTagRegistry();
      simpleTagRegistry.forEach((methodName, expectedTagType) => {
        const tag = (TagBuilder[methodName as keyof typeof TagBuilder] as any)();
        expect(tag.tag).toBe(expectedTagType);
        expect(tag.tagName).toBeTruthy();
        expect(tag.value).toBeUndefined();
      });
    });
  });

  describe('StandardLocationId coverage', () => {
    it('recommended StandardLocationIds should have helper methods with @locationHelper decorator', () => {
      const recommendedLocationIds = [
        StandardLocationId.MAIN_ENTRANCE,
        StandardLocationId.EXIT,
        StandardLocationId.SINGLE_RIDER_ENTRANCE,
        StandardLocationId.FASTPASS_ENTRANCE,
        StandardLocationId.PHOTO_PICKUP,
        StandardLocationId.WHEELCHAIR_ACCESSIBLE_ENTRANCE,
      ];

      const locationHelperRegistry = getLocationHelperRegistry();
      const missingHelpers: string[] = [];

      recommendedLocationIds.forEach(locationId => {
        const methodName = locationHelperRegistry.get(locationId);
        if (!methodName) {
          missingHelpers.push(locationId);
        } else if (typeof TagBuilder[methodName as keyof typeof TagBuilder] !== 'function') {
          missingHelpers.push(`${locationId} (method exists but is not a function)`);
        }
      });

      expect(missingHelpers).toEqual([]);
      if (missingHelpers.length > 0) {
        throw new Error(
          `Missing TagBuilder helper methods for StandardLocationIds: ${missingHelpers.join(', ')}\n` +
          `Add helper methods to TagBuilder class with @locationHelper(StandardLocationId.XXX) decorator`
        );
      }
    });

    it('all location helper methods should return LOCATION tag with correct ID', () => {
      const locationHelperRegistry = getLocationHelperRegistry();
      locationHelperRegistry.forEach((methodName, expectedId) => {
        const tag = (TagBuilder[methodName as keyof typeof TagBuilder] as any)(28.4743, -81.4677);
        expect(tag.tag).toBe(TagType.LOCATION);
        expect(tag.id).toBe(expectedId);
        expect(tag.tagName).toBeTruthy();
        expect(tag.value).toEqual({latitude: 28.4743, longitude: -81.4677});
      });
    });

    it('all StandardLocationIds should use consistent prefix', () => {
      const allLocationIds = Object.values(StandardLocationId);
      const invalidIds: string[] = [];

      allLocationIds.forEach(locationId => {
        if (!locationId.startsWith('location-')) {
          invalidIds.push(locationId);
        }
      });

      expect(invalidIds).toEqual([]);
      if (invalidIds.length > 0) {
        throw new Error(
          `StandardLocationIds must start with 'location-': ${invalidIds.join(', ')}`
        );
      }
    });

    it('all StandardLocationIds should be lowercase with hyphens', () => {
      const allLocationIds = Object.values(StandardLocationId);
      const invalidFormat: string[] = [];

      allLocationIds.forEach(locationId => {
        // Should be lowercase with hyphens only
        if (!/^[a-z-]+$/.test(locationId)) {
          invalidFormat.push(locationId);
        }
      });

      expect(invalidFormat).toEqual([]);
      if (invalidFormat.length > 0) {
        throw new Error(
          `StandardLocationIds must be lowercase with hyphens only: ${invalidFormat.join(', ')}`
        );
      }
    });
  });

  describe('Helper checklist', () => {
    it('should provide clear instructions when adding new tags', () => {
      const instructions = `

      ✅ ADDING A NEW TAG TYPE - CHECKLIST

      Simple Tag (boolean presence):
      1. Add to TagType enum in tagTypes.ts
      2. Add to TAG_NAMES in tagTypes.ts
      3. Add to SIMPLE_TAG_TYPES in tagTypes.ts
      4. Add builder method with @simpleTag(TagType.XXX) decorator
      5. Add tests for the new tag
      (No manual mapping needed - decorator handles it!)

      Complex Tag (with value):
      1. Add to TagType enum in tagTypes.ts
      2. Add to TAG_NAMES in tagTypes.ts
      3. Add type interface in tagTypes.ts (e.g., MyTagValue)
      4. Add validator function in validators.ts
      5. Add case in validateTagValue switch statement
      6. Add builder method with @complexTag(TagType.XXX) decorator
      7. Add tests for the new tag
      (No manual mapping needed - decorator handles it!)

      Standard Location ID:
      1. Add to StandardLocationId enum in tagTypes.ts
      2. (Optional) Add helper method with @locationHelper(StandardLocationId.XXX) decorator
      3. (Optional) Add to recommendedLocationIds array in this test
      4. Add tests for the new location ID
      (No manual mapping needed - decorator handles it!)

      Run: npm test -- src/tags/__tests__/tagCompleteness.test.ts
      This test will catch any missing steps!
      `;

      // This test always passes - it just provides documentation
      expect(instructions).toBeTruthy();
    });
  });
});
