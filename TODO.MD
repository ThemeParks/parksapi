# ParksAPI TypeScript Migration TODO

This document tracks the migration of legacy JavaScript park implementations to the new TypeScript framework, and identifies missing features and opportunities for improvements.

## Current Status

**✅ Completed (TypeScript in `src/`):**
- Core libraries: cache, config, http, injector, datetime (fully tested, 85-100% coverage)
- Base classes: Destination (Template Method Pattern with auto-hierarchy resolution)
- Helper utilities: Entity mapper, hierarchy resolver
- Parks: Universal Studios Orlando & Hollywood (complete, 834 lines)
- Tests: 222 tests total, 88.84% overall coverage
- Tracing: Full HTTP tracing with AsyncLocalStorage context propagation

**🔄 Legacy (JavaScript in `lib/parks/`):**
- 50+ park implementations
- Old base classes (destination.js, park.js, database.js)
- Multiple specialized features and utilities

---

## Missing Core Features in TypeScript

### 1. Database Class (`lib/parks/database.js`)
**Status:** Partially implemented in TS

**Features:**
- Singleton pattern via `static get()` method
- Scoped cache with version support (`cacheVersion` config)
- Entity filtering via `getEntities(filter)` and `findEntity(filter)`
- ✅ Promise reuse via `reusePromise` and `reusePromiseForever` - **Implemented as @reusable decorator!**
- `_init()` lifecycle hook
- HTTP domain injection with logging

**TS Equivalent:**
- We have basic caching but no Database abstraction
- ✅ Promise reuse pattern implemented as `@reusable()` decorator (`src/promiseReuse.ts`)
- No lifecycle hooks beyond constructor

**Action Items:**
- [ ] Evaluate if Database class is needed or if Destination suffices
- [x] ~~Implement promise reuse utilities if beneficial~~ - **DONE!** Use `@reusable()` decorator
- [ ] Add lifecycle hooks (`_init()`, `_cleanup()`) to Destination

### 2. Tag Validation System (`lib/parks/tags.js`)
**Status:** Not implemented in TS

**Features:**
- Tag validators for different tag types (location, height restrictions, etc.)
- Simple tags (boolean flags like fastPass, singleRider, childSwap, etc.)
- Complex tags with structured data (height with units, location with lat/lng)
- Tag validation: `isValidTag()`, `isValidTagType()`, `getValidTagObject()`

**TS Equivalent:**
- Types exist in `@themeparks/typelib` but no validation

**Action Items:**
- [ ] Port tag validation system to TypeScript
- [ ] Add to Entity mapper helpers
- [ ] Create decorators for automatic tag validation
- [ ] Add tag type guards (TypeScript type narrowing)

### 3. Global Proxy Injection (`lib/parks/globalinjections.js`)
**Status:** Not implemented in TS

**Features:**
- CrawlBase proxy support
- Scrapfly proxy support
- Basic HTTP(S) proxy support
- Environment variable driven configuration
- Response transformation for proxy responses

**TS Equivalent:**
- None

**Action Items:**
- [ ] Port proxy injection system to TypeScript
- [ ] Add to HTTP library as optional middleware
- [ ] Support env vars: `{PREFIX}_CRAWLBASE`, `{PREFIX}_SCRAPFLY`, `{PREFIX}_BASICPROXY`
- [ ] Add response unwrapping for proxy responses

### 4. Cache Decorators with String Syntax (`'@cache|60'`)
**Status:** Partially implemented

**Legacy Pattern:**
```javascript
async fetchData() {
  '@cache|60'; // cache for 60 minutes
  return data;
}
```

**TS Equivalent:**
```typescript
@cache({ttlSeconds: 60 * 60})
async fetchData() {
  return data;
}
```

**Action Items:**
- [x] TS decorator-based caching works (already implemented)
- [ ] Consider adding string syntax parser for easier migration (optional)

### 5. Schedule Data Helpers (`lib/parks/scheduledata.js`)
**Status:** Not reviewed yet

**Action Items:**
- [ ] Review `scheduledata.js` for utility functions
- [ ] Port any reusable schedule parsing/formatting utilities

### 6. Sieve/Mingo Query Support
**Status:** Different library used

**Legacy:** Uses `mingo` for MongoDB-style queries
**TS:** Uses `sift.js` for MongoDB-style queries

**Note:** Both libraries provide similar functionality. Existing TS implementation is sufficient.

---

## Park-Specific Patterns & Features

### Disney Parks (WDW, DLP, TDR, SHDR)

**File:** `lib/parks/wdw/waltdisneyworldbase.js` (+ database files)

