# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ParksAPI is a TypeScript library for fetching real-time theme park data (wait times, schedules, entities) from 50+ parks worldwide. Currently undergoing migration from JavaScript (`lib/`) to TypeScript (`src/`). The `ts` branch contains the new TypeScript implementation.

**Key Requirement:** Node 24+, npm 11+

## Common Commands

### Building and Testing
```bash
npm run build          # Compile TypeScript to dist/
npm run watch          # Auto-recompile on changes
npm run dev            # Run src/test.ts with .env loaded
npm test               # Run Jest tests
npm run test:watch     # Jest watch mode
npm run test:coverage  # Coverage report
```

### Development
- Use `tsx --env-file=.env <file>` to run TS files directly
- Manual test harness: `src/test.ts` (runs Universal Orlando fetch)
- Create `.env` file for API credentials (see Environment Variables section in README)

## Architecture

### Decorator-Based Design

The TypeScript implementation uses decorators for cross-cutting concerns:

#### 1. **@config** (`src/config.ts`)
Automatic configuration loading with priority: instance config → env vars → prefixed env vars → defaults.

```typescript
@config
class MyPark extends Destination {
  @config
  apiKey: string = "default";  // Loads from MYPARK_APIKEY env var

  constructor(options?) {
    super(options);
    this.addConfigPrefix('SHARED');  // Also checks SHARED_APIKEY
  }
}
```

**Class decorator:** Wraps instances in Proxy for property interception
**Property decorator:** Marks properties for config injection

#### 2. **@cache** (`src/cache.ts`)
SQLite-backed caching with TTL support. Database path: `./cache.sqlite` (override with `CACHE_DB_PATH`).

```typescript
@cache({ttlSeconds: 60 * 60 * 3})  // 3 hours
async getParks() { ... }

@cache({callback: (response) => response?.expiresIn || 3600})  // Dynamic TTL
async getAPIKey() { ... }
```

**Direct access:** `CacheLib.get()`, `CacheLib.set()`, `CacheLib.wrap()`

**🚨 CRITICAL: Cache Key Collisions in Base Classes**

When using `@cache` on methods in a base class that's shared by multiple instances (e.g., a framework base class for multiple parks), you MUST include instance-specific identifiers in the cache key to prevent cross-instance cache collisions.

**Default cache key:** `${className}:${methodName}:${JSON.stringify(args)}`

**Problem:** If multiple parks extend the same base class and call the same method with no arguments, they share the same cache entry!

**Solutions (in order of preference):**

1. **Implement `getCacheKeyPrefix()` method** (RECOMMENDED - cleanest approach):
```typescript
class AttractionsIOV3 extends Destination {
  parkId: string;

  // Implement cache key prefix method
  getCacheKeyPrefix(): string {
    return `attractionsio:${this.parkId}`;
  }

  // Now all cached methods automatically get the prefix!
  @cache({ttlSeconds: 60})
  async getWaitTimes(): Promise<WaitTime> {  // ✅ Auto-prefixed: attractionsio:1:AttractionsIOV3:getWaitTimes:[]
    const resp = await this.fetchWaitTimes();
    return await resp.json();
  }

  @cache({ttlSeconds: 60})
  async getTypesFromCategories(categories: string[], fieldFilter: string): Promise<number[]> {
    // ✅ Auto-prefixed with args: attractionsio:1:AttractionsIOV3:getTypesFromCategories:[["Rides"],"type"]
  }
}
```

2. **Set `cacheKeyPrefix` property** (simpler, less flexible):
```typescript
class MyPark extends Destination {
  constructor(options) {
    super(options);
    this.cacheKeyPrefix = `mypark:${this.parkId}`;  // ✅ All cached methods auto-prefixed
  }
}
```

3. **Pass unique argument** (if applicable):
```typescript
@cache({ttlSeconds: 60})
async getPOI(city: string): Promise<POIResponse> {  // ✅ city in args = unique cache key per city
  const resp = await this.fetchPOI(city);
  return await resp.json();
}
```

