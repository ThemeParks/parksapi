# ParksAPI TypeScript Migration TODO

This document tracks the migration of legacy JavaScript park implementations to the new TypeScript framework, and identifies missing features and opportunities for improvements.

## Current Status

**✅ Completed (TypeScript in `src/`):**
- Core libraries: cache, config, http, injector, datetime, proxy (fully tested, 85-100% coverage)
- Base classes: Destination (Template Method Pattern with auto-hierarchy resolution)
- Helper utilities: Entity mapper, hierarchy resolver, tag validation, multi-language support
- Parks: Universal Studios Orlando & Hollywood (complete, 834 lines)
- Tests: 455 tests total, high coverage across all modules
- Tracing: Full HTTP tracing with AsyncLocalStorage context propagation
- Proxy support: CrawlBase, Scrapfly, basic HTTP(S) proxy with global/per-destination config
- HTTP: Unified `node:http`/`node:https` implementation for all requests (consistent with/without proxy)
- Injector: Priority-based execution, multiple transformers per event, sequential/parallel execution
- Multi-language: LocalisedString type, intelligent fallback logic, 11 supported languages

**🔄 Legacy (JavaScript in `lib/parks/`):**
- 50+ park implementations
- Old base classes (destination.js, park.js, database.js)
- Multiple specialized features and utilities

---

## Missing Core Features in TypeScript

### 1. Tag Validation System (`lib/parks/tags.js`)
**Status:** ✅ Implemented in TS (`src/tags/`)

**Features:**
- Tag validators for different tag types (location, height restrictions, etc.)
- Simple tags (boolean flags like fastPass, singleRider, childSwap, etc.)
- Complex tags with structured data (height with units, location with lat/lng)
- Tag validation: `isValidTag()`, `isValidTagType()`, `getValidTagObject()`

**TS Equivalent:**
- ✅ Full TypeScript implementation with `TagBuilder` class
- ✅ Type-safe tag creation with static methods
- ✅ Runtime validation with helpful error messages
- ✅ 405 comprehensive tests, 100% coverage
- ✅ Compatible with `@themeparks/typelib` TagData interface

**Action Items:**
- [x] Port tag validation system to TypeScript
- [x] Add to Entity mapper helpers
- [ ] ~~Create decorators for automatic tag validation~~ (not needed - TagBuilder is sufficient)
- [x] Add tag type guards (TypeScript type narrowing)

### 2. Global Proxy Injection (`lib/parks/globalinjections.js`)
**Status:** ✅ Implemented in TS (`src/proxy.ts`, `src/httpProxy.ts`)

**Features:**
- CrawlBase proxy support
- Scrapfly proxy support
- Basic HTTP(S) proxy support (using Node.js 24+ built-in proxy)
- Environment variable driven configuration
- Response transformation for proxy responses
- Global and per-destination configuration
- Automatic detection on first destination instantiation

**TS Equivalent:**
- ✅ Full TypeScript implementation with `ProxyInjector` singleton
- ✅ Integration with `@inject` decorator system
- ✅ Custom HTTP client using `node:http`/`node:https` for basic proxy
- ✅ 25 comprehensive tests, 100% coverage

**Action Items:**
- [x] Port proxy injection system to TypeScript
- [x] Add to HTTP library as optional middleware
- [x] Support env vars: `{PREFIX}_CRAWLBASE`, `{PREFIX}_SCRAPFLY`, `{PREFIX}_BASICPROXY`
- [x] Add response unwrapping for proxy responses
- [x] Add global configuration support via `GLOBAL_*` env vars

### 3. Schedule Data Helpers (`lib/parks/scheduledata.js`)
**Status:** Not reviewed yet

**Action Items:**
- [ ] Review `scheduledata.js` for utility functions
- [ ] Port any reusable schedule parsing/formatting utilities

### 4. Sieve/Mingo Query Support
**Status:** Different library used

**Legacy:** Uses `mingo` for MongoDB-style queries
**TS:** Uses `sift.js` for MongoDB-style queries

**Note:** Both libraries provide similar functionality. Existing TS implementation is sufficient.

---

## Park-Specific Patterns & Features

### Universal Parks

**File:** `lib/parks/universal/universal.js`, `universalbeijing.js`

**Status:** ✅ Already migrated to TypeScript!

**Features:**
- API key authentication with auto-refresh
- Virtual queue support
- Wait time aggregation from multiple sources
- Parks: Orlando, Hollywood, Beijing

### Attractions.io Framework

**Files:** `lib/parks/attractionsio/attractionsio.js`, `attractionsiov3.js`

