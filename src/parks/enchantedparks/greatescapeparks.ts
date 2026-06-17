import {EnchantedParks} from './enchantedparks.js';
import {destinationController} from '../../destinationRegistry.js';
import type {DestinationConstructor} from '../../destination.js';
import locations from './locations/greatescapeparks.json' with {type: 'json'};

@destinationController({category: ['Enchanted Parks', 'Great Escape Parks']})
export class GreatEscapeParks extends EnchantedParks {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'enchantedparks_greatescapeparks',
        destinationName: 'Great Escape Parks',
        timezone: 'America/New_York',
        ...(options?.config ?? {}),
      },
    });
    this.attractionLocations = locations;
    this.destinationLocation ??= {latitude: 43.3506, longitude: -73.6889};
    this.themePark ??= {
      id: 'enchantedparks_park_GE',
      code: 'GE',
      name: 'The Great Escape',
      ridesPath: 'attractions',
      scheduleCategory: 'Park Hours',
      location: {latitude: 43.3506, longitude: -73.6889},
    };
    this.waterPark ??= {
      id: 'enchantedparks_park_HHGE',
      code: 'HHGE',
      name: 'Hurricane Harbor',
      ridesPath: 'hurricane-harbor-water-park',
      scheduleCategory: 'Waterpark Hours',
      location: {latitude: 43.3506, longitude: -73.6889},
    };
  }
}