4. **Use custom cache key function** (verbose, last resort):
```typescript
@cache({ttlSeconds: 60, key: function() { return `attractionsio:${this.parkId}:waitTimes`; }})
async getWaitTimes(): Promise<WaitTime> {  // ⚠️ Works but verbose
  const resp = await this.fetchWaitTimes();
  return await resp.json();
}
```

**How prefix resolution works:**
1. If `getCacheKeyPrefix()` method exists, call it (can return string or Promise<string>)
2. Else if `cacheKeyPrefix` property exists, use it
3. Else no prefix (uses default class name)
4. Prefix is prepended to ALL cache keys (default, custom, or function-based)

**Real-world example of cache collision:**
- Cedar Point (parkId: 1) calls `getParkConfig()` → without prefix: `AttractionsIOV3:getParkConfig:[]` (COLLISION!)
- Knott's Berry Farm (parkId: 4) calls `getParkConfig()` → without prefix: `AttractionsIOV3:getParkConfig:[]` (COLLISION!)
- With `getCacheKeyPrefix()`: Cedar Point → `attractionsio:1:AttractionsIOV3:getParkConfig:[]` ✅
- With `getCacheKeyPrefix()`: Knott's → `attractionsio:4:AttractionsIOV3:getParkConfig:[]` ✅

**Reference implementations:**
- ✅ Universal: Uses `city` parameter in all cached methods (Solution 3)
- ✅ Cedar Fair: Uses `getCacheKeyPrefix()` method (Solution 1 - RECOMMENDED)

#### 3. **@http** (`src/http.ts`)
Queue-based HTTP request system with automatic retry, validation, and caching.

```typescript
@http({
  cacheSeconds: 180,
  retries: 3,
  validateResponse: {  // AJV JSON schema
    type: 'object',
    properties: { Results: { type: 'array' } },
    required: ['Results']
  }
})
async fetchParks(): Promise<HTTPObj> {
  return {
    method: 'GET',
    url: `${this.baseURL}/venues`,
    options: { json: true },
    tags: ['parks']  // For injector filtering
  } as HTTPObj;
}
```

**Key features:**
- Uses `node:http`/`node:https` for all requests (consistent behavior with/without proxy)
- Global queue processor (100ms interval)
- Rate limiting (250ms between requests)
- Request deduplication via cache keys
- Response callbacks: `onJson`, `onText`, `onBlob`, `onArrayBuffer`
- Built-in proxy support via Node.js 24+ Agent

#### 4. **@inject** (`src/injector.ts`)
Event-based dependency injection using Sift.js (MongoDB-like queries).

```typescript
@inject({
  eventName: 'httpRequest',
  hostname: 'api.example.com',
  tags: { $nin: ['skipAuth'] }  // Don't inject for these tags
})
async injectAuth(requestObj: HTTPObj) {
  const token = await this.getToken();
  requestObj.headers = {
    ...requestObj.headers,
    'Authorization': `Bearer ${token}`
  };
}
```

**Dynamic Filter Resolution:** Filter values can be functions that are resolved with instance context:

```typescript
@inject({
  eventName: 'httpRequest',
  hostname: function() {
    return { $regex: new RegExp(this.baseURL) };  // Access instance properties
  },
  tags: { $nin: ['skipAuth'] }
})
async injectAuth(requestObj: HTTPObj) {
  // Functions are resolved when event is broadcast
  // Supports both sync and async functions
}
```

**Scopes:** `broadcast('global', event, args)` or `broadcast(instance, event, args)`

#### 5. **@reusable** (`src/promiseReuse.ts`)
Promise reuse decorator to prevent duplicate execution of async methods.

```typescript
class MyPark extends Destination {
  // Reuse promise while pending (default)
  @reusable()
  async fetchData() {
    return await this.http('GET', `${this.baseURL}/data`);
  }

  // Cache result forever (singleton pattern)
  @reusable({forever: true})
  async init() {
    // This will only run once, even with multiple callers
    await this.setupConnection();
    return true;
  }
}
```

**How it works:**
- While a promise is pending, subsequent calls return the same promise
- After resolution (non-forever mode), new calls create new promises
- In `forever` mode, the result is cached permanently
- Errors always trigger cleanup (even in forever mode)
- Arguments are serialized for comparison (same args = same promise)

