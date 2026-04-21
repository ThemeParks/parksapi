# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ParksAPI is a TypeScript library for fetching real-time theme park data (wait times, schedules, entities) from 75+ park implementations, serving ~118 destination entities worldwide. All park implementations live in `src/parks/`.

**Key Requirement:** Node 24+, npm 11+

### Skills & Agents

Detailed implementation guides live in `.claude/` — always check these before writing park code:

- **`.claude/skills/implementing-parks.md`** — Complete guide for building new park destinations: scaffold, decorators, entity mapping, live data, schedules, validation workflow, tips & tricks, and 12 reference implementations
- **`.claude/agents/park-ts-migrator.md`** — Agent for migrating JS park implementations to TypeScript

## Common Commands

```bash
npm run build          # Compile TypeScript to dist/
npm run watch          # Auto-recompile on changes
npm run dev            # Test all parks via harness
npm run dev -- <id>    # Test specific park (e.g. universalorlando)
npm run dev -- --list  # List available park IDs
npm test               # Run Vitest tests
npm run test:coverage  # Coverage report
npm run health         # Health check all endpoints
npm run har -- <file>  # Analyse HAR capture
```

## Architecture

### Decorator-Based Design

#### **@config** (`src/config.ts`)
Automatic configuration loading. Priority: instance config > env vars > prefixed env vars > defaults.

**Property decorator** marks properties for config injection. **`@destinationController` auto-applies the class-level `@config`** — never add `@config` to a class that uses `@destinationController`.

```typescript
@destinationController({category: 'MyCategory'})
export class MyPark extends Destination {
  @config apiKey: string = '';       // Reads MYPARK_APIKEY env var
  @config timeout: number = 5000;    // Reads MYPARK_TIMEOUT, coerced to number
  @config enabled: boolean = true;   // Reads MYPARK_ENABLED, coerced to boolean

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('MYPARK');   // Also checks MYPARK_* env vars
  }
}
```

**Type coercion:** Env vars are strings, but `@config` automatically coerces to match the default value's type:
- `number` defaults: parsed via `Number()`, falls back to default if `NaN`
- `boolean` defaults: case-insensitive `"true"`/`"1"` → `true`, else `false`
- `string` defaults: no coercion

**No hardcoded URLs or secrets** — use empty string defaults (`''`) and configure via `.env`.

#### **@cache** (`src/cache.ts`)
SQLite-backed caching with TTL support. Database: `./cache.sqlite` (override with `CACHE_DB_PATH`).

```typescript
@cache({ttlSeconds: 60 * 60 * 3})  // 3 hours
async getParks() { ... }

@cache({callback: (resp) => resp?.expiresIn || 3600})  // Dynamic TTL
async getAPIKey() { ... }
```

**Direct access:** `CacheLib.get()`, `CacheLib.set()`, `CacheLib.wrap()`, `CacheLib.delete()`, `CacheLib.clearByClassName()`, `CacheLib.clearAll()`

**In-flight deduplication:** `CacheLib.wrap()` deduplicates concurrent cache misses — only one caller executes the function, others wait for the result.

**Cache key collisions in base classes:** When multiple parks share a base class, use `getCacheKeyPrefix()` to prevent collisions:

```typescript
getCacheKeyPrefix(): string {
  return `attractionsio:${this.parkId}`;
}
// Keys become: attractionsio:1:ClassName:methodName:[args]
```

Alternatives: `cacheKeyPrefix` property, unique method arguments, or custom `key` function. See Cedar Fair (`src/parks/cedarfair/attractionsio.ts`) for reference.

**Cache versioning (invalidate stale shapes on deploy):** When a method's cached result shape changes — new fields, different grouping, different meaning — bump `cacheVersion` so old entries become unreachable (they still sit in SQLite until TTL but are never looked up). No manual flush needed across machines.

```typescript
@cache({ttlSeconds: 86400, cacheVersion: 2})  // method-level
async getParkData() { ... }
```

Class-level fallback applies to every `@cache` method in the class unless the method sets its own version:

```typescript
class MyPark extends Destination {
  protected cacheVersion = 3;                       // property form
  // or: getCacheVersion(method: string) { return … }  // method form (per-method)

  @cache({ttlSeconds: 60}) async a() { … }          // keyed under :v3
  @cache({ttlSeconds: 60, cacheVersion: 9}) async b() { … }  // keyed under :v9
}
```

Precedence: method option > class `getCacheVersion()` > class `cacheVersion` > unversioned.

#### **@http** (`src/http.ts`)
Queue-based HTTP with automatic retry, validation, and caching.

```typescript
@http({cacheSeconds: 180, retries: 3})
async fetchParks(): Promise<HTTPObj> {
  return {
    method: 'GET',
    url: `${this.baseURL}/venues`,
    options: {json: true},
    tags: ['parks'],
  } as HTTPObj;
}
```

Key: uses `node:http`/`node:https` (not `fetch`), global queue with 100ms interval, 250ms rate limit, request deduplication.

#### **@inject** (`src/injector.ts`)
Event-based dependency injection using Sift.js (MongoDB-like queries). Used for auth headers, response transforms.

```typescript
@inject({
  eventName: 'httpRequest',
  hostname: function() { return hostnameFromUrl(this.apiBase); },
  tags: {$nin: ['auth']},
})
async injectAuth(req: HTTPObj): Promise<void> {
  const {token} = await this.getToken();
  req.headers = {...req.headers, 'Authorization': `Bearer ${token}`};
}
```

**Priority:** Lower number runs first. Default is 0. Same priority runs in parallel.

