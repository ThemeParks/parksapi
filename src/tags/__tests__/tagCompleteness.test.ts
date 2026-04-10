/**
 * Comprehensive validation tests to ensure all tags are properly implemented
 *
 * These tests catch common mistakes when adding new tags:
 * - Missing TAG_NAMES entries
 * - Missing SIMPLE_TAG_TYPES entries
 * - Missing validators for complex tags
 * - Missing TagBuilder methods
 * - Missing STANDARD_LOCATIONS helper methods
 */

import {TagType, TAG_NAMES, SIMPLE_TAG_TYPES, STANDARD_LOCATIONS, StandardLocationId} from '../tagTypes';
import {TagBuilder} from '../tagBuilder';
import {validateTagValue} from '../validators';
import {getSimpleTagRegistry, getComplexTagRegistry} from '../tagMetadata';

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

  describe('STANDARD_LOCATIONS coverage', () => {
    it('every entry in STANDARD_LOCATIONS should have a TagBuilder helper with the same name', () => {
      const missing: string[] = [];

      for (const key of Object.keys(STANDARD_LOCATIONS)) {
        const fn = (TagBuilder as any)[key];
        if (typeof fn !== 'function') {
          missing.push(key);
        }
      }

      expect(missing).toEqual([]);
      if (missing.length > 0) {
        throw new Error(
          `Missing TagBuilder helpers for STANDARD_LOCATIONS keys: ${missing.join(', ')}\n` +
          `Add a one-line static method to TagBuilder that delegates to standardLocation('<key>', lat, lng).`
        );
      }
    });

    it('every helper should return a LOCATION tag with the correct id and displayName', () => {
      for (const [key, {id, displayName}] of Object.entries(STANDARD_LOCATIONS)) {
        const tag = (TagBuilder as any)[key](28.4743, -81.4677);
        expect(tag.tag).toBe(TagType.LOCATION);
        expect(tag.id).toBe(id);
        expect(tag.tagName).toBe(displayName);
        expect(tag.value).toEqual({latitude: 28.4743, longitude: -81.4677});
      }
    });

    it('all standard location ids should use the location- prefix', () => {
      const invalidIds = Object.values(STANDARD_LOCATIONS)
        .map(loc => loc.id)
        .filter(id => !id.startsWith('location-'));
      expect(invalidIds).toEqual([]);
    });

    it('all standard location ids should be lowercase with hyphens', () => {
      const invalidFormat = Object.values(STANDARD_LOCATIONS)
        .map(loc => loc.id)
        .filter(id => !/^[a-z-]+$/.test(id));
      expect(invalidFormat).toEqual([]);
    });

    it('StandardLocationId convenience constant should mirror STANDARD_LOCATIONS ids', () => {
      for (const [key, {id}] of Object.entries(STANDARD_LOCATIONS)) {
        expect((StandardLocationId as any)[key]).toBe(id);
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

      Standard Location:
      1. Add an entry to STANDARD_LOCATIONS in tagTypes.ts (id + displayName)
      2. Add a one-line static method to TagBuilder that delegates to
         standardLocation('<yourKey>', lat, lng)
      3. The completeness test will fail until both are present.

      Run: npm test -- src/tags/__tests__/tagCompleteness.test.ts
      This test will catch any missing steps!
      `;

      // This test always passes - it just provides documentation
      expect(instructions).toBeTruthy();
    });
  });
});