**Use cases:**
- Init methods that should only run once
- Avoiding duplicate API calls when multiple parts of code request the same data simultaneously
- Singleton pattern for data fetching

### Base Classes

#### **Destination** (`src/destination.ts`)
Abstract base class all parks extend using the **Template Method Pattern**.

**Public API (DO NOT OVERRIDE):**
- `getDestinations()` → `Entity[]` - Returns destination info
- `getEntities()` → `Entity[]` - Returns entities with **auto-resolved hierarchy** (parkId, destinationId)
- `getLiveData()` → `LiveData[]` - Returns live data (wait times, statuses)
- `getSchedules()` → `EntitySchedule[]` - Returns schedules (operating hours, show times)

**Protected API (IMPLEMENT IN SUBCLASSES):**
- `_init()` → `void` - Initialization hook (optional override)
- `buildEntityList()` → `Entity[]` - Build entities (framework auto-resolves hierarchy)
- `buildLiveData()` → `LiveData[]` - Build live data
- `buildSchedules()` → `EntitySchedule[]` - Build schedules

**Lifecycle:**
- `init()` is automatically called before any data retrieval method (`getEntities`, `getLiveData`, `getSchedules`)
- Override `_init()` to perform setup tasks (database connections, config loading, etc.)
- `init()` runs only once per instance, even with multiple calls (uses `@reusable({forever: true})`)

**Helper Methods:**
- `mapEntities<T>(items: T[], config: EntityMapperConfig<T>)` - Declarative entity mapping
- `resolveEntityHierarchy(entities: Entity[])` - Auto-set parkId/destinationId from parent chains

**Configuration:** Use `addConfigPrefix(prefix)` for environment variable namespacing.

**Example:**
```typescript
@config
class MyPark extends Destination {
  private db: Database;

  // Optional: override _init() for setup tasks
  protected async _init() {
    // Runs once per instance, before any data methods
    this.db = await connectToDatabase();
    await this.loadConfiguration();
  }

  // Implement protected methods, NOT public ones
  protected async buildEntityList(): Promise<Entity[]> {
    const parks = await this.fetchParks();

    // Use mapEntities helper for declarative mapping
    return this.mapEntities(parks, {
      idField: 'parkId',
      nameField: 'parkName',
      entityType: 'PARK',
      parentIdField: 'destinationId',
      locationFields: { lat: 'latitude', lng: 'longitude' },
      destinationId: 'mydestination',
      timezone: 'America/New_York',
      filter: (park) => park.isActive
    });

    // Hierarchy is automatically resolved - parkId/destinationId set by framework
  }
}
```

### Type System

#### **parkTypes.ts** (`src/parkTypes.ts`)
Re-exports all types from `@themeparks/typelib` plus project-specific enums:
- `AttractionType`: RIDE, SHOW, TRANSPORT, PARADE, MEET_AND_GREET, OTHER
- `QueueType`: STANDBY, SINGLE_RIDER, RETURN_TIME, BOARDING_GROUP, PAID_RETURN_TIME, PAID_STANDBY

**External types:** `Entity`, `LiveData`, `EntitySchedule`, `TagType` from `@themeparks/typelib`

#### **entities.d.ts** (`src/types/entities.d.ts`)
Basic entity type definitions. Prefer types from `@themeparks/typelib` when available.

### Utilities

#### **datetime.ts** (`src/datetime.ts`)
Zero-dependency date/time utilities using native Intl API (replaces moment-timezone):
- `formatInTimezone(date, timezone, format)` - Format dates in specific timezone
- `parseTimeInTimezone(timeStr, date, timezone)` - Parse time strings with timezone
- `formatUTC(date, format)` - Format dates in UTC
- `addDays(date, days)`, `isBefore(date1, date2)` - Date manipulation

#### **Proxy Support** (`src/proxy.ts`)
HTTP proxy injection for routing requests through third-party services or HTTP proxies.

**Supported proxy types:**
- **CrawlBase**: Route requests through CrawlBase API (for IP rotation, captcha solving)
- **Scrapfly**: Route requests through Scrapfly API (for browser rendering, captcha solving)
- **Basic HTTP(S) proxy**: Route through standard HTTP/HTTPS proxy using Node.js 24+ built-in proxy support

