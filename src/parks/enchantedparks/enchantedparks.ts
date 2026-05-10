import {Destination, type DestinationConstructor} from '../../destination.js';
import {http, type HTTPObj} from '../../http.js';
import {cache} from '../../cache.js';
import config from '../../config.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';

export type ParkConfig = {
  /** Entity id, e.g. `enchantedparks_park_VF` */
  id: string;
  /** Display name */
  name: string;
  /** Path under `/rides-and-experiences/` whose page lists this park's attractions */
  ridesPath: string;
  /** Tribe Events category name that flags this park's operating-hours events (e.g. `Park Hours`, `Waterpark Hours`) */
  scheduleCategory: string;
};

@config
class EnchantedParks extends Destination {
  /** Subdomain root, e.g. `https://valleyfair.enchantedparks.com` (no trailing slash) */
  @config subdomain: string = '';
  /** Top-level destination id, e.g. `enchantedparks_valleyfair` */
  @config destinationId: string = '';
  /** Display name for the DESTINATION entity */
  @config destinationName: string = '';
  /** Optional theme-park child PARK */
  themePark?: ParkConfig;
  /** Optional water-park child PARK */
  waterPark?: ParkConfig;
  /** IANA timezone for the destination */
  @config timezone: string = 'America/Chicago';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('ENCHANTEDPARKS');
    // Apply themePark/waterPark from options.config since they aren't @config primitives.
    const cfg = (options?.config ?? {}) as Partial<EnchantedParks>;
    if (cfg.themePark) this.themePark = cfg.themePark;
    if (cfg.waterPark) this.waterPark = cfg.waterPark;
  }

  /** Cache-key prefix so multiple Enchanted Parks don't collide on shared cache keys. */
  getCacheKeyPrefix(): string {
    return `enchantedparks:${this.destinationId}`;
  }

  // ===== Public-API overrides =====

  async getDestinations(): Promise<Entity[]> {
    if (!this.destinationId) return [];
    return [{
      id: this.destinationId,
      name: this.destinationName,
      entityType: 'DESTINATION',
      timezone: this.timezone,
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    return [];
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    // No live wait-times source for Enchanted Parks until their app launches.
    return [];
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    return [];
  }
}

export {EnchantedParks};
