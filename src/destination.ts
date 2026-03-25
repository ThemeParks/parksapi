import {LiveData, Entity, EntitySchedule, LocalisedString, LanguageCode, LiveQueue, ReturnTimeState, BoardingGroupState} from "@themeparks/typelib";
import {trace} from "./tracing.js";
import {reusable} from "./promiseReuse.js";
import {enableProxySupport as enableProxySupportLib} from "./proxy.js";
import {VQueueBuilder} from "./virtualQueue/builder.js";
import {calculateReturnWindow} from "./virtualQueue/timeWindows.js";
import {formatInTimezone} from "./datetime.js";

export type DestinationConstructor = {
  config?: {[key: string]: string | string[]};
};

/**
 * Configuration for mapping source data to Entity objects
 */
export type EntityMapperConfig<T> = {
  /** Field name or extractor function for entity ID */
  idField: keyof T | ((item: T) => string | number);

  /** Field name or extractor function for entity name (can return string or multi-language object) */
  nameField: keyof T | ((item: T) => LocalisedString);

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
  // Track if we've already enabled global proxies (static flag, shared across all destinations)
  private static globalProxiesEnabled = false;

  constructor(options?: DestinationConstructor) {
    // Apply any configuration options passed in
    if (options?.config) {
      this.config = options.config;
    }

    // Auto-enable global proxy configuration if GLOBAL_* env vars are set
    // Only check once (first destination instantiation)
    if (!Destination.globalProxiesEnabled) {
      Destination.globalProxiesEnabled = true;
      this.enableGlobalProxies();
    }
  }

  // Configuration options for the destination
  config: {[key: string]: string | string[]} = {};

  /**
   * Default language for localized strings
   * Can be overridden by subclasses or via {PREFIX}_LANGUAGE env var with @config decorator
   * @default 'en'
   */
  language: LanguageCode = 'en';

  /**
   * Timezone for this destination.
   * Subclasses should override this with the park's local timezone.
   * Used by virtual queue helpers to format dates in the park's timezone.
   * @default 'UTC'
   */
  timezone: string = 'UTC';

  /**
   * Optional cache key prefix for all cached methods.
   * When set, this prefix is prepended to all cache keys, preventing cache collisions
   * when multiple instances of the same base class exist (e.g., multiple parks using the same framework).
   *
   * Can be set directly as a string property, or implement getCacheKeyPrefix() method for dynamic prefixes.
   *
   * @example
   * ```typescript
   * class MyPark extends Destination {
   *   constructor(options) {
   *     super(options);
   *     this.cacheKeyPrefix = `mypark:${this.parkId}`;
   *   }
   * }
   * ```
   */
  cacheKeyPrefix?: string;

  /**
   * Optional method to dynamically generate a cache key prefix.
   * If implemented, this takes precedence over the cacheKeyPrefix property.
   * Can return a string or Promise<string>.
   *
   * @example
   * ```typescript
   * class MyPark extends Destination {
   *   getCacheKeyPrefix() {
   *     return `mypark:${this.parkId}`;
   *   }
   * }
   * ```
   */
  getCacheKeyPrefix?(): string | Promise<string>;

  /**
   * Enable global proxy configuration by checking for GLOBAL_* environment variables.
   * Called automatically on first destination instantiation.
   *
   * Checks for: GLOBAL_CRAWLBASE, GLOBAL_SCRAPFLY, GLOBAL_BASICPROXY
   */
  private enableGlobalProxies() {
    const hasGlobalProxy =
      process.env.GLOBAL_CRAWLBASE ||
      process.env.GLOBAL_SCRAPFLY ||
      process.env.GLOBAL_BASICPROXY;

    if (hasGlobalProxy) {
      enableProxySupportLib(['GLOBAL']);
    }
  }

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
   * Enable proxy support for this destination's HTTP requests.
   * Reads proxy configuration from environment variables using the destination's config prefixes.
   *
   * Supported proxy types:
   * - CrawlBase: {PREFIX}_CRAWLBASE='{"apikey":"YOUR_TOKEN"}'
   * - Scrapfly: {PREFIX}_SCRAPFLY='{"apikey":"YOUR_KEY"}'
   * - Basic HTTP(S) proxy: {PREFIX}_BASICPROXY='{"proxy":"http://proxy.example.com:8080"}'
   *
   * @example
   * ```typescript
   * constructor(options?: DestinationConstructor) {
   *   super(options);
   *   this.addConfigPrefix('UNIVERSAL');
   *   this.enableProxySupport(); // Will check UNIVERSAL_CRAWLBASE, UNIVERSAL_SCRAPFLY, etc.
   * }
   * ```
   */
  enableProxySupport() {
    const prefixes = Array.isArray(this.config.configPrefixes)
      ? this.config.configPrefixes as string[]
      : [];

    enableProxySupportLib(prefixes);
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
        const nameValue = getValue(item, config.nameField);
        const entity: Entity = {
          id: String(getValue(item, config.idField)),
          name: typeof nameValue === 'string' ? nameValue : nameValue as LocalisedString,
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
   * Get localized string value with fallback logic
   *
   * Handles both simple strings and multi-language objects. For multi-language objects,
   * uses intelligent fallback: tries exact match, then base language (en-gb -> en),
   * then fallback language, then first available.
   *
   * @param value LocalisedString (string or multi-language object)
   * @param language Preferred language code (defaults to instance language config)
   * @param fallbackLanguage Fallback language if preferred unavailable (defaults to 'en')
   * @returns Localized string value
   *
   * @example
   * ```typescript
   * // Simple string - returns as-is
   * this.getLocalizedString("Space Mountain") // => "Space Mountain"
   *
   * // Multi-language object with exact match
   * this.getLocalizedString({ en: "Space Mountain", fr: "Space Mountain" }, "fr")
   * // => "Space Mountain"
   *
   * // Multi-language with base language fallback
   * this.getLocalizedString({ en: "Space Mountain" }, "en-gb")
   * // => "Space Mountain" (falls back to 'en')
   * ```
   */
  protected getLocalizedString(
    value: LocalisedString,
    language?: LanguageCode,
    fallbackLanguage: LanguageCode = 'en'
  ): string {
    // Simple string case
    if (typeof value === 'string') {
      return value;
    }

    // Use instance language config if not specified
    const preferredLanguage = language || this.language;

    // Try exact match
    if (value[preferredLanguage]) {
      return value[preferredLanguage]!;
    }

    // Try base language (en-gb -> en)
    const baseLanguage = preferredLanguage.split('-')[0] as LanguageCode;
    if (value[baseLanguage]) {
      return value[baseLanguage]!;
    }

    // Try fallback language
    if (value[fallbackLanguage]) {
      return value[fallbackLanguage]!;
    }

    // Return first available language
    const values = Object.values(value) as (string | undefined)[];
    const firstValue = values.find(v => v !== undefined);
    return firstValue || '';
  }

  /**
   * Helper to build return time queue data
   *
   * Constructs a RETURN_TIME queue object with proper formatting.
   * Automatically formats dates in the destination's timezone.
   *
   * @param state Queue state (AVAILABLE, TEMP_FULL, or FINISHED)
   * @param returnStart Start time of return window (Date or ISO string)
   * @param returnEnd End time of return window (Date or ISO string)
   * @returns Return time queue object
   *
   * @example
   * ```typescript
   * // In buildLiveData()
   * liveData.queue!.RETURN_TIME = this.buildReturnTimeQueue(
   *   'AVAILABLE',
   *   new Date('2024-10-15T14:30:00'),
   *   new Date('2024-10-15T14:45:00')
   * );
   * ```
   */
  protected buildReturnTimeQueue(
    state: ReturnTimeState,
    returnStart: string | Date | null,
    returnEnd: string | Date | null
  ): NonNullable<LiveQueue['RETURN_TIME']> {
    return VQueueBuilder.returnTime()
      .state(state)
      .withWindow(
        returnStart ? this.formatDateInTimezone(returnStart) : null,
        returnEnd ? this.formatDateInTimezone(returnEnd) : null
      )
      .build();
  }

  /**
   * Helper to build paid return time queue data
   *
   * Constructs a PAID_RETURN_TIME queue object with pricing information.
   * Automatically formats dates in the destination's timezone.
   *
   * @param state Queue state (AVAILABLE, TEMP_FULL, or FINISHED)
   * @param returnStart Start time of return window (Date or ISO string)
   * @param returnEnd End time of return window (Date or ISO string)
   * @param currency Currency code (e.g., 'USD', 'EUR')
   * @param amountCents Price in cents (e.g., 1500 for $15.00)
   * @returns Paid return time queue object
   *
   * @example
   * ```typescript
   * // In buildLiveData() for Lightning Lane/Express Pass
   * liveData.queue!.PAID_RETURN_TIME = this.buildPaidReturnTimeQueue(
   *   'AVAILABLE',
   *   new Date('2024-10-15T14:30:00'),
   *   null,
   *   'USD',
   *   1500
   * );
   * ```
   */
  protected buildPaidReturnTimeQueue(
    state: ReturnTimeState,
    returnStart: string | Date | null,
    returnEnd: string | Date | null,
    currency: string,
    amountCents: number | null
  ): NonNullable<LiveQueue['PAID_RETURN_TIME']> {
    return VQueueBuilder.paidReturnTime()
      .state(state)
      .withWindow(
        returnStart ? this.formatDateInTimezone(returnStart) : null,
        returnEnd ? this.formatDateInTimezone(returnEnd) : null
      )
      .withPrice(currency, amountCents)
      .build();
  }

  /**
   * Helper to build boarding group queue data
   *
   * Constructs a BOARDING_GROUP queue object with allocation information.
   * Automatically formats dates in the destination's timezone.
   *
   * @param status Boarding group status (AVAILABLE, PAUSED, or CLOSED)
   * @param options Additional boarding group information
   * @returns Boarding group queue object
   *
   * @example
   * ```typescript
   * // In buildLiveData() for Rise of the Resistance
   * liveData.queue!.BOARDING_GROUP = this.buildBoardingGroupQueue('AVAILABLE', {
   *   currentGroupStart: 45,
   *   currentGroupEnd: 60,
   *   estimatedWait: 30
   * });
   * ```
   */
  protected buildBoardingGroupQueue(
    status: BoardingGroupState,
    options?: {
      currentGroupStart?: number | null;
      currentGroupEnd?: number | null;
      nextAllocationTime?: string | Date | null;
      estimatedWait?: number | null;
    }
  ): NonNullable<LiveQueue['BOARDING_GROUP']> {
    const builder = VQueueBuilder.boardingGroup().status(status);

    if (options?.currentGroupStart !== undefined && options?.currentGroupEnd !== undefined) {
      builder.currentGroups(options.currentGroupStart, options.currentGroupEnd);
    }
    if (options?.nextAllocationTime) {
      builder.nextAllocationTime(this.formatDateInTimezone(options.nextAllocationTime));
    }
    if (options?.estimatedWait !== undefined) {
      builder.estimatedWait(options.estimatedWait);
    }

    return builder.build();
  }

  /**
   * Calculate return window based on current wait time
   *
   * Common pattern for parks like Efteling where virtual queue window
   * is calculated as: now + waitTime to now + waitTime + windowDuration
   *
   * @param waitMinutes Wait time in minutes to add to base time
   * @param options Optional configuration
   * @returns Object with formatted start and end times
   *
   * @example
   * ```typescript
   * // In buildLiveData() for calculated return windows
   * const window = this.calculateReturnWindow(45, { windowMinutes: 15 });
   * liveData.queue!.RETURN_TIME = this.buildReturnTimeQueue(
   *   'AVAILABLE',
   *   window.start,
   *   window.end
   * );
   * ```
   */
  protected calculateReturnWindow(
    waitMinutes: number,
    options?: {
      baseTime?: Date;
      windowMinutes?: number;
    }
  ): { start: string; end: string } {
    return calculateReturnWindow({
      baseTime: options?.baseTime || new Date(),
      waitMinutes,
      windowDurationMinutes: options?.windowMinutes || 15,
      timezone: this.timezone,
    });
  }

  /**
   * Format date in park's timezone for virtual queue times
   * @private
   */
  private formatDateInTimezone(date: string | Date): string {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    return formatInTimezone(dateObj, this.timezone, 'iso');
  }

  /**
   * Initialize the destination
   *
   * This method is called automatically before any data retrieval methods
   * (getEntities, getLiveData, getSchedules). It runs only once per instance,
   * even if called multiple times, thanks to @reusable({forever: true}).
   *
   * Subclasses should override `_init()` instead of this method.
   *
   * @example
   * ```typescript
   * class MyPark extends Destination {
   *   protected async _init() {
   *     await this.connectToDatabase();
   *     await this.loadConfig();
   *   }
   * }
   * ```
   */
  @reusable({forever: true})
  protected async init(): Promise<void> {
    await this._init();
  }

  /**
   * Internal initialization hook for subclasses
   *
   * Override this method to provide custom initialization logic.
   * Called once per instance by `init()`.
   *
   * @protected
   */
  protected async _init(): Promise<void> {
    // Default: no initialization needed
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
   * This method automatically calls init() before fetching entities, and
   * calls resolveEntityHierarchy() on the returned entities to set parkId
   * and destinationId based on parent relationships.
   *
   * **To provide entities, implement buildEntityList() instead.**
   *
   * @final This method is final and should not be overridden.
   * @returns {Entity[]} List of entities with resolved hierarchy
   */
  @trace()
  async getEntities(): Promise<Entity[]> {
    await this.init();
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
   * This method automatically calls init() before fetching live data.
   * If you need to provide post-processing or validation of live data,
   * consider using the transform pattern in buildLiveData() instead.
   *
   * **To provide live data, implement buildLiveData() instead.**
   *
   * @final This method is final and should not be overridden.
   * @returns {LiveData[]} List of live data for entities
   */
  @trace()
  async getLiveData(): Promise<LiveData[]> {
    await this.init();
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
   * This method automatically calls init() before fetching schedules.
   * If you need to provide post-processing or validation of schedules,
   * consider using the transform pattern in buildSchedules() instead.
   *
   * **To provide schedules, implement buildSchedules() instead.**
   *
   * @final This method is final and should not be overridden.
   * @returns {EntitySchedule[]} List of schedules for entities
   */
  @trace()
  async getSchedules(): Promise<EntitySchedule[]> {
    await this.init();
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
