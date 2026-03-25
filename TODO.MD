# ParksAPI TypeScript Migration TODO

This document tracks the migration of legacy JavaScript park implementations to the new TypeScript framework, and identifies missing features and opportunities for improvements.

## Current Status

**✅ Completed (TypeScript in `src/`):**
- Core libraries: cache, config, http, injector, datetime, proxy (fully tested, 85-100% coverage)
- Base classes: Destination (Template Method Pattern with auto-hierarchy resolution)
- Helper utilities: Entity mapper, hierarchy resolver, tag validation, multi-language support
- Virtual queue framework: Builder API, state helpers, validation, time windows (104 tests, 100% coverage)
- Parks: Universal Studios Orlando & Hollywood (871 lines)
- Parks: Cedar Fair / Attractions.io v3 (1023 lines) — 12 parks via API discovery
- Tests: 646 tests total, 29 test files, high coverage across all modules
- Tracing: Full HTTP tracing with AsyncLocalStorage context propagation
- Proxy support: CrawlBase, Scrapfly, basic HTTP(S) proxy with global/per-destination config
- HTTP: Unified `node:http`/`node:https` implementation for all requests (consistent with/without proxy)
- Injector: Priority-based execution, multiple transformers per event, sequential/parallel execution
- Multi-language: LocalisedString type, intelligent fallback logic, 11 supported languages

**🔄 Legacy (JavaScript in `lib/parks/`):**
- 75+ individual park destinations across 28 directories
- Old base classes (destination.js, park.js, database.js)
- Multiple specialized features and utilities

---

## Core Features Status

### ✅ Complete
- Tag validation system (`src/tags/`) — 405 tests, 100% coverage
- Global proxy injection (`src/proxy.ts`, `src/httpProxy.ts`) — 25 tests, 100% coverage
- Multi-language support (`src/destination.ts`) — 22 tests, 100% coverage
- Virtual queue framework (`src/virtualQueue/`) — 104 tests, 100% coverage
- Response transformation middleware (via `@inject` with priority ordering)
- Promise reuse (`@reusable()` decorator)
- Sieve/query support (using `sift.js` instead of legacy `mingo`)

### 🔲 Not Yet Ported
- [ ] Schedule data helpers (`lib/parks/scheduledata.js`) — review for reusable utilities
- [ ] Android APK version detection — used by Attractions.io v1, SeaWorld, Efteling
- [ ] Static POI data file loader — used by Efteling, potentially others

---

## Park Migration Status

### ✅ Phase 1: Core Frameworks — COMPLETE
All core decorator systems, utilities, and cross-cutting concerns are done.

### Phase 2: Major Destination Frameworks

These are "framework" migrations where one base class unlocks many parks:

#### ✅ Attractions.io v3 (Cedar Fair) — DONE
**TS File:** `src/parks/cedarfair/attractionsio.ts` (1023 lines)
**Parks:** Cedar Point, Knott's Berry Farm, Kings Island, Carowinds, Canada's Wonderland, California's Great America, Worlds of Fun, Michigan's Adventure, Kings Dominion, Valley Fair, Dorney Park, Knoebels

#### ✅ Universal — DONE
**TS File:** `src/parks/universal/universal.ts` (871 lines)
**Parks:** Universal Orlando (Studios + Islands of Adventure), Universal Hollywood

#### 🔲 Disney Parks (~12 parks)
**JS Files:** `lib/parks/wdw/`, `lib/parks/dlp/`, `lib/parks/shdr/`, `lib/parks/tdr/`
**Parks:** WDW (4 parks), Disneyland Resort (2), Disneyland Paris (2), Tokyo Disney (2), Hong Kong, Shanghai
**Complexity:** High — custom database classes, multiple API endpoints, DLP price data
**Recent JS changes:** Shanghai API update, DLP new attractions, show time parsing

**Action Items:**
- [ ] Migrate WDW base class + database layer
- [ ] Port DLP (separate API from WDW)
- [ ] Port Shanghai Disneyland
- [ ] Port Tokyo Disney Resort
- [ ] Port Hong Kong Disneyland

#### 🔲 Six Flags (~25+ parks)
**JS File:** `lib/parks/sixflags/sixflags.js`
**Complexity:** Medium — reimplemented in JS recently with new app API, dynamic park discovery
**Recent JS changes:** Full reimplementation, water parks support, timezone fix, HTML entity decoding

**Action Items:**
- [ ] Migrate Six Flags base class (new app API)
- [ ] Port auth token system (10-day caching)
- [ ] Port dynamic park discovery
- [ ] Test with all Six Flags parks

#### 🔲 Attractions.io v1 (Merlin/Legoland) (~17 parks)
**JS File:** `lib/parks/attractionsio/attractionsio.js`
**Parks:** Alton Towers, Thorpe Park, Chessington, Gardaland, Heide Park, Legoland (7 locations), Knoebels, Djurs Sommerland, Peppa Pig FL
**Complexity:** Medium — different API from v3, APK version detection needed