**Configuration Methods:**

1. **Global Configuration (Automatic)** - Applies to ALL destinations:
```bash
# Set GLOBAL_* environment variables
GLOBAL_CRAWLBASE='{"apikey":"YOUR_CRAWLBASE_TOKEN"}'
GLOBAL_SCRAPFLY='{"apikey":"YOUR_SCRAPFLY_KEY"}'
GLOBAL_BASICPROXY='{"proxy":"http://proxy.example.com:8080"}'
```
When any `GLOBAL_*` proxy environment variable is detected, proxy support is automatically enabled for all destinations on first instantiation. No code changes needed!

2. **Per-Destination Configuration** - Applies to specific destination:
```bash
# Set {PREFIX}_* environment variables
UNIVERSAL_CRAWLBASE='{"apikey":"YOUR_UNIVERSAL_TOKEN"}'
SIXFLAGS_SCRAPFLY='{"apikey":"YOUR_SIXFLAGS_KEY"}'
```

**Enable in destination:**
```typescript
@config
class MyPark extends Destination {
  constructor(options?) {
    super(options);
    this.addConfigPrefix('MYPARK');
    this.enableProxySupport(); // Checks MYPARK_CRAWLBASE, MYPARK_SCRAPFLY, etc.
  }
}
```

3. **Manual Global Enable** - Before creating any destinations:
```typescript
import {enableGlobalProxySupport} from './proxy';

enableGlobalProxySupport(); // Checks GLOBAL_* env vars
// Now create destinations...
```

**Priority Rules:**
- Proxy type priority: CrawlBase > Scrapfly > Basic proxy (only one proxy per request)
- Configuration priority: Per-destination config overrides global config (last loaded wins)

**Features:**
- ✅ Automatic global proxy detection
- ✅ Per-destination override capability
- ✅ Automatic URL rewriting for proxy services (CrawlBase, Scrapfly)
- ✅ Response unwrapping for services that wrap responses (e.g., Scrapfly)
- ✅ Basic HTTP(S) proxy using Node.js 24+ built-in `http.Agent` proxy support
- ✅ Uses existing @inject decorator for seamless integration
- ✅ Singleton pattern - configuration shared across all destinations

**Implementation Details:**
- All HTTP requests use `node:http`/`node:https` (`src/httpProxy.ts`) for consistency
- **CrawlBase/Scrapfly**: URL rewriting at proxy injection layer
- **Basic Proxy**: Uses Node.js 24+ `Agent` with `proxy` option
- Automatically detects proxy type and uses appropriate method
- Single HTTP implementation ensures consistent behavior with/without proxy
- All proxy types work seamlessly with caching, retries, and tracing

#### **Tag Validation System** (`src/tags/`)
Type-safe tag creation and validation for entity metadata (height restrictions, accessibility, etc.)

**TagBuilder API:**
```typescript
import {TagBuilder} from './tags/index.js';

// Simple tags (boolean presence)
const tags = [
  TagBuilder.paidReturnTime(),
  TagBuilder.singleRider(),
  TagBuilder.mayGetWet(),
  TagBuilder.onRidePhoto(),
  TagBuilder.childSwap(),
  TagBuilder.unsuitableForPregnantPeople(),
];

// Complex tags with values
const complexTags = [
  TagBuilder.minimumHeight(107, 'cm'),
  TagBuilder.maximumHeight(200, 'in'),
  TagBuilder.location(28.4743, -81.4677, 'Main Entrance'),  // tagName required
];

// Standard location helpers (with consistent IDs across all parks)
const locationTags = [
  TagBuilder.mainEntrance(28.4743, -81.4677),
  TagBuilder.exitLocation(28.4744, -81.4678),
  TagBuilder.singleRiderEntrance(28.4745, -81.4679),
  TagBuilder.fastPassEntrance(28.4746, -81.4680),
  TagBuilder.photoPickup(28.4747, -81.4681),
  TagBuilder.wheelchairAccessibleEntrance(28.4748, -81.4682),
];

// Custom tagName and id (for non-standard locations)
TagBuilder.paidReturnTime('Express Pass', 'express-123');
TagBuilder.location(28.4743, -81.4677, 'VIP Lounge', 'custom-vip-lounge');

// Validation
TagBuilder.validate(tag);           // Validate single tag
TagBuilder.validateAll(tags);       // Validate array

// Query all entities with single rider entrances across all parks
import {StandardLocationId} from './tags/index.js';

const entitiesWithSingleRider = entities.filter(entity =>
  entity.tags?.some(tag => tag.id === StandardLocationId.SINGLE_RIDER_ENTRANCE)
);
```

