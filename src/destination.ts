import {LiveData, Entity, EntitySchedule} from "@themeparks/typelib";

export type DestinationConstructor = {
  config?: {[key: string]: string | string[]};
};

/**
 * Configuration for mapping source data to Entity objects
 */
export type EntityMapperConfig<T> = {
  /** Field name or extractor function for entity ID */
  idField: keyof T | ((item: T) => string | number);

  /** Field name or extractor function for entity name */
  nameField: keyof T | ((item: T) => string);

  /** Entity type (DESTINATION, PARK, ATTRACTION, SHOW, RESTAURANT, etc.) */
  entityType: Entity['entityType'];

  /** Field name or extractor function for parent entity ID */
  parentIdField?: keyof T | ((item: T) => string | number | undefined);

  /** Location field mapping (latitude/longitude) */
  locationFields?: {
    lat: keyof T | ((item: T) => number | undefined);
    lng: keyof T | ((item: T) => number | undefined);
  };

  /** Timezone for the entity */
  timezone: string;

  /** Destination ID this entity belongs to */
  destinationId: string;

  /** Optional filter function to exclude items */
  filter?: (item: T) => boolean;

  /** Optional transform function for post-processing */
  transform?: (entity: Entity, sourceItem: T) => Entity;
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
   * Resolve entity hierarchy relationships (parkId and destinationId)
   *
   * Walks the parent chain for each entity to correctly set parkId and destinationId
   * based on ancestor types. This handles edge cases like:
   * - Attractions at destinations (no park) vs attractions at parks
   * - Hotels inside parks vs hotels at destinations
   * - Transport between parks vs transport within parks
   *
   * Rules:
   * - DESTINATION entities: no parent, no parkId, destinationId = self
   * - PARK entities: parent should be DESTINATION, no parkId
   * - All other entities: parkId = first PARK ancestor (if any), destinationId = first DESTINATION ancestor
   *
   * Validation:
   * - Throws error if circular parent references detected
   * - Throws error if any entity has no DESTINATION in parent chain
   * - Throws error if any PARK has no DESTINATION parent
   *
   * @param entities Array of entities to resolve
   * @returns Same array with parkId and destinationId correctly set
   * @throws {Error} If circular references or missing destination in hierarchy
   *
   * @example
   * ```typescript
   * async getEntities(): Promise<Entity[]> {
   *   const entities = [
   *     ...this.mapEntities(parks, ...),
   *     ...this.mapEntities(attractions, ...),
   *   ];
   *   return this.resolveEntityHierarchy(entities);
   * }
   * ```
   */
  protected resolveEntityHierarchy(entities: Entity[]): Entity[] {
    // Build lookup map for fast parent traversal
    const entityMap = new Map<string, Entity>();
    entities.forEach(e => entityMap.set(e.id, e));

    /**
     * Walk up parent chain to find first ancestor of given type(s)
     * Detects circular references
     */
    const findAncestor = (
      entityId: string,
      types: Entity['entityType'][]
    ): Entity | undefined => {
      let current = entityMap.get(entityId);
      const visited = new Set<string>();

      while (current) {
        // Detect circular references
        if (visited.has(current.id)) {
          throw new Error(
            `Circular parent reference detected in entity hierarchy for ${entityId}`
          );
        }
        visited.add(current.id);

        // Check if this is the type we're looking for
        if (types.includes(current.entityType)) {
          return current;
        }

        // Move to parent
        if (!current.parentId) break;
        current = entityMap.get(current.parentId);
      }

      return undefined;
    };

    // Resolve hierarchy for each entity
    entities.forEach(entity => {
      switch (entity.entityType) {
        case 'DESTINATION':
          // Destinations are roots - no parents
          entity.parentId = undefined;
          entity.parkId = undefined;
          entity.destinationId = entity.id;
          break;

        case 'PARK':
          // Parks should have destination parent, no parkId
          entity.parkId = undefined;
          const parkDestination = findAncestor(entity.id, ['DESTINATION']);
          if (parkDestination) {
            entity.destinationId = parkDestination.id;
          } else if (!entity.destinationId) {
            throw new Error(
              `Park entity ${entity.id} (${entity.name}) has no DESTINATION in parent chain. ` +
              `All parks must have a destination parent.`
            );
          }
          break;

        default:
          // All other entities - find park (optional) and destination (required)
          const park = findAncestor(entity.id, ['PARK']);
          const destination = findAncestor(entity.id, ['DESTINATION']);

          entity.parkId = park?.id;
          entity.destinationId = destination?.id || entity.destinationId;

          // Validation: all entities must have a destination
          if (!entity.destinationId) {
            throw new Error(
              `Entity ${entity.id} (${entity.name}, type: ${entity.entityType}) has no DESTINATION in parent chain. ` +
              `All entities must be part of a destination hierarchy.`
            );
          }
          break;
      }
    });

    return entities;
  }

  /**
   * Map array of source items to Entity objects
   *
   * Helper method to reduce boilerplate when converting API responses to Entity objects.
   * Provides declarative mapping configuration instead of manual object construction.
   *
   * Note: This method does NOT set parkId automatically. Use resolveEntityHierarchy()
   * after mapping all entities to correctly populate parkId and destinationId based on
   * the parent chain.
   *
   * @example
   * ```typescript
   * const entities = this.mapEntities(apiRides, {
   *   idField: 'Id',
   *   nameField: 'MblDisplayName',
   *   entityType: 'ATTRACTION',
   *   parentIdField: 'VenueId',
   *   locationFields: { lat: 'Latitude', lng: 'Longitude' },
   *   destinationId: 'universalorlando',
   *   timezone: 'America/New_York',
   *   filter: (ride) => ride.IsActive === true,
   * });
   * ```
   */
  protected mapEntities<T>(
    items: T[],
    config: EntityMapperConfig<T>
  ): Entity[] {
    // Helper: Extract value from a field name or extractor function
    const getValue = <R>(item: T, field: keyof T | ((item: T) => R)): R => {
      return typeof field === 'function' ? field(item) : (item[field] as any);
    };

    return items
      // Apply filter if provided
      .filter(item => config.filter?.(item) ?? true)

      // Map to entities
      .map(item => {
        // Build base entity with required fields
        const entity: Entity = {
          id: String(getValue(item, config.idField)),
          name: String(getValue(item, config.nameField)),
          entityType: config.entityType,
          destinationId: config.destinationId,
          timezone: config.timezone,
        } as Entity;

        // Add parent relationship if specified
        if (config.parentIdField) {
          const parentId = getValue(item, config.parentIdField);
          if (parentId !== undefined && parentId !== null) {
            entity.parentId = String(parentId);
          }
        }

        // Add location if fields specified and values exist
        if (config.locationFields) {
          const lat = getValue(item, config.locationFields.lat);
          const lng = getValue(item, config.locationFields.lng);

          if (lat !== undefined && lat !== null && lng !== undefined && lng !== null) {
            entity.location = {
              latitude: Number(lat),
              longitude: Number(lng),
            };
          }
        }

        // Apply custom transform if provided
        return config.transform ? config.transform(entity, item) : entity;
      });
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
   *
   * ⚠️ **DO NOT OVERRIDE THIS METHOD** ⚠️
   *
   * This method automatically calls resolveEntityHierarchy() on the returned entities
   * to set parkId and destinationId based on parent relationships.
   *
   * **To provide entities, implement buildEntityList() instead.**
   *
   * @final This method is final and should not be overridden.
   * @returns {Entity[]} List of entities with resolved hierarchy
   */
  async getEntities(): Promise<Entity[]> {
    const entities = await this.buildEntityList();
    return this.resolveEntityHierarchy(entities);
  }

  /**
   * Build the list of entities for this destination
   *
   * Subclasses should override this method to return their entities.
   * The returned entities will automatically have their parkId and destinationId
   * resolved based on the parent hierarchy.
   *
   * @returns {Entity[]} List of entities (hierarchy will be resolved automatically)
   */
  protected async buildEntityList(): Promise<Entity[]> {
    throw new Error("buildEntityList not implemented.");
  }

  /**
   * Get live data for all entities in this destination
   *
   * ⚠️ **DO NOT OVERRIDE THIS METHOD** ⚠️
   *
   * This method is final and should not be overridden. If you need to provide
   * post-processing or validation of live data, consider using the transform
   * pattern in buildLiveData() instead.
   *
   * **To provide live data, implement buildLiveData() instead.**
   *
   * @final This method is final and should not be overridden.
   * @returns {LiveData[]} List of live data for entities
   */
  async getLiveData(): Promise<LiveData[]> {
    return await this.buildLiveData();
  }

  /**
   * Build live data for all entities in this destination
   *
   * Subclasses should override this method to return live data (wait times,
   * operating status, showtimes, etc.) for their entities.
   *
   * @returns {LiveData[]} List of live data for entities
   */
  protected async buildLiveData(): Promise<LiveData[]> {
    throw new Error("buildLiveData not implemented.");
  }

  /**
   * Get schedules for all entities in this destination
   *
   * ⚠️ **DO NOT OVERRIDE THIS METHOD** ⚠️
   *
   * This method is final and should not be overridden. If you need to provide
   * post-processing or validation of schedules, consider using the transform
   * pattern in buildSchedules() instead.
   *
   * **To provide schedules, implement buildSchedules() instead.**
   *
   * @final This method is final and should not be overridden.
   * @returns {EntitySchedule[]} List of schedules for entities
   */
  async getSchedules(): Promise<EntitySchedule[]> {
    return await this.buildSchedules();
  }

  /**
   * Build schedules for all entities in this destination
   *
   * Subclasses should override this method to return operating hours,
   * show times, and other schedule information for their entities.
   *
   * @returns {EntitySchedule[]} List of schedules for entities
   */
  protected async buildSchedules(): Promise<EntitySchedule[]> {
    throw new Error("buildSchedules not implemented.");
  }
};