**Key Features:**
- Generic framework for 50+ parks using Attractions.io API
- Park auto-discovery/enumeration (`enumerateResorts()`)
- Configurable category types (attractions, shows, dining)
- Android APK version detection
- Park entrance location detection
- Support for both v1 and v3 APIs

**Parks Using This:**
- Knott's Berry Farm
- Cedar Fair parks
- Other smaller regional parks

**Action Items:**
- [ ] Create TypeScript base class for Attractions.io
- [ ] Port v3 API support
- [ ] Port park enumeration utility
- [ ] Migrate all Attractions.io-based parks
- [ ] Document list of all Attractions.io park IDs

### Six Flags

**File:** `lib/parks/sixflags/sixflags.js`

**Key Features:**
- Auth token with 10-day caching
- Separate POI endpoints (rides, restaurants, shows)
- Park hours endpoint
- Response transformation injection

**Action Items:**
- [ ] Migrate Six Flags base class
- [ ] Port auth token system
- [ ] Test with all Six Flags parks

### SeaWorld / Busch Gardens

**File:** `lib/parks/seaworld/seaworld.js`

**Key Features:**
- Resort-based destination (multiple parks)
- Android app version spoofing
- 12-hour POI caching

**Action Items:**
- [ ] Migrate SeaWorld destination class
- [ ] Test with SeaWorld and Busch Gardens parks

### European Parks

#### Efteling
**File:** `lib/parks/efteling/efteling.js`

**Features:**
- Static POI data files (JSON)
- Multi-language support (en + nl)
- Virtual queue with time windows (15 min default)
- Cache version bumping for data invalidation

**Action Items:**
- [ ] Migrate Efteling
- [ ] Port multi-language POI merging logic
- [ ] Add POI data files to TS structure

#### Europa Park
**Files:** `lib/parks/europa/europapark.js`, `europaparkdb.js`

**Features:**
- Dedicated database class
- German-focused implementation

**Action Items:**
- [ ] Review Europa Park implementation
- [ ] Migrate to TypeScript

#### Other European Parks
- [ ] Parc Astérix (`lib/parks/parcasterix/parcasterix.js`)
- [ ] PortAventura (`lib/parks/portaventura/portaventura.js`)
- [ ] Phantasialand (`lib/parks/phantasialand/phantasialand.js`)
- [ ] Liseberg (`lib/parks/liseberg/liseberg.js`)
- [ ] Toverland (`lib/parks/toverland/toverland.js`)
- [ ] Hansapark (`lib/parks/hansapark/hansapark.js`)
- [ ] Plopsa parks (`lib/parks/plopsaland/plopsa.js`, `plopsadeutschland.js`)
- [ ] Bellewaerde / Walibi Holland (`lib/parks/bellewaerde/walibiholland.js`)
- [ ] Futuroscope (`lib/parks/futuroscope/futuroscope.js`)
- [ ] Parques Reunidos (`lib/parks/parquesreuindos/parquesreunidos.js`)
- [ ] Paultons Park (`lib/parks/paultons/paultonspark.js`)

### Asian Parks

- [ ] Everland (`lib/parks/everland/everland.js`)
- [ ] Lotte World (`lib/parks/lotteworld/lotteworld.js`)
- [ ] Chimelong (`lib/parks/chimelong/chimelong.js`)

### Herschend Family Entertainment

**File:** `lib/parks/herschend/herschendparks.js`

**Parks:** Dollywood, Silver Dollar City, etc.

**Action Items:**
- [ ] Review Herschend implementation
- [ ] Migrate to TypeScript

### Hersheypark

**File:** `lib/parks/hershey/hersheypark.js`

**Action Items:**
- [ ] Review Hersheypark implementation
- [ ] Migrate to TypeScript

---

## New Feature Opportunities

### 1. Enhanced Entity Relationships
**Description:** Auto-linking entities with parent/child relationships

**Example:**
- Attractions → Park → Destination
- Shows → Venue → Park
- Restaurants → Land → Park

**Benefit:** Makes querying and filtering easier

**Action Items:**
- [ ] Design entity graph system
- [ ] Add relationship resolvers to Entity mapper
- [ ] Create query helpers for traversing relationships

### 2. Multi-Language Support
**Status:** ✅ Fully implemented

**Description:** Systematic support for multiple languages

**Features:**
- ✅ Language-aware entity names (`LocalisedString` type)
- ✅ Fallback to English when native language unavailable
- ✅ Language preference via config (`language` property)
- ✅ Intelligent fallback logic (exact → base language → fallback → first available)
- ✅ Support for 11 languages (en, en-gb, en-us, de, fr, es, it, nl, ja, ko, zh)

