import {EnchantedParks} from './enchantedparks.js';
import {destinationController} from '../../destinationRegistry.js';
import type {DestinationConstructor} from '../../destination.js';
import locations from './locations/worldsoffun.json' with {type: 'json'};

@destinationController({category: ['Enchanted Parks', 'Worlds of Fun']})
export class WorldsOfFun extends EnchantedParks {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'enchantedparks_worldsoffun',
        destinationName: 'Worlds of Fun',
        timezone: 'America/Chicago',
        ...(options?.config ?? {}),
      },
    });
    this.attractionLocations = locations;
    // Oceans of Fun rides appear under the "Worlds of Fun" site in the live
    // feed (prefixed "OOF -"); ride-name matching folds both into this one site.
    this.liveStatusSiteIds ??= ['86792ef7-20f2-417d-8efd-778d3c70ce0e']; // Worlds of Fun
    this.destinationLocation ??= {latitude: 39.1746, longitude: -94.4886};
    this.themePark ??= {
      id: 'enchantedparks_park_WOF',
      code: 'WOF',
      name: 'Worlds of Fun',
      ridesPath: 'attractions',
      scheduleCategory: 'Park Hours',
      location: {latitude: 39.1746, longitude: -94.4886},
    };
    this.waterPark ??= {
      id: 'enchantedparks_park_OOF',
      code: 'OOF',
      name: 'Oceans of Fun',
      ridesPath: 'oceans-of-fun',
      scheduleCategory: 'Waterpark Hours',
      location: {latitude: 39.1746, longitude: -94.4886},
    };
  }
}
