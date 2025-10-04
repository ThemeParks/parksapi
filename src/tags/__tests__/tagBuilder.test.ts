import {TagBuilder} from '../tagBuilder';
import {TagType, StandardLocationId} from '../tagTypes';

describe('TagBuilder', () => {
  describe('Simple tags', () => {
    it('should create paidReturnTime tag', () => {
      const tag = TagBuilder.paidReturnTime();
      expect(tag.tag).toBe(TagType.PAID_RETURN_TIME);
      expect(tag.tagName).toBe('Paid Return Time');
      expect(tag.value).toBeUndefined();
      expect(tag.id).toBeUndefined();
    });

    it('should create mayGetWet tag', () => {
      const tag = TagBuilder.mayGetWet();
      expect(tag.tag).toBe(TagType.MAY_GET_WET);
      expect(tag.tagName).toBe('May Get Wet');
      expect(tag.value).toBeUndefined();
    });

    it('should create unsuitableForPregnantPeople tag', () => {
      const tag = TagBuilder.unsuitableForPregnantPeople();
      expect(tag.tag).toBe(TagType.UNSUITABLE_PREGNANT);
      expect(tag.tagName).toBe('Unsuitable for Pregnant People');
      expect(tag.value).toBeUndefined();
    });

    it('should create onRidePhoto tag', () => {
      const tag = TagBuilder.onRidePhoto();
      expect(tag.tag).toBe(TagType.ONRIDE_PHOTO);
      expect(tag.tagName).toBe('On-Ride Photo');
      expect(tag.value).toBeUndefined();
    });

    it('should create singleRider tag', () => {
      const tag = TagBuilder.singleRider();
      expect(tag.tag).toBe(TagType.SINGLE_RIDER);
      expect(tag.tagName).toBe('Single Rider');
      expect(tag.value).toBeUndefined();
    });

    it('should create childSwap tag', () => {
      const tag = TagBuilder.childSwap();
      expect(tag.tag).toBe(TagType.CHILD_SWAP);
      expect(tag.tagName).toBe('Child Swap');
      expect(tag.value).toBeUndefined();
    });

    it('should accept custom tagName', () => {
      const tag = TagBuilder.paidReturnTime('Express Pass');
      expect(tag.tagName).toBe('Express Pass');
    });

    it('should accept custom id', () => {
      const tag = TagBuilder.paidReturnTime(undefined, 'custom-id-123');
      expect(tag.id).toBe('custom-id-123');
    });

    it('should accept both custom tagName and id', () => {
      const tag = TagBuilder.paidReturnTime('Lightning Lane', 'custom-id');
      expect(tag.tagName).toBe('Lightning Lane');
      expect(tag.id).toBe('custom-id');
    });
  });

  describe('Location tag', () => {
    it('should create location tag with valid coordinates and required name', () => {
      const tag = TagBuilder.location(28.4743, -81.4677, 'Main Entrance');
      expect(tag.tag).toBe(TagType.LOCATION);
      expect(tag.tagName).toBe('Main Entrance');
      expect(tag.value).toEqual({latitude: 28.4743, longitude: -81.4677});
    });

    it('should create location tag with different location names', () => {
      const entrance = TagBuilder.location(28.4743, -81.4677, 'Main Entrance');
      const exit = TagBuilder.location(28.4744, -81.4678, 'Exit');
      const singleRider = TagBuilder.location(28.4745, -81.4679, 'Single Rider Entrance');

      expect(entrance.tagName).toBe('Main Entrance');
      expect(exit.tagName).toBe('Exit');
      expect(singleRider.tagName).toBe('Single Rider Entrance');
    });

    it('should accept custom id', () => {
      const tag = TagBuilder.location(28.4743, -81.4677, 'Park Entrance', 'loc-123');
      expect(tag.id).toBe('loc-123');
      expect(tag.tagName).toBe('Park Entrance');
    });

    it('should throw if tagName is not provided', () => {
      // @ts-expect-error - Testing missing required parameter
      expect(() => TagBuilder.location(28.4743, -81.4677)).toThrow(
        'Location tag requires a human-readable name'
      );
    });

    it('should throw if tagName is empty string', () => {
      expect(() => TagBuilder.location(28.4743, -81.4677, '')).toThrow(
        'Location tag requires a human-readable name'
      );
    });

    it('should throw if tagName is whitespace only', () => {
      expect(() => TagBuilder.location(28.4743, -81.4677, '   ')).toThrow(
        'Location tag requires a human-readable name'
      );
    });

    it('should throw for invalid latitude', () => {
      expect(() => TagBuilder.location(NaN, -81.4677, 'Main Entrance')).toThrow('Invalid location tag value');
    });

    it('should throw for invalid longitude', () => {
      expect(() => TagBuilder.location(28.4743, NaN, 'Main Entrance')).toThrow('Invalid location tag value');
    });

    it('should accept edge case coordinates', () => {
      expect(() => TagBuilder.location(0, 0, 'Origin')).not.toThrow();
      expect(() => TagBuilder.location(-90, 180, 'South Pole')).not.toThrow();
      expect(() => TagBuilder.location(90, -180, 'North Pole')).not.toThrow();
    });
  });

  describe('Standard Location Helpers', () => {
    it('should create main entrance with standard ID', () => {
      const tag = TagBuilder.mainEntrance(28.4743, -81.4677);
      expect(tag.tag).toBe(TagType.LOCATION);
      expect(tag.tagName).toBe('Main Entrance');
      expect(tag.id).toBe(StandardLocationId.MAIN_ENTRANCE);
      expect(tag.value).toEqual({latitude: 28.4743, longitude: -81.4677});
    });

    it('should create exit with standard ID', () => {
      const tag = TagBuilder.exitLocation(28.4744, -81.4678);
      expect(tag.tag).toBe(TagType.LOCATION);
      expect(tag.tagName).toBe('Exit');
      expect(tag.id).toBe(StandardLocationId.EXIT);
    });

    it('should create single rider entrance with standard ID', () => {
      const tag = TagBuilder.singleRiderEntrance(28.4745, -81.4679);
      expect(tag.tag).toBe(TagType.LOCATION);
      expect(tag.tagName).toBe('Single Rider Entrance');
      expect(tag.id).toBe(StandardLocationId.SINGLE_RIDER_ENTRANCE);
    });

    it('should create fast pass entrance with standard ID', () => {
      const tag = TagBuilder.fastPassEntrance(28.4746, -81.4680);
      expect(tag.tag).toBe(TagType.LOCATION);
      expect(tag.tagName).toBe('Express Entrance');
      expect(tag.id).toBe(StandardLocationId.FASTPASS_ENTRANCE);
    });

    it('should create photo pickup with standard ID', () => {
      const tag = TagBuilder.photoPickup(28.4747, -81.4681);
      expect(tag.tag).toBe(TagType.LOCATION);
      expect(tag.tagName).toBe('Photo Pickup');
      expect(tag.id).toBe(StandardLocationId.PHOTO_PICKUP);
    });

    it('should create wheelchair accessible entrance with standard ID', () => {
      const tag = TagBuilder.wheelchairAccessibleEntrance(28.4748, -81.4682);
      expect(tag.tag).toBe(TagType.LOCATION);
      expect(tag.tagName).toBe('Wheelchair Accessible Entrance');
      expect(tag.id).toBe(StandardLocationId.WHEELCHAIR_ACCESSIBLE_ENTRANCE);
    });

    it('should allow querying by standard ID', () => {
      const tags = [
        TagBuilder.mainEntrance(28.4743, -81.4677),
        TagBuilder.singleRiderEntrance(28.4745, -81.4679),
        TagBuilder.exitLocation(28.4744, -81.4678),
      ];

      // Simulate querying all single rider entrances across all entities
      const singleRiderEntrances = tags.filter(
        tag => tag.id === StandardLocationId.SINGLE_RIDER_ENTRANCE
      );

      expect(singleRiderEntrances).toHaveLength(1);
      expect(singleRiderEntrances[0].tagName).toBe('Single Rider Entrance');
    });
  });

  describe('Minimum height tag', () => {
    it('should create minimum height tag in centimeters', () => {
      const tag = TagBuilder.minimumHeight(107, 'cm');
      expect(tag.tag).toBe(TagType.MINIMUM_HEIGHT);
      expect(tag.tagName).toBe('Minimum Height');
      expect(tag.value).toEqual({height: 107, unit: 'cm'});
    });

    it('should create minimum height tag in inches', () => {
      const tag = TagBuilder.minimumHeight(42, 'in');
      expect(tag.tag).toBe(TagType.MINIMUM_HEIGHT);
      expect(tag.value).toEqual({height: 42, unit: 'in'});
    });

    it('should accept custom tagName', () => {
      const tag = TagBuilder.minimumHeight(107, 'cm', 'Must be this tall');
      expect(tag.tagName).toBe('Must be this tall');
    });

    it('should accept custom id', () => {
      const tag = TagBuilder.minimumHeight(107, 'cm', undefined, 'height-min-123');
      expect(tag.id).toBe('height-min-123');
    });

    it('should throw for negative height', () => {
      expect(() => TagBuilder.minimumHeight(-10, 'cm')).toThrow('Invalid height tag value');
    });

    it('should throw for invalid unit', () => {
      // @ts-expect-error - Testing invalid input
      expect(() => TagBuilder.minimumHeight(107, 'meters')).toThrow('Invalid height tag value');
    });

    it('should throw for NaN height', () => {
      expect(() => TagBuilder.minimumHeight(NaN, 'cm')).toThrow('Invalid height tag value');
    });

    it('should accept zero height', () => {
      expect(() => TagBuilder.minimumHeight(0, 'cm')).not.toThrow();
    });
  });

  describe('Maximum height tag', () => {
    it('should create maximum height tag in centimeters', () => {
      const tag = TagBuilder.maximumHeight(200, 'cm');
      expect(tag.tag).toBe(TagType.MAXIMUM_HEIGHT);
      expect(tag.tagName).toBe('Maximum Height');
      expect(tag.value).toEqual({height: 200, unit: 'cm'});
    });

    it('should create maximum height tag in inches', () => {
      const tag = TagBuilder.maximumHeight(79, 'in');
      expect(tag.tag).toBe(TagType.MAXIMUM_HEIGHT);
      expect(tag.value).toEqual({height: 79, unit: 'in'});
    });

    it('should accept custom tagName', () => {
      const tag = TagBuilder.maximumHeight(200, 'cm', 'Cannot exceed this height');
      expect(tag.tagName).toBe('Cannot exceed this height');
    });

    it('should accept custom id', () => {
      const tag = TagBuilder.maximumHeight(200, 'cm', undefined, 'height-max-123');
      expect(tag.id).toBe('height-max-123');
    });

    it('should throw for negative height', () => {
      expect(() => TagBuilder.maximumHeight(-10, 'cm')).toThrow('Invalid height tag value');
    });

    it('should throw for invalid unit', () => {
      // @ts-expect-error - Testing invalid input
      expect(() => TagBuilder.maximumHeight(200, 'feet')).toThrow('Invalid height tag value');
    });

    it('should throw for NaN height', () => {
      expect(() => TagBuilder.maximumHeight(NaN, 'in')).toThrow('Invalid height tag value');
    });
  });

  describe('validate', () => {
    it('should validate simple tags', () => {
      const tag = TagBuilder.paidReturnTime();
      expect(TagBuilder.validate(tag)).toBe(true);
    });

    it('should validate location tags', () => {
      const tag = TagBuilder.location(28.4743, -81.4677, 'Main Entrance');
      expect(TagBuilder.validate(tag)).toBe(true);
    });

    it('should validate height tags', () => {
      const tag = TagBuilder.minimumHeight(107, 'cm');
      expect(TagBuilder.validate(tag)).toBe(true);
    });

    it('should throw for tags without tag property', () => {
      expect(() => TagBuilder.validate({tagName: 'Test'} as any)).toThrow(
        'Tag must have a "tag" property'
      );
    });

    it('should throw for tags without tagName property', () => {
      expect(() => TagBuilder.validate({tag: TagType.PAID_RETURN_TIME} as any)).toThrow(
        'Tag must have a "tagName" property'
      );
    });

    it('should throw for invalid tag values', () => {
      const invalidTag = {
        tag: TagType.LOCATION,
        tagName: 'Location',
        value: {latitude: 28.4743}, // missing longitude
      };
      expect(() => TagBuilder.validate(invalidTag)).toThrow('Invalid location tag value');
    });
  });

  describe('validateAll', () => {
    it('should validate array of valid tags', () => {
      const tags = [
        TagBuilder.paidReturnTime(),
        TagBuilder.location(28.4743, -81.4677, 'Main Entrance'),
        TagBuilder.minimumHeight(107, 'cm'),
      ];
      expect(TagBuilder.validateAll(tags)).toBe(true);
    });

    it('should throw for array with invalid tag', () => {
      const tags = [
        TagBuilder.paidReturnTime(),
        {tag: TagType.LOCATION, tagName: 'Location', value: {}}, // invalid value
      ];
      expect(() => TagBuilder.validateAll(tags)).toThrow('Tag at index 1 is invalid');
    });

    it('should work with empty array', () => {
      expect(TagBuilder.validateAll([])).toBe(true);
    });
  });

  describe('Real-world usage', () => {
    it('should create a complete set of tags for an attraction', () => {
      const tags = [
        TagBuilder.paidReturnTime(),
        TagBuilder.singleRider(),
        TagBuilder.mayGetWet(),
        TagBuilder.minimumHeight(107, 'cm'),
        TagBuilder.location(28.4743, -81.4677, 'Main Entrance'),
        TagBuilder.location(28.4744, -81.4678, 'Single Rider Entrance'),
        TagBuilder.location(28.4745, -81.4679, 'Exit'),
        TagBuilder.onRidePhoto(),
      ];

      expect(TagBuilder.validateAll(tags)).toBe(true);
      expect(tags).toHaveLength(8);
    });

    it('should allow filtering undefined tags', () => {
      const hasMinHeight = true;
      const hasMaxHeight = false;

      const tags = [
        TagBuilder.paidReturnTime(),
        hasMinHeight ? TagBuilder.minimumHeight(107, 'cm') : undefined,
        hasMaxHeight ? TagBuilder.maximumHeight(200, 'cm') : undefined,
      ].filter(tag => tag !== undefined);

      expect(tags).toHaveLength(2);
      expect(TagBuilder.validateAll(tags as any)).toBe(true);
    });

    it('should work in entity mapper transform', () => {
      // Simulating usage in mapEntities transform
      const sourceData = {
        hasExpressPass: true,
        minHeight: 107,
        maxHeight: null,
        lat: 28.4743,
        lng: -81.4677,
      };

      const tags = [
        sourceData.hasExpressPass ? TagBuilder.paidReturnTime() : undefined,
        sourceData.minHeight ? TagBuilder.minimumHeight(sourceData.minHeight, 'cm') : undefined,
        sourceData.maxHeight ? TagBuilder.maximumHeight(sourceData.maxHeight, 'cm') : undefined,
        sourceData.lat && sourceData.lng ? TagBuilder.location(sourceData.lat, sourceData.lng, 'Attraction Location') : undefined,
      ].filter((tag): tag is NonNullable<typeof tag> => tag !== undefined);

      expect(tags).toHaveLength(3);
      expect(TagBuilder.validateAll(tags)).toBe(true);
    });

    it('should support multiple location tags for different points', () => {
      // Example: attraction with entrance, exit, and single rider entrance
      const tags = [
        TagBuilder.location(28.4743, -81.4677, 'Main Entrance', 'entrance-main'),
        TagBuilder.location(28.4744, -81.4678, 'Exit', 'exit-main'),
        TagBuilder.location(28.4745, -81.4679, 'Single Rider Entrance', 'entrance-single-rider'),
        TagBuilder.location(28.4746, -81.4680, 'Photo Pickup', 'photo-pickup'),
      ];

      expect(tags).toHaveLength(4);
      tags.forEach(tag => {
        expect(tag.tag).toBe(TagType.LOCATION);
        expect(tag.tagName).toBeTruthy();
        expect(tag.id).toBeTruthy();
      });
      expect(TagBuilder.validateAll(tags)).toBe(true);
    });
  });
});