**Integration with Entity Mapper:**
```typescript
protected async buildEntityList(): Promise<Entity[]> {
  const rides = await this.fetchRides();

  return this.mapEntities(rides, {
    // ... other config
    transform: (entity, ride) => {
      entity.tags = [
        ride.hasExpressPass ? TagBuilder.paidReturnTime() : undefined,
        ride.minHeight ? TagBuilder.minimumHeight(ride.minHeight, 'cm') : undefined,
        ride.lat && ride.lng ? TagBuilder.location(ride.lat, ride.lng, 'Attraction Location') : undefined,
      ].filter(tag => tag !== undefined);
      return entity;
    }
  });
}
```

**Available Tag Types:**
- Simple: `PAID_RETURN_TIME`, `MAY_GET_WET`, `UNSUITABLE_PREGNANT`, `ONRIDE_PHOTO`, `SINGLE_RIDER`, `CHILD_SWAP`
- Complex: `LOCATION` (lat/lng), `MINIMUM_HEIGHT`, `MAXIMUM_HEIGHT` (height + unit)

**Standard Location Helpers (with consistent IDs):**
- `mainEntrance()` - Main entrance location
- `exitLocation()` - Exit location
- `singleRiderEntrance()` - Single rider queue entrance
- `fastPassEntrance()` - Express/fast pass entrance
- `photoPickup()` - On-ride photo pickup location
- `wheelchairAccessibleEntrance()` - Accessible entrance

Using standard helpers ensures consistent IDs across all parks, making it easy to query specific location types.

**Features:**
- ✅ Full TypeScript type safety
- ✅ Runtime validation with helpful error messages
- ✅ Auto-generated human-readable names
- ✅ Standard location IDs for cross-park consistency
- ✅ Completeness tests validate all tags are properly implemented
- ✅ Compatible with `@themeparks/typelib` TagData interface
- ✅ 405 comprehensive tests, 100% coverage

**Adding New Tags:**
See `src/tags/TAG_DEVELOPMENT_GUIDE.md` for step-by-step instructions. Use decorators (`@simpleTag`, `@complexTag`, `@locationHelper`) to automatically register tag methods - no manual mapping needed! The completeness tests will automatically verify you've implemented everything correctly.

## Implementation Patterns

### Adding a New Park

1. Create `src/parks/<parkname>/<parkname>.ts`
2. Extend `Destination` class
3. Apply `@config` decorator to class and config properties
4. Add `@config` decorated properties for API credentials
5. Use `addConfigPrefix()` in constructor for shared env vars
6. Implement HTTP methods with `@http` decorator
7. Add auth injection with `@inject` decorator if needed
8. **Implement protected methods (NOT public ones):**
   - `_init()` (optional override) - One-time initialization (database, config loading, etc.)
   - `getDestinations()` (optional override)
   - `buildEntityList()` - Build entities using `mapEntities()` helper
   - `buildLiveData()` - Build live data
   - `buildSchedules()` - Build schedules
9. Write tests in `src/parks/<parkname>/__tests__/`

**Reference implementation:** `src/parks/universal/universal.ts` (834 lines, fully typed)

