import {TagType, TAG_NAMES, SIMPLE_TAG_TYPES, isSimpleTag, isValidTagType} from '../tagTypes';

describe('Tag Types', () => {
  describe('TagType enum', () => {
    it('should have all expected tag types', () => {
      expect(TagType.LOCATION).toBe('LOCATION');
      expect(TagType.PAID_RETURN_TIME).toBe('PAID_RETURN_TIME');
      expect(TagType.MAY_GET_WET).toBe('MAY_GET_WET');
      expect(TagType.UNSUITABLE_PREGNANT).toBe('UNSUITABLE_PREGNANT');
      expect(TagType.MINIMUM_HEIGHT).toBe('MINIMUM_HEIGHT');
      expect(TagType.MAXIMUM_HEIGHT).toBe('MAXIMUM_HEIGHT');
      expect(TagType.ONRIDE_PHOTO).toBe('ONRIDE_PHOTO');
      expect(TagType.SINGLE_RIDER).toBe('SINGLE_RIDER');
      expect(TagType.CHILD_SWAP).toBe('CHILD_SWAP');
    });
  });

  describe('TAG_NAMES', () => {
    it('should have human-readable names for all tag types', () => {
      expect(TAG_NAMES[TagType.LOCATION]).toBe('Location');
      expect(TAG_NAMES[TagType.PAID_RETURN_TIME]).toBe('Paid Return Time');
      expect(TAG_NAMES[TagType.MAY_GET_WET]).toBe('May Get Wet');
      expect(TAG_NAMES[TagType.UNSUITABLE_PREGNANT]).toBe('Unsuitable for Pregnant People');
      expect(TAG_NAMES[TagType.MINIMUM_HEIGHT]).toBe('Minimum Height');
      expect(TAG_NAMES[TagType.MAXIMUM_HEIGHT]).toBe('Maximum Height');
      expect(TAG_NAMES[TagType.ONRIDE_PHOTO]).toBe('On-Ride Photo');
      expect(TAG_NAMES[TagType.SINGLE_RIDER]).toBe('Single Rider');
      expect(TAG_NAMES[TagType.CHILD_SWAP]).toBe('Child Swap');
    });

    it('should have a name for every tag type', () => {
      Object.values(TagType).forEach(tagType => {
        expect(TAG_NAMES[tagType]).toBeDefined();
        expect(TAG_NAMES[tagType]).not.toBe('');
      });
    });
  });

  describe('SIMPLE_TAG_TYPES', () => {
    it('should contain all simple tag types', () => {
      expect(SIMPLE_TAG_TYPES.has(TagType.PAID_RETURN_TIME)).toBe(true);
      expect(SIMPLE_TAG_TYPES.has(TagType.MAY_GET_WET)).toBe(true);
      expect(SIMPLE_TAG_TYPES.has(TagType.UNSUITABLE_PREGNANT)).toBe(true);
      expect(SIMPLE_TAG_TYPES.has(TagType.ONRIDE_PHOTO)).toBe(true);
      expect(SIMPLE_TAG_TYPES.has(TagType.SINGLE_RIDER)).toBe(true);
      expect(SIMPLE_TAG_TYPES.has(TagType.CHILD_SWAP)).toBe(true);
    });

    it('should not contain complex tag types', () => {
      expect(SIMPLE_TAG_TYPES.has(TagType.LOCATION)).toBe(false);
      expect(SIMPLE_TAG_TYPES.has(TagType.MINIMUM_HEIGHT)).toBe(false);
      expect(SIMPLE_TAG_TYPES.has(TagType.MAXIMUM_HEIGHT)).toBe(false);
    });
  });

  describe('isSimpleTag', () => {
    it('should return true for simple tags', () => {
      expect(isSimpleTag(TagType.PAID_RETURN_TIME)).toBe(true);
      expect(isSimpleTag(TagType.MAY_GET_WET)).toBe(true);
      expect(isSimpleTag(TagType.UNSUITABLE_PREGNANT)).toBe(true);
      expect(isSimpleTag(TagType.ONRIDE_PHOTO)).toBe(true);
      expect(isSimpleTag(TagType.SINGLE_RIDER)).toBe(true);
      expect(isSimpleTag(TagType.CHILD_SWAP)).toBe(true);
    });

    it('should return false for complex tags', () => {
      expect(isSimpleTag(TagType.LOCATION)).toBe(false);
      expect(isSimpleTag(TagType.MINIMUM_HEIGHT)).toBe(false);
      expect(isSimpleTag(TagType.MAXIMUM_HEIGHT)).toBe(false);
    });
  });

  describe('isValidTagType', () => {
    it('should return true for valid tag types', () => {
      expect(isValidTagType('LOCATION')).toBe(true);
      expect(isValidTagType('PAID_RETURN_TIME')).toBe(true);
      expect(isValidTagType('MAY_GET_WET')).toBe(true);
      expect(isValidTagType('MINIMUM_HEIGHT')).toBe(true);
    });

    it('should return false for invalid tag types', () => {
      expect(isValidTagType('INVALID')).toBe(false);
      expect(isValidTagType('FASTPASS')).toBe(false);
      expect(isValidTagType('fastpass')).toBe(false);
      expect(isValidTagType('')).toBe(false);
      expect(isValidTagType('123')).toBe(false);
    });
  });
});
