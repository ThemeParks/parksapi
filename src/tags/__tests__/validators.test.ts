import {
  isLocationValue,
  isHeightValue,
  validateTagValue,
  hasOnlyKeys,
} from '../validators';
import {TagType} from '../tagTypes';

describe('Tag Validators', () => {
  describe('isLocationValue', () => {
    it('should accept valid location values', () => {
      expect(isLocationValue({latitude: 28.4743, longitude: -81.4677})).toBe(true);
      expect(isLocationValue({latitude: 0, longitude: 0})).toBe(true);
      expect(isLocationValue({latitude: -90, longitude: 180})).toBe(true);
    });

    it('should reject invalid location values', () => {
      expect(isLocationValue(null)).toBe(false);
      expect(isLocationValue(undefined)).toBe(false);
      expect(isLocationValue({})).toBe(false);
      expect(isLocationValue({latitude: 28.4743})).toBe(false);
      expect(isLocationValue({longitude: -81.4677})).toBe(false);
      expect(isLocationValue({latitude: 28.4743, longitude: -81.4677, extra: 'field'})).toBe(false);
      expect(isLocationValue({latitude: '28.4743', longitude: -81.4677})).toBe(false);
      expect(isLocationValue({latitude: NaN, longitude: -81.4677})).toBe(false);
      expect(isLocationValue({latitude: 28.4743, longitude: NaN})).toBe(false);
    });
  });

  describe('isHeightValue', () => {
    it('should accept valid height values', () => {
      expect(isHeightValue({height: 107, unit: 'cm'})).toBe(true);
      expect(isHeightValue({height: 42, unit: 'in'})).toBe(true);
      expect(isHeightValue({height: 0, unit: 'cm'})).toBe(true);
    });

    it('should reject invalid height values', () => {
      expect(isHeightValue(null)).toBe(false);
      expect(isHeightValue(undefined)).toBe(false);
      expect(isHeightValue({})).toBe(false);
      expect(isHeightValue({height: 107})).toBe(false);
      expect(isHeightValue({unit: 'cm'})).toBe(false);
      expect(isHeightValue({height: 107, unit: 'cm', extra: 'field'})).toBe(false);
      expect(isHeightValue({height: '107', unit: 'cm'})).toBe(false);
      expect(isHeightValue({height: 107, unit: 'meters'})).toBe(false);
      expect(isHeightValue({height: -10, unit: 'cm'})).toBe(false);
      expect(isHeightValue({height: NaN, unit: 'cm'})).toBe(false);
    });
  });

  describe('validateTagValue', () => {
    describe('simple tags', () => {
      it('should not require values for simple tags', () => {
        expect(() => validateTagValue(TagType.PAID_RETURN_TIME, undefined)).not.toThrow();
        expect(() => validateTagValue(TagType.MAY_GET_WET, undefined)).not.toThrow();
        expect(() => validateTagValue(TagType.SINGLE_RIDER, undefined)).not.toThrow();
      });

      it('should accept any value for simple tags', () => {
        expect(() => validateTagValue(TagType.PAID_RETURN_TIME, 'anything')).not.toThrow();
        expect(() => validateTagValue(TagType.PAID_RETURN_TIME, 123)).not.toThrow();
        expect(() => validateTagValue(TagType.PAID_RETURN_TIME, {})).not.toThrow();
      });
    });

    describe('location tags', () => {
      it('should accept valid location values', () => {
        expect(() =>
          validateTagValue(TagType.LOCATION, {latitude: 28.4743, longitude: -81.4677})
        ).not.toThrow();
      });

      it('should throw for missing value', () => {
        expect(() => validateTagValue(TagType.LOCATION, undefined)).toThrow(
          'Tag type LOCATION requires a value'
        );
        expect(() => validateTagValue(TagType.LOCATION, null)).toThrow(
          'Tag type LOCATION requires a value'
        );
      });

      it('should throw for invalid location values', () => {
        expect(() => validateTagValue(TagType.LOCATION, {})).toThrow('Invalid location tag value');
        expect(() => validateTagValue(TagType.LOCATION, {latitude: 28.4743})).toThrow(
          'Invalid location tag value'
        );
        expect(() =>
          validateTagValue(TagType.LOCATION, {latitude: NaN, longitude: -81.4677})
        ).toThrow('Invalid location tag value');
      });
    });

    describe('height tags', () => {
      it('should accept valid height values', () => {
        expect(() => validateTagValue(TagType.MINIMUM_HEIGHT, {height: 107, unit: 'cm'})).not.toThrow();
        expect(() => validateTagValue(TagType.MAXIMUM_HEIGHT, {height: 42, unit: 'in'})).not.toThrow();
      });

      it('should throw for missing value', () => {
        expect(() => validateTagValue(TagType.MINIMUM_HEIGHT, undefined)).toThrow(
          'Tag type MINIMUM_HEIGHT requires a value'
        );
        expect(() => validateTagValue(TagType.MAXIMUM_HEIGHT, null)).toThrow(
          'Tag type MAXIMUM_HEIGHT requires a value'
        );
      });

      it('should throw for invalid height values', () => {
        expect(() => validateTagValue(TagType.MINIMUM_HEIGHT, {})).toThrow('Invalid height tag value');
        expect(() => validateTagValue(TagType.MINIMUM_HEIGHT, {height: 107})).toThrow(
          'Invalid height tag value'
        );
        expect(() => validateTagValue(TagType.MINIMUM_HEIGHT, {height: -10, unit: 'cm'})).toThrow(
          'Invalid height tag value'
        );
        expect(() => validateTagValue(TagType.MINIMUM_HEIGHT, {height: 107, unit: 'meters'})).toThrow(
          'Invalid height tag value'
        );
      });
    });
  });

  describe('hasOnlyKeys', () => {
    it('should return true for objects with exact keys', () => {
      expect(hasOnlyKeys({a: 1, b: 2}, ['a', 'b'])).toBe(true);
      expect(hasOnlyKeys({latitude: 28, longitude: -81}, ['latitude', 'longitude'])).toBe(true);
      expect(hasOnlyKeys({}, [])).toBe(true);
    });

    it('should return false for objects with missing keys', () => {
      expect(hasOnlyKeys({a: 1}, ['a', 'b'])).toBe(false);
      expect(hasOnlyKeys({}, ['a'])).toBe(false);
    });

    it('should return false for objects with extra keys', () => {
      expect(hasOnlyKeys({a: 1, b: 2, c: 3}, ['a', 'b'])).toBe(false);
      expect(hasOnlyKeys({a: 1}, [])).toBe(false);
    });

    it('should return false for non-objects', () => {
      expect(hasOnlyKeys(null, ['a'])).toBe(false);
      expect(hasOnlyKeys(undefined, ['a'])).toBe(false);
      expect(hasOnlyKeys('string', ['a'])).toBe(false);
      expect(hasOnlyKeys(123, ['a'])).toBe(false);
    });
  });
});