**Key Pattern:**
```typescript
protected async buildEntityList(): Promise<Entity[]> {
  const parks = await this.fetchParks();
  const rides = await this.fetchRides();

  return [
    // Map parks using helper (declarative config)
    ...this.mapEntities(parks, {
      idField: 'id',
      nameField: 'name',
      entityType: 'PARK',
      parentIdField: () => 'mydestination',
      destinationId: 'mydestination',
      timezone: 'America/New_York'
    }),

    // Map rides
    ...this.mapEntities(rides, {
      idField: 'rideId',
      nameField: 'rideName',
      entityType: 'ATTRACTION',
      parentIdField: 'parkId',  // Framework auto-resolves hierarchy
      destinationId: 'mydestination',
      timezone: 'America/New_York',
      filter: (ride) => ride.isActive,
      transform: (entity, ride) => {
        // Custom transformations
        entity.tags = ride.tags;
        return entity;
      }
    })
  ];
  // No need to call resolveEntityHierarchy() - framework does it automatically!
}
```

### Common Patterns

**API Key Refresh:**
```typescript
@cache({callback: (resp) => resp?.expiresIn || 3600})
async getAPIKey() {
  const resp = await this.fetchAPIKey();
  return { apiKey: resp.json().token, expiresIn: 3600 };
}

@inject({eventName: 'httpRequest', hostname: 'api.park.com'})
async injectAPIKey(req: HTTPObj) {
  const {apiKey} = await this.getAPIKey();
  req.headers = {...req.headers, 'X-API-Key': apiKey};
}
```

**Wait Time Parsing:**
```typescript
protected async buildLiveData(): Promise<LiveData[]> {
  const resp = await this.fetchWaitTimes();
  const data = await resp.json();

  return data.rides.map(ride => ({
    entityId: String(ride.id),
    status: ride.isOpen ? 'OPERATING' : 'CLOSED',
    queue: {
      STANDBY: { waitTime: ride.waitMinutes || null }
    },
    lastUpdated: new Date().toISOString()
  }));
}
```

**Entity Mapping with Helper:**
```typescript
protected async buildEntityList(): Promise<Entity[]> {
  const attractions = await this.fetchAttractions();

  return this.mapEntities(attractions, {
    idField: 'Id',              // Field name (keyof T)
    nameField: 'DisplayName',   // Field name
    entityType: 'ATTRACTION',
    parentIdField: 'VenueId',   // Creates parent relationship
    locationFields: {           // Optional location
      lat: 'Latitude',
      lng: 'Longitude'
    },
    destinationId: 'mypark',
    timezone: 'America/New_York',
    filter: (attr) => attr.IsActive,  // Optional filter
    transform: (entity, source) => {  // Optional transform
      entity.tags = source.Tags;
      return entity;
    }
  });

  // parkId and destinationId are auto-resolved from parent chains!
}
```

## Testing

**Test Location:** `src/**/__tests__/**/*.test.ts`
**Config:** `jest.config.js` (uses `ts-jest` with ESM preset)
**Test Config:** `tsconfig.test.json` (extends main config)

**Test Coverage:** 88.84% overall (222 tests total)

**Core Library Coverage:**
- ✅ `cache.ts` - 100% coverage
- ✅ `config.ts` - 96.96% coverage
- ✅ `datetime.ts` - 100% coverage
- ✅ `destination.ts` - 85.07% coverage
- ✅ `http.ts` - 86.6% coverage
- ✅ `injector.ts` - 100% coverage
- ⚪ `parkTypes.ts` - 0% (type definitions only)

**Unit Tests:**
- `src/__tests__/cache.test.ts` - CacheLib and @cache decorator (35 tests, 100% coverage)
- `src/__tests__/config.test.ts` - @config decorator system (31 tests, 96.96% coverage)
- `src/__tests__/datetime.test.ts` - Date/time utilities with ISO 8601 timezone offset (53 tests, 100% coverage)
- `src/__tests__/mapEntities.test.ts` - Entity mapper helper (37 tests, 85.07% coverage)
- `src/__tests__/entityHierarchy.test.ts` - Entity hierarchy resolution (11 tests)
- `src/__tests__/injector.test.ts` - Event injection system (11 tests, 100% coverage)
- `src/__tests__/http.test.ts` - HTTP utility functions (30 tests)