**Seen In:** Efteling, Disney parks

**Implementation:**
- Entity.name can be string or `Record<LanguageCode, string>`
- `getLocalizedString()` helper method in Destination base class
- `language` config property (defaults to 'en', configurable via `{PREFIX}_LANGUAGE`)
- 22 comprehensive tests (18 localization, 4 mapEntities multi-language), 100% coverage

**Action Items:**
- [x] Design multi-language Entity structure - **DONE** (`LocalisedString` type in typelib)
- [x] Add language config to Destination base - **DONE** (`language` property with `@config`)
- [x] Create language fallback helpers - **DONE** (`getLocalizedString()` method)

### 3. Virtual Queue Framework
**Description:** Unified virtual queue/boarding group system

**Features:**
- Return time windows
- Boarding group distribution
- Queue state (AVAILABLE, TEMP_FULL, FINISHED)
- Next available slot tracking

**Seen In:** Disney, Universal, Efteling

**Action Items:**
- [ ] Design VirtualQueue type interface
- [ ] Add to LiveData structure
- [ ] Create helper methods for queue management

### 4. Park Auto-Discovery
**Description:** Automated discovery of parks using same API

**Features:**
- Enumerate parks by ID range
- Auto-detect park name and configuration
- Cache discovered parks

**Seen In:** Attractions.io v3

**Action Items:**
- [ ] Create generic discovery utility
- [ ] Add to CLI tools
- [ ] Document discovered parks

### 5. Android APK Version Detection
**Description:** Automatically fetch latest Android app version

**Benefit:** Stay up-to-date with mobile app changes without manual updates

**Seen In:** Attractions.io, SeaWorld, Efteling

**Action Items:**
- [ ] Create APK version utility
- [ ] Integrate with HTTP injection system
- [ ] Cache version lookups

### 6. Response Transformation Middleware
**Description:** Transform API responses before processing

**Use Cases:**
- Unwrap proxy responses (Scrapfly, CrawlBase)
- Normalize different API formats
- Extract nested data

**Seen In:** Six Flags, global injections

**Status:** ✅ Fully implemented
- ✅ Scrapfly response unwrapping implemented in proxy system
- ✅ Uses `@inject` with `httpResponse` event for transformations
- ✅ Multiple transformers per event with priority ordering
- ✅ Sequential execution by priority, parallel within same priority

**Action Items:**
- [x] Add response transformation to HTTP decorator - **DONE** (via @inject)
- [x] Support chaining multiple transformers - **DONE** (priority-based ordering)
- [x] Add to injector system - **DONE** (Scrapfly unwrapping uses this)

**Example:**
```typescript
class MyPark extends Destination {
  @inject({ eventName: 'httpResponse', priority: 1 })
  async unwrapProxy(req: HTTPObj) { /* ... */ }

  @inject({ eventName: 'httpResponse', priority: 5 })
  async normalizeData(req: HTTPObj) { /* ... */ }
}
```

### 7. Retry Strategies
**Description:** Configurable retry logic for different failure types

**Features:**
- Exponential backoff (already implemented)
- Conditional retries (only on certain errors)
- Circuit breaker pattern

**Current:**
- ✅ Exponential backoff with jitter implemented
- ✅ Configurable retry count per request
- ✅ Retry tracking in trace events
- ⚠️ No conditional retries or circuit breaker yet

**Action Items:**
- [ ] Add conditional retry logic (e.g., only retry on 5xx errors)
- [ ] Implement circuit breaker pattern
- [x] Add retry statistics to tracing - **DONE** (retryCount in trace events)

### 8. Rate Limiting
**Description:** Per-domain and per-park rate limiting

**Current:** Global 250ms delay between requests

**Action Items:**
- [ ] Add per-domain rate limiting
- [ ] Add burst allowance
- [ ] Make rate limits configurable per destination

### 9. Static POI Data Files
**Description:** Support for pre-fetched POI data

**Benefit:** Reduces API calls, faster testing

**Seen In:** Efteling (poi-feed-en.json, poi-feed-nl.json)

**Action Items:**
- [ ] Add static data loader to Destination base
- [ ] Create POI file format spec
- [ ] Add fallback to API when files missing

### 10. Cache Warming
**Description:** Pre-populate cache with commonly accessed data

**Action Items:**
- [ ] Add cache warming method to Destination
- [ ] Warm cache on server startup (optional)
- [ ] CLI command for cache warming

---

## Testing Priorities

