import {EnchantedParks} from './enchantedparks.js';
import {destinationController} from '../../destinationRegistry.js';
import type {DestinationConstructor} from '../../destination.js';

@destinationController({category: ['Enchanted Parks', 'Galveston Island Waterpark']})
export class GalvestonIslandWaterpark extends EnchantedParks {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'enchantedparks_galvestonislandwaterpark',
        destinationName: 'Galveston Island Waterpark',
        timezone: 'America/Chicago',
        ...(options?.config ?? {}),
      },
    });
    this.destinationLocation ??= {latitude: 29.2767, longitude: -94.8231};
    // Water-park-only destination: the upstream site exposes a single
    // `/rides-and-experiences/attractions/` list under the "Waterpark Hours"
    // schedule category, with no separate theme-park surface. We register it
    // as the only park rather than splitting into theme/water.
    this.waterPark ??= {
      id: 'enchantedparks_park_GIWP',
      code: 'GIWP',
      name: 'Galveston Island Waterpark',
      ridesPath: 'attractions',
      scheduleCategory: 'Waterpark Hours',
      location: {latitude: 29.2767, longitude: -94.8231},
    };
  }
}
