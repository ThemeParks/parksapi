import {EnchantedParks} from './enchantedparks.js';
import {destinationController} from '../../destinationRegistry.js';
import type {DestinationConstructor} from '../../destination.js';
import locations from './locations/michigansadventure.json' with {type: 'json'};

@destinationController({category: ['Enchanted Parks', 'Michigan\'s Adventure']})
export class MichigansAdventure extends EnchantedParks {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'enchantedparks_michigansadventure',
        destinationName: 'Michigan\'s Adventure',
        timezone: 'America/Detroit',
        ...(options?.config ?? {}),
      },
    });
    this.attractionLocations = locations;
    this.destinationLocation ??= {latitude: 43.3411, longitude: -86.2625};
    this.themePark ??= {
      id: 'enchantedparks_park_MA',
      code: 'MA',
      name: 'Michigan\'s Adventure',
      ridesPath: 'attractions',
      scheduleCategory: 'Park Hours',
      location: {latitude: 43.3411, longitude: -86.2625},
    };
    this.waterPark ??= {
      id: 'enchantedparks_park_WWA',
      code: 'WWA',
      name: 'WildWater Adventure',
      ridesPath: 'wildwater-adventure',
      scheduleCategory: 'Waterpark Hours',
      location: {latitude: 43.3411, longitude: -86.2625},
    };
  }
}
