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
    // The Great Escape's water park is a separate site ("Whitewater Bay") in
    // the live feed; include both so its rides get status too.
    this.liveStatusSiteIds ??= [
      'd0437b8a-ca50-4fed-9f8e-fcd50b2af04b', // Great Escape
      'ca6dc180-e3ef-4151-9c12-6cea9c43204d', // Whitewater Bay
    ];
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
