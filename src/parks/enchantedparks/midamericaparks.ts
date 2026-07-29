import {EnchantedParks} from './enchantedparks.js';
import {destinationController} from '../../destinationRegistry.js';
import type {DestinationConstructor} from '../../destination.js';
import locations from './locations/midamericaparks.json' with {type: 'json'};

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
    this.attractionLocations = locations;
    // Six Flags St. Louis is the "St Louis" site in the operator's live feed.
    this.liveStatusSiteIds ??= ['535e5890-11cb-4c95-ac07-a927c6af5398']; // St Louis
    this.destinationLocation ??= {latitude: 38.5128, longitude: -90.6724};
    this.themePark ??= {
      id: 'enchantedparks_park_MAP',
      code: 'MAP',
      name: 'Mid-America Parks',
      ridesPath: 'attractions',
      diningPath: 'dining',
      showsPath: 'live-entertainment',
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