**Key Features:**
- Virtual queue support (boarding groups)
- Genie+ integration
- Real-time live status updates via channels (`getFacilityStatusChannelID()`)
- Complex entity relationship handling
- Dedicated WDW database class (`wdwdb.js`, `wdwdatabase.js`)
- Override data for shows (`override_shows.js`)
- Soft delete support for entities
- Culture/language filtering

**Complexity:** High - Uses custom database, real-time channels, complex API

**Action Items:**
- [ ] Review WDW database architecture
- [ ] Understand real-time channel system
- [ ] Port virtual queue support to TS base class
- [ ] Port Genie+ integration
- [ ] Migrate WDW base class
- [ ] Migrate DLP (Disneyland Paris)
- [ ] Migrate TDR (Tokyo Disney Resort)
- [ ] Migrate SHDR (Shanghai Disney Resort)

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
**Description:** Systematic support for multiple languages

**Features:**
- Language-aware entity names
- Fallback to English when native language unavailable
- Language preference in API requests

**Seen In:** Efteling, Disney parks

**Action Items:**
- [ ] Design multi-language Entity structure
- [ ] Add language config to Destination base
- [ ] Create language fallback helpers

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

**Action Items:**
- [ ] Add response transformation to HTTP decorator
- [ ] Support chaining multiple transformers
- [ ] Add to injector system

### 7. Retry Strategies
**Description:** Configurable retry logic for different failure types

**Features:**
- Exponential backoff (already implemented)
- Conditional retries (only on certain errors)
- Circuit breaker pattern

**Current:** Basic retry with exponential backoff exists

**Action Items:**
- [ ] Add conditional retry logic
- [ ] Implement circuit breaker
- [ ] Add retry statistics to tracing

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
- [ ] Tag validation system
- [ ] Proxy injection system
- [ ] Virtual queue helpers
- [ ] Multi-language fallback logic
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
1. [ ] Tag validation system
2. [ ] Virtual queue framework
3. [ ] Multi-language support helpers
4. [ ] Proxy injection system
5. [ ] Promise reuse utilities (if needed)

### Phase 2: Major Destinations
6. [ ] Walt Disney World (high complexity)
7. [ ] Disneyland Paris
8. [ ] Tokyo Disney Resort
9. [ ] Shanghai Disney Resort
10. [ ] Six Flags framework
11. [ ] SeaWorld / Busch Gardens framework
12. [ ] Attractions.io v3 framework

### Phase 3: European Parks
13. [ ] Efteling
14. [ ] Europa Park
15. [ ] Parc Astérix
16. [ ] PortAventura
17. [ ] Phantasialand
18. [ ] Other smaller European parks (Liseberg, Toverland, etc.)

### Phase 4: Asian Parks
19. [ ] Everland
20. [ ] Lotte World
21. [ ] Chimelong

### Phase 5: Regional Parks
22. [ ] Herschend parks (Dollywood, Silver Dollar City)
23. [ ] Hersheypark
24. [ ] All Attractions.io-based parks

---

## Architecture Decisions to Make

### 1. Database Class vs Destination Class
**Question:** Do we need a separate Database abstraction?

**Options:**
- Keep everything in Destination (current approach)
- Create Database class for parks with complex data requirements (WDW, Europa Park)

**Considerations:**
- Destination works well for simple parks
- WDW has very complex database needs (may justify separate class)

### 2. Cache Strategies
**Question:** Should we support multiple cache backends?

**Current:** SQLite only

**Legacy:** Memory, LMDB, LevelDB, File

**Recommendation:** Keep SQLite, add Redis option for multi-instance deployments

### 3. Real-Time Updates
**Question:** How to handle live status updates (Disney channels)?

**Options:**
- Polling (current approach)
- WebSocket connections
- Server-Sent Events (SSE)

**Recommendation:** Start with polling, add SSE for Disney parks

### 4. Configuration Management
**Question:** How to handle park-specific overrides?

**Current:** Config decorator with env vars

**Consideration:** Some parks need JSON config files (override_shows.js for WDW)

**Recommendation:** Support both env vars and config files

---

## Documentation Needed

- [ ] Migration guide for JS → TS parks
- [ ] Pattern library for common park implementations
- [ ] API mapping documentation (which parks use which APIs)
- [ ] Virtual queue system documentation
- [ ] Multi-language support guide
- [ ] Proxy configuration guide
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

**Key Blocker:** Disney parks require understanding of real-time channel system and complex database architecture

**Quick Wins:** Attractions.io-based parks (can migrate many at once with base class), Six Flags, SeaWorld