**Action Items:**
- [ ] Create v1 API base class (separate from v3)
- [ ] Port APK version detection utility
- [ ] Migrate all v1 parks

#### 🔲 SeaWorld / Busch Gardens (5 parks)
**JS File:** `lib/parks/seaworld/seaworld.js`
**Parks:** SeaWorld (Orlando, San Antonio, San Diego), Busch Gardens (Tampa, Williamsburg)
**Recent JS changes:** Slug removal

**Action Items:**
- [ ] Migrate SeaWorld destination class
- [ ] Port Android app version spoofing

#### 🔲 Parcs Reunidos (6 parks)
**JS File:** `lib/parks/parquesreuindos/parquesreunidos.js`
**Parks:** Movie Park Germany, Bobbejaanland, Mirabilandia, Parque de Atracciones Madrid, Parque Warner Madrid, Kennywood

**Action Items:**
- [ ] Migrate Parcs Reunidos base class
- [ ] Test all 6 parks

#### 🔲 TE2 — Australia (4 parks)
**JS File:** `lib/parks/te2/te2.js`
**Parks:** SeaWorld Gold Coast, Warner Bros Movie World, Paradise Country, Wet 'n' Wild Gold Coast
**Recent JS changes:** New destinations, location fallback

**Action Items:**
- [ ] Migrate TE2 base class
- [ ] Test all 4 parks

### Phase 3: European Independent Parks

Each is standalone, ~1 file each:

- [ ] **Efteling** (`lib/parks/efteling/efteling.js`) — multi-language, virtual queue, static POI files
- [ ] **Europa Park** (`lib/parks/europa/europapark.js` + `europaparkdb.js`) — custom DB, restaurant support, recent heavy JS updates
- [ ] **Parc Astérix** (`lib/parks/parcasterix/parcasterix.js`) — recent time format fixes
- [ ] **PortAventura** (`lib/parks/portaventura/portaventura.js`)
- [ ] **Phantasialand** (`lib/parks/phantasialand/phantasialand.js`) — recent opening times fix
- [ ] **Liseberg** (`lib/parks/liseberg/liseberg.js`)
- [ ] **Toverland** (`lib/parks/toverland/toverland.js`) — recent schedule fixes
- [ ] **Hansapark** (`lib/parks/hansapark/hansapark.js`)
- [ ] **Plopsa parks** (`lib/parks/plopsaland/plopsa.js`, `plopsadeutschland.js`)
- [ ] **Walibi parks** (`lib/parks/bellewaerde/walibiholland.js`) — Walibi Holland, Bellewaerde, Walibi Rhone Alpes, Walibi Belgium
- [ ] **Futuroscope** (`lib/parks/futuroscope/futuroscope.js`) — recent ID/version fixes
- [ ] **Paultons Park** (`lib/parks/paultons/paultonspark.js`)

### Phase 4: Asian Parks

- [ ] **Everland** (`lib/parks/everland/everland.js`)
- [ ] **Lotte World** (`lib/parks/lotteworld/lotteworld.js`)
- [ ] **Chimelong** (`lib/parks/chimelong/chimelong.js`)

### Phase 5: Regional US Parks

- [ ] **Herschend** (`lib/parks/herschend/herschendparks.js`) — Dollywood, Silver Dollar City
- [ ] **Hersheypark** (`lib/parks/hershey/hersheypark.js`)

---

## Suggested Next Steps

**Highest ROI framework migrations (each unlocks many parks):**
1. **Six Flags** — ~25+ parks, medium complexity, recently rewritten in JS
2. **Disney** — ~12 parks, high complexity, most-requested parks globally
3. **Attractions.io v1** — ~17 parks, medium complexity, needs APK version utility
4. **SeaWorld** — 5 parks, straightforward
5. **Parcs Reunidos** — 6 parks, straightforward

**Quick wins (standalone parks, 1 file each):**
- Efteling, Phantasialand, PortAventura — popular parks, simple implementations

---

## Feature Opportunities (Nice-to-Have)

- [ ] Per-domain rate limiting (current: global 250ms)
- [ ] Conditional retry logic (e.g., only retry on 5xx)
- [ ] Circuit breaker pattern
- [ ] Static POI data file loader
- [ ] Cache warming on startup
- [ ] ETag/If-Modified-Since support

---

## Documentation

- [x] ~~Multi-language support guide~~ — in CLAUDE.md
- [x] ~~Proxy configuration guide~~ — in CLAUDE.md
- [x] ~~Virtual queue system guide~~ — `src/virtualQueue/VIRTUAL_QUEUE_GUIDE.md`
- [x] ~~Tag development guide~~ — `src/tags/TAG_DEVELOPMENT_GUIDE.md`
- [ ] Migration guide for JS → TS parks
- [ ] Testing checklist for new parks

---

## Notes

**Total Parks in Legacy:** ~75+
**Total Parks in TypeScript:** ~14 (Universal 2 + Cedar Fair 12)
**Total Tests:** 646 (29 test files)
**Quick Wins:** Six Flags (many parks, recent JS rewrite to reference), SeaWorld, standalone European parks