**Integration Tests:**
- `src/__tests__/httpIntegration.test.ts` - HTTP library with local test server (14 tests, 86.6% coverage)
  - **Test Server:** Node.js HTTP server on port 9991
  - **Lifecycle:** Started in `beforeAll()`, stopped in `afterAll()` with `stopHttpQueue()`
  - **Tests:** GET/POST requests, headers, caching, validation, retries, callbacks

**Note on Coverage:**
- Parks implementations (`src/parks/**`) are excluded from coverage reports (integration-tested via manual harness)
- Run `npm run test:coverage` to see detailed coverage report

## Migration Status

**✅ Completed (TypeScript):**
- Core libraries: cache, config, http, injector, datetime (all comprehensively tested)
- Base classes: Destination (with Template Method Pattern)
- Helper utilities: Entity mapper, hierarchy resolver
- Parks: Universal Studios (complete, 834 lines)
- Tests: 222 tests total, 88.84% overall coverage
  - Core libraries at 85-100% coverage (cache, config, datetime, http, injector, destination)
  - Integration tests with local HTTP server
  - DateTime utilities with ISO 8601 timezone offset support

**🔄 Legacy (JavaScript in `lib/`):**
- 50+ park implementations (Disney, Six Flags, Cedar Point, etc.)
- Old base classes (destination.js, park.js, database.js)
- Multiple cache backends (Memory, LMDB, LevelDB)

**Migration Goal:** Port all parks from `lib/` to `src/`, maintain API compatibility with legacy implementations.

## Key Differences: Legacy vs TypeScript

| Feature | Legacy (lib/) | TypeScript (src/) |
|---------|--------------|-------------------|
| Config | Manual env checks | `@config` decorator |
| HTTP | Callback-based | Queue-based with `@http` |
| Caching | Multiple backends, `cache.wrap()` | SQLite, `@cache` decorator |
| Injection | Domain-based injectors | `@inject` with Sift queries |
| Types | JSDoc comments | Full TypeScript strict mode |
| Date/Time | moment-timezone | Native Intl API |

## Destination Registration

Destinations register automatically using the `@destinationController` decorator. ID and name are derived from class name:

```typescript
import {destinationController} from '../../destinationRegistry.js';

// Single category
@destinationController({ category: 'Universal' })
export class UniversalOrlando extends Destination {
  // ID: 'universalorlando'
  // Name: 'Universal Orlando'
}

// Multiple categories
@destinationController({ category: ['Six Flags', 'California'] })
export class SixFlagsMagicMountain extends Destination {
  // ID: 'sixflagsmagicmountain'
  // Name: 'Six Flags Magic Mountain'
}
```

**To add a new destination:**
1. Name your class descriptively (will become the display name)
2. Add `@destinationController({ category: 'YourCategory' })` decorator
3. Place file in `src/parks/` directory structure
4. Destination automatically discovered and appears in test harness with derived ID and name

**No manual imports needed** - the test harness automatically discovers all `.ts`/`.js` files in `src/parks/`

## Important Notes

- **Entity IDs:** Always strings, even if sourced from numbers
- **Template Method Pattern:** Implement `build*()` methods, NOT `get*()` methods (framework handles processing)
- **Hierarchy Resolution:** Automatic - parkId/destinationId resolved from parent chains
- **Entity Mapper:** Use `mapEntities()` for declarative entity mapping (reduces boilerplate)
- **HTTP Implementation:** Uses `node:http`/`node:https` for all requests (not `fetch`) to ensure consistency with proxy support
- **HTTP Queue:** Runs on global 100ms interval - may need optimization for high-volume use
- **Cache:** No size limits or automatic cleanup of expired entries
- **Config Lookup Order:** Instance config → `{CLASSNAME}_{PROPERTY}` → `{PREFIX}_{PROPERTY}` → default
- **TypeScript Config:** ES2022, strict mode, decorators enabled, ESM modules
- **No Slugs:** Removed from new implementation - use IDs directly
- **Tests Exit:** Manual tests exit after completion (not long-running service)

## API Documentation

Full API documentation available at: https://themeparks.github.io/parksapi/

## Support

General support for ThemeParks.wiki API only. This source code is self-service (sponsors get support benefits).

Most parks require API credentials not provided in this repo - you must source these yourself.
