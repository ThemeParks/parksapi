import {LiveData, Entity, EntitySchedule} from "@themeparks/typelib";

export type DestinationConstructor = {
  config?: {[key: string]: string | string[]};
};

// Base class for all destinations
export abstract class Destination {
  constructor(options?: DestinationConstructor) {
    // Apply any configuration options passed in
    if (options?.config) {
      this.config = options.config;
    }
  }

  // Configuration options for the destination
  config: {[key: string]: string | string[]} = {};

  /**
   * Add a prefix to use when looking up config values from environment variables
   * or config object. This allows multiple destinations to co-exist in the same
   * environment without clashing on config keys.
   * @param prefix Prefix to add to config lookups (e.g. 'UNIVERSAL' to check UNIVERSAL_<KEY> env vars)
   */
  addConfigPrefix(prefix: string) {
    if (!Array.isArray(this.config.configPrefixes)) {
      this.config.configPrefixes = [];
    }
    (this.config.configPrefixes as string[]).push(prefix);
  }

  /**
   * Get all destinations this class supports
   * @returns {Entity[]} List of destinations
   */
  async getDestinations(): Promise<Entity[]> {
    throw new Error("getDestinations not implemented.");
  }

  /**
   * Get all entities (parks, attractions, dining, shows, hotels) for this destination
   * @returns {Entity[]} List of entities
   */
  async getEntities(): Promise<Entity[]> {
    throw new Error("getEntities not implemented.");
  }

  /**
   * Get live data for all entities in this destination
   * @returns {LiveData[]} List of live data for entities
   */
  async getLiveData(): Promise<LiveData[]> {
    throw new Error("getLiveData not implemented.");
  }

  /**
   * Get schedules for all entities in this destination
   * @returns {EntitySchedule[]} List of schedules for entities
   */
  async getSchedules(): Promise<EntitySchedule[]> {
    throw new Error("getSchedules not implemented.");
  }

  // TODO - http injector

};
