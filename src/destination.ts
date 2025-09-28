import {LiveData, Entity, EntitySchedule} from "@themeparks/typelib";

// Base class for all destinations
export abstract class Destination {
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
