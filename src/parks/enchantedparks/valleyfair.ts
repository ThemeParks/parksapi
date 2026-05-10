import {EnchantedParks} from './enchantedparks.js';
import {destinationController} from '../../destinationRegistry.js';
import type {DestinationConstructor} from '../../destination.js';

@destinationController({category: ['Enchanted Parks', 'Valleyfair']})
export class Valleyfair extends EnchantedParks {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        subdomain: 'https://valleyfair.enchantedparks.com',
        destinationId: 'enchantedparks_valleyfair',
        destinationName: 'Valleyfair',
        timezone: 'America/Chicago',
        ...(options?.config ?? {}),
      },
    });
    // themePark / waterPark are structured objects, not @config primitives, so
    // assign them directly here. The base class also reads options.config for
    // these if a caller wants to supply different ones — only set defaults
    // when the caller hasn't.
    this.themePark ??= {
      id: 'enchantedparks_park_VF',
      name: 'Valleyfair',
      ridesPath: 'attractions',
      scheduleCategory: 'Park Hours',
    };
    this.waterPark ??= {
      id: 'enchantedparks_park_VFW',
      name: 'Superior Shores Waterpark',
      ridesPath: 'superior-shores-waterpark',
      scheduleCategory: 'Waterpark Hours',
    };
  }
}
