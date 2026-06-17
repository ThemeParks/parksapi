import {EnchantedParks} from './enchantedparks.js';
import {destinationController} from '../../destinationRegistry.js';
import type {DestinationConstructor} from '../../destination.js';

@destinationController({category: ['Enchanted Parks', 'Mid-America Parks']})
export class MidAmericaParks extends EnchantedParks {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'enchantedparks_midamericaparks',
        destinationName: 'Mid-America Parks',
        timezone: 'America/Chicago',
        ...(options?.config ?? {}),
      },
    });
    this.destinationLocation ??= {latitude: 38.5128, longitude: -90.6724};
    this.themePark ??= {
      id: 'enchantedparks_park_MAP',
      code: 'MAP',
      name: 'Mid-America Parks',
      ridesPath: 'attractions',
      scheduleCategory: 'Park Hours',
      location: {latitude: 38.5128, longitude: -90.6724},
    };
    this.waterPark ??= {
      id: 'enchantedparks_park_HH',
      code: 'HH',
      name: 'Hurricane Harbor',
      ridesPath: 'hurricane-harbor-water-park',
      scheduleCategory: 'Waterpark Hours',
      location: {latitude: 38.5128, longitude: -90.6724},
    };
  }
}