### Unit Tests Needed
- [x] ~~Tag validation system~~ - **DONE!** (405 tests, 100% coverage)
- [ ] Proxy injection system
- [ ] Virtual queue helpers
- [x] ~~Multi-language fallback logic~~ - **DONE!** (22 tests, 100% coverage)
- [ ] APK version detection
- [ ] Rate limiting

### Integration Tests Needed
- [ ] Each migrated park implementation
- [ ] Multi-park destinations (Disney, SeaWorld)
- [ ] Proxy routing (if implemented)

### Manual Testing Checklist
Per park migration:
- [ ] Entities load correctly
- [ ] Live data shows wait times
- [ ] Schedules have operating hours
- [ ] Entity hierarchy is correct (parkId, destinationId)
- [ ] Location data is accurate
- [ ] Tags are properly formatted

---

## Migration Priority Order

### Phase 1: Core Framework Enhancements
1. [x] Tag validation system - **DONE!** (`src/tags/`, 405 tests, 100% coverage)
2. [x] Proxy injection system - **DONE!** (`src/proxy.ts`, 25 tests, 100% coverage)
3. [x] Promise reuse utilities - **DONE!** (`@reusable()` decorator)
4. [x] Multi-language support helpers - **DONE!** (`src/destination.ts`, 22 tests, 100% coverage)
5. [ ] Virtual queue framework

### Phase 2: Major Destinations
6. [ ] Six Flags framework
7. [ ] SeaWorld / Busch Gardens framework
8. [ ] Attractions.io v3 framework

### Phase 3: European Parks
9. [ ] Efteling
10. [ ] Europa Park
11. [ ] Parc Astérix
12. [ ] PortAventura
13. [ ] Phantasialand
14. [ ] Other smaller European parks (Liseberg, Toverland, etc.)

### Phase 4: Asian Parks
15. [ ] Everland
16. [ ] Lotte World
17. [ ] Chimelong

### Phase 5: Regional Parks
18. [ ] Herschend parks (Dollywood, Silver Dollar City)
19. [ ] Hersheypark
20. [ ] All Attractions.io-based parks

---

## Architecture Decisions to Make

### 1. Cache Strategies
**Question:** Should we support multiple cache backends?

**Current:** SQLite only

**Legacy:** Memory, LMDB, LevelDB, File

**Recommendation:** Keep SQLite, add Redis option for multi-instance deployments

### 2. Real-Time Updates
**Question:** How to handle live status updates?

**Options:**
- Polling (current approach)
- WebSocket connections
- Server-Sent Events (SSE)

**Recommendation:** Start with polling, add SSE/WebSocket support as needed

### 3. Configuration Management
**Question:** How to handle park-specific overrides?

**Current:** Config decorator with env vars

**Consideration:** Some parks may need JSON config files for complex static data

**Recommendation:** Support both env vars and config files

---

## Documentation Needed

- [ ] Migration guide for JS → TS parks
- [ ] Pattern library for common park implementations
- [ ] API mapping documentation (which parks use which APIs)
- [ ] Virtual queue system documentation
- [x] ~~Multi-language support guide~~ - **DONE!** (documented in CLAUDE.md)
- [x] ~~Proxy configuration guide~~ - **DONE!** (documented in CLAUDE.md)
- [ ] Cache strategy guide
- [ ] Testing checklist for new parks

---

## Performance Optimizations

- [ ] Batch entity processing
- [ ] Parallel HTTP requests where safe
- [ ] Stream large POI datasets instead of loading all in memory
- [ ] Add database indexes for faster entity lookups
- [ ] Implement ETag/If-Modified-Since support
- [ ] Add compression for cached responses

---

## Long-Term Vision

### API Compatibility Matrix
Create a matrix documenting which parks use which APIs:
- Attractions.io (v1, v3)
- Custom APIs (Disney, Universal, Six Flags, etc.)
- Shared infrastructure (SeaWorld parks, Cedar Fair parks)

### Automated Testing Infrastructure
- [ ] Automated daily tests against live APIs
- [ ] Alert on API changes
- [ ] Regression testing for all parks

### Developer Tools
- [ ] CLI tool for generating new park implementations
- [ ] Park implementation wizard
- [ ] API explorer/tester UI
- [ ] Cache inspector UI (already exists in web UI)
- [ ] Trace viewer UI (already exists in web UI)

---

## Notes

**Total Parks in Legacy:** ~50+
**Total Parks in TypeScript:** 2 (Universal Orlando, Universal Hollywood)
**Estimated Migration Effort:** 6-12 months for full migration

**Quick Wins:** Attractions.io-based parks (can migrate many at once with base class), Six Flags, SeaWorld