#### **@reusable** (`src/promiseReuse.ts`)
Promise reuse to prevent duplicate async execution. `@reusable({forever: true})` for singletons.

### Destination Base Class (`src/destination.ts`)

All parks extend `Destination` using the **Template Method Pattern**.

**Public API (DO NOT OVERRIDE):** `getDestinations()`, `getEntities()`, `getLiveData()`, `getSchedules()`

**Protected API (IMPLEMENT IN SUBCLASSES):**
- `_init()` — Optional one-time initialization
- `buildEntityList()` — Return entities (hierarchy auto-resolved from parent chains)
- `buildLiveData()` — Return live data (wait times, statuses)
- `buildSchedules()` — Return schedules (operating hours)

**Helper methods:** `mapEntities()`, `resolveEntityHierarchy()`, `getLocalizedString()`, `buildReturnTimeQueue()`, `buildBoardingGroupQueue()`, `calculateReturnWindow()`

**Lifecycle:** `init()` auto-called before any data method, runs once via `@reusable({forever: true})`.

### Type System

All types come from `@themeparks/typelib`: `Entity`, `LiveData`, `EntitySchedule`, `TagType`, `LocalisedString`, `LanguageCode`, `AttractionTypeEnum`, `QueueType`.

### Utilities

- **`src/datetime.ts`** — `constructDateTime()`, `formatInTimezone()`, `localFromFakeUtc()`, `hostnameFromUrl()`, `addDays()`, `addMinutes()`
- **`src/tags/`** — `TagBuilder` API for entity metadata (height restrictions, accessibility). See `src/tags/TAG_DEVELOPMENT_GUIDE.md`
- **`src/virtualQueue/`** — `VQueueBuilder` for return times, boarding groups, paid queues. See `src/virtualQueue/VIRTUAL_QUEUE_GUIDE.md`
- **`src/htmlUtils.ts`** — `stripHtmlTags()`, `decodeHtmlEntities()`
- **`src/statusMap.ts`** — `createStatusMap()` for mapping API statuses to standard values
- **`src/wsUtils.ts`** — WebSocket async iterator for live stream support

### Proxy Support (`src/proxy.ts`, `src/destination.ts`)

Per-destination HTTP proxy for routing through CrawlBase, Scrapfly, or basic HTTP proxies.

**Global** (all destinations): Set `GLOBAL_CRAWLBASE`, `GLOBAL_SCRAPFLY`, or `GLOBAL_BASICPROXY` env vars. Auto-detected on first destination instantiation.

**Per-destination:** Each time a destination registers a config prefix via `addConfigPrefix('MYPARK')`, the matching env vars (`MYPARK_CRAWLBASE`, `MYPARK_SCRAPFLY`, `MYPARK_BASICPROXY`) are auto-loaded and merged into `proxyConfig`. No opt-in required — if the env var is set, the proxy is used. Consumers can also assign `destInstance.proxyConfig` directly after construction for fully explicit wiring.

Priority: CrawlBase > Scrapfly > Basic proxy. Per-destination overrides global. Proxy injection runs at priority 999 (after all auth/header injectors). Note: CrawlBase/Scrapfly rewrite URLs and are scraping services — they don't forward custom headers or POST bodies. Use `BASICPROXY` for authenticated API proxying.

## Destination Registration

`@destinationController` auto-registers destinations and applies `@config`. ID and name derived from class name:

```typescript
@destinationController({category: 'Universal'})
export class UniversalOrlando extends Destination {
  // ID: 'universalorlando', Name: 'Universal Orlando'
}
```

No manual imports needed — the test harness auto-discovers all `.ts`/`.js` files in `src/parks/`.

## Testing

**Location:** `src/**/__tests__/**/*.test.ts` | **Runner:** Vitest | **Config:** `vitest.config.ts`

Parks are excluded from coverage (integration-tested via `npm run dev`). Core libraries target 85-100%.

**HTTP queue in tests:** Use `waitForHttpQueue()` and `stopHttpQueue()` from `../http` to ensure queued requests complete before assertions.

## Documentation

- `.claude/skills/implementing-parks.md` — How to build a new park destination
- `src/tags/TAG_DEVELOPMENT_GUIDE.md` — Adding new tag types
- `src/virtualQueue/VIRTUAL_QUEUE_GUIDE.md` — Virtual queue patterns with real-world examples
- `TODO.MD` — Known issues, code review findings

## Important Rules

- **Entity IDs:** Always strings, even if sourced from numbers
- **Template Method:** Implement `build*()` methods, NOT `get*()` methods
- **Hierarchy:** Automatic — `parkId`/`destinationId` resolved from parent chains
- **No hardcoded URLs/secrets:** All in `@config` with empty defaults, loaded from `.env`
- **No `@config` on classes:** `@destinationController` handles it. Only use `@config` on properties
- **Config lookup order:** Instance config > `{CLASSNAME}_{PROPERTY}` > `{PREFIX}_{PROPERTY}` > default
- **HTTP:** Uses `node:http`/`node:https` (not `fetch`) for proxy consistency
- **Cache:** Only cache JSON-safe types (no Set, Map, Date objects)
- **Numeric validation:** Never use `isNaN()` on values from external APIs — `isNaN("")` returns `false` due to JS coercion. Use `Number.isFinite()` after `Number()`, or `parseInt()`/`parseFloat()` which return `NaN` for empty strings. `waitTime` must always be a finite number or null/undefined — the base class `getLiveData()` sanitises output as a safety net.
- **TypeScript:** ES2022, strict mode, decorators enabled, ESM modules
