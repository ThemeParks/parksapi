/**
 * Test Destination.getLocalizedString() helper
 */

import {Destination, EntityMapperConfig} from '../destination.js';
import {Entity, LocalisedString, LanguageCode} from '@themeparks/typelib';

// Mock destination class for testing getLocalizedString
class MockDestination extends Destination {
  async getDestinations(): Promise<Entity[]> {
    return [];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    return [];
  }

  protected async buildLiveData(): Promise<any[]> {
    return [];
  }

  protected async buildSchedules(): Promise<any[]> {
    return [];
  }

  // Expose protected getLocalizedString method for testing
  public testGetLocalizedString(
    value: LocalisedString,
    language?: LanguageCode,
    fallbackLanguage?: LanguageCode
  ): string {
    return this.getLocalizedString(value, language, fallbackLanguage);
  }

  // Expose language property for testing
  public setLanguage(lang: LanguageCode) {
    this.language = lang;
  }
}

describe('Destination.getLocalizedString()', () => {
  let destination: MockDestination;

  beforeEach(() => {
    destination = new MockDestination();
  });

  describe('Simple String Handling', () => {
    test('should return simple string as-is', () => {
      const result = destination.testGetLocalizedString('Space Mountain');
      expect(result).toBe('Space Mountain');
    });

    test('should return simple string regardless of language parameter', () => {
      const result = destination.testGetLocalizedString('Space Mountain', 'fr');
      expect(result).toBe('Space Mountain');
    });
  });

  describe('Multi-Language Object Handling', () => {
    test('should return exact language match', () => {
      const localized = {
        en: 'Space Mountain',
        fr: 'Space Mountain',
        de: 'Space Mountain'
      };

      expect(destination.testGetLocalizedString(localized, 'en')).toBe('Space Mountain');
      expect(destination.testGetLocalizedString(localized, 'fr')).toBe('Space Mountain');
      expect(destination.testGetLocalizedString(localized, 'de')).toBe('Space Mountain');
    });

    test('should fall back to base language (en-gb -> en)', () => {
      const localized = {
        en: 'Thunder Mountain',
        fr: 'Montagne du Tonnerre'
      };

      const result = destination.testGetLocalizedString(localized, 'en-gb' as LanguageCode);
      expect(result).toBe('Thunder Mountain');
    });

    test('should fall back to base language (en-us -> en)', () => {
      const localized = {
        en: 'Pirates of the Caribbean',
        nl: 'Piraten van het Caribisch Gebied'
      };

      const result = destination.testGetLocalizedString(localized, 'en-us' as LanguageCode);
      expect(result).toBe('Pirates of the Caribbean');
    });

    test('should fall back to default fallback language (en) when preferred not found', () => {
      const localized = {
        en: 'Big Thunder Mountain',
        fr: 'Big Thunder Mountain'
      };

      const result = destination.testGetLocalizedString(localized, 'de');
      expect(result).toBe('Big Thunder Mountain'); // Falls back to 'en'
    });

    test('should use custom fallback language when provided', () => {
      const localized = {
        fr: 'Montagne Russe',
        de: 'Achterbahn'
      };

      const result = destination.testGetLocalizedString(localized, 'es', 'fr');
      expect(result).toBe('Montagne Russe'); // Falls back to 'fr'
    });

    test('should return first available language when no match or fallback found', () => {
      const localized = {
        nl: 'De Efteling',
        de: 'Die Efteling'
      };

      const result = destination.testGetLocalizedString(localized, 'it');
      expect(['De Efteling', 'Die Efteling']).toContain(result);
    });

    test('should return empty string when object is empty', () => {
      const localized = {};

      const result = destination.testGetLocalizedString(localized);
      expect(result).toBe('');
    });
  });

  describe('Instance Language Config', () => {
    test('should use instance language when no language parameter provided', () => {
      destination.setLanguage('fr');

      const localized = {
        en: 'Space Mountain',
        fr: 'Space Mountain'
      };

      const result = destination.testGetLocalizedString(localized);
      expect(result).toBe('Space Mountain');
    });

    test('should override instance language when parameter provided', () => {
      destination.setLanguage('fr');

      const localized = {
        en: 'Thunder Mountain',
        de: 'Donnerbüchse'
      };

      const result = destination.testGetLocalizedString(localized, 'de');
      expect(result).toBe('Donnerbüchse');
    });

    test('should fall back from instance language base (en-gb -> en)', () => {
      destination.setLanguage('en-gb' as LanguageCode);

      const localized = {
        en: 'Pirates of the Caribbean',
        nl: 'Piraten van het Caribisch Gebied'
      };

      const result = destination.testGetLocalizedString(localized);
      expect(result).toBe('Pirates of the Caribbean');
    });
  });

  describe('Partial Language Coverage', () => {
    test('should handle missing preferred language with fallback', () => {
      const localized = {
        en: 'Haunted Mansion',
        nl: 'Spookhuis'
      };

      const result = destination.testGetLocalizedString(localized, 'ja', 'en');
      expect(result).toBe('Haunted Mansion');
    });

    test('should handle missing base language with fallback', () => {
      const localized = {
        fr: 'Château Hanté',
        de: 'Geisterschloss'
      };

      const result = destination.testGetLocalizedString(localized, 'en-gb' as LanguageCode, 'fr');
      expect(result).toBe('Château Hanté');
    });

    test('should return first available when all fallbacks fail', () => {
      const localized = {
        ja: '幽霊屋敷',
        ko: '유령의 집'
      };

      const result = destination.testGetLocalizedString(localized, 'es', 'en');
      expect(['幽霊屋敷', '유령의 집']).toContain(result);
    });
  });

  describe('Real-World Scenarios', () => {
    test('should handle Efteling-style multi-language (en priority, nl fallback)', () => {
      const localized = {
        en: 'Flying Dutchman',
        nl: 'De Vliegende Hollander'
      };

      // English speaker
      expect(destination.testGetLocalizedString(localized, 'en')).toBe('Flying Dutchman');

      // Dutch speaker
      expect(destination.testGetLocalizedString(localized, 'nl')).toBe('De Vliegende Hollander');

      // Other language - falls back to English
      expect(destination.testGetLocalizedString(localized, 'de')).toBe('Flying Dutchman');
    });

    test('should handle Disney-style multi-language (many languages)', () => {
      const localized = {
        en: 'It\'s a Small World',
        fr: 'It\'s a Small World',
        de: 'It\'s a Small World',
        es: 'It\'s a Small World',
        it: 'It\'s a Small World',
        nl: 'It\'s a Small World',
        ja: 'イッツ・ア・スモールワールド'
      };

      expect(destination.testGetLocalizedString(localized, 'en')).toBe('It\'s a Small World');
      expect(destination.testGetLocalizedString(localized, 'ja')).toBe('イッツ・ア・スモールワールド');
    });

    test('should handle Europa-Park style (German priority)', () => {
      destination.setLanguage('de');

      const localized = {
        de: 'Silver Star',
        en: 'Silver Star',
        fr: 'Silver Star'
      };

      const result = destination.testGetLocalizedString(localized);
      expect(result).toBe('Silver Star');
    });
  });
});
