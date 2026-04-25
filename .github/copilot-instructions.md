# Copilot review instructions for parksapi

These instructions describe project-specific conventions. **Do not flag the patterns below as defects** — they are intentional. Use this file to calibrate review feedback before commenting.

> Authoritative source for conventions: [`CLAUDE.md`](../CLAUDE.md). This file is a Copilot-focused condensation; if there is a conflict, `CLAUDE.md` wins.

## Project overview

parksapi is a TypeScript ESM library that fetches real-time theme park data (wait times, schedules, entities) from 75+ park implementations. All park integrations live under `src/parks/<park>/`. The core abstraction is the `Destination` base class with a Template Method pattern: subclasses implement `_init()`, `buildEntityList()`, `buildLiveData()`, `buildSchedules()`, **never** the public `get*()` methods.

Node 24+, npm 11+, ES2022 modules, decorators enabled.

## Decorator-based design

Five decorators carry most of the framework:

| Decorator | Purpose |
|---|---|
| `@destinationController({category})` | Auto-registers the destination and applies `@config` to the class. **Never apply `@config` to a class directly when using this decorator.** |
| `@config` | Property-level config injection. Values resolve from instance config → `{CLASSNAME}_{PROP}` env var → `{PREFIX}_{PROP}` env var → property default. |
| `@cache({ttlSeconds, key?, callback?, cacheVersion?})` | SQLite-backed memoisation with TTL. |
| `@http({cacheSeconds?, retries?, ...})` | Queue-based HTTP request wrapper. |
| `@inject({eventName, hostname?, tags?, priority?})` | Sift.js (MongoDB-like) event filter for cross-cutting concerns (auth, headers, error handling). |

## Patterns the project uses (do **not** flag these)

### 1. Empty-string config defaults are intentional

```ts
@config apiBase: string = '';
@config token: string = '';
@config email: string = '';
```

`CLAUDE.md` requires that **no URLs, keys, tokens, or app versions ever appear hardcoded in source**. Empty-string defaults force configuration via `.env` and are the documented convention. **Do not suggest providing fallback URLs, default keys, or upfront validation that throws on empty strings.** The HTTP layer's URL-construction error is the documented failure signal when env vars are missing.

It is fine — and preferred — to throw a clear error when a credential is needed *for a specific operation* (e.g., `if (!this.email || !this.password) throw new Error('… requires …_EMAIL and …_PASSWORD …')` inside the auth method that needs it). What you should not suggest is gating the whole class on non-empty `apiBase` upfront.

### 2. `this` in `@inject` callbacks does not need typing

```ts
@inject({
  eventName: 'httpRequest',
  hostname: function () { return hostnameFromUrl(this.apiBase); },
})
```

The `function () { ... this.apiBase ... }` form without an explicit `this: ClassName` parameter is used by 10+ destinations and `tsc --noEmit` passes. Do not suggest adding `this: FooDestination` or rewriting as an arrow function (the latter would change `this` binding and break the pattern).

### 3. Entity IDs are always strings

Even when the upstream API provides numbers, the framework requires string IDs. `String(numericId)` is the standard idiom; do not flag this as redundant.

### 4. Numeric validation uses `Number.isFinite`, not `isNaN`

```ts
const n = Number(raw);
if (Number.isFinite(n)) { ... }
```

`isNaN("")` returns `false` (truthy "is not NaN"), which is dangerous for waitTime fields coming from APIs that may return empty strings. Use `Number.isFinite(Number(x))` or `parseInt(x, 10)` paired with `Number.isFinite`. **Do not suggest replacing `Number.isFinite` with `isNaN`.**

### 5. `as any` casts on framework boundaries are tolerated

The `HTTPObj`/`Entity`/`LiveData`/`EntitySchedule` types from `@themeparks/typelib` are intentionally strict to enforce shape at the public API boundary. Park implementations frequently use `as any as HTTPObj` when constructing request objects from minimal field sets, and `as Entity` / `as EntitySchedule` when assembling output. **Do not suggest replacing these casts with full-shape literal construction** unless the cast is hiding an actual type mismatch.

### 6. Throwing inside cached/wrapped methods is fine

Methods decorated with `@cache`, `@reusable`, or that go through `CacheLib.wrap` are expected to throw on auth failures, missing config, or upstream errors. The framework handles propagation. **Do not suggest wrapping these in try/catch unless there is a specific recovery path** that makes sense (e.g. `EMAIL_NOT_FOUND` → fall back to sign-up).

### 7. Public-method overrides are forbidden

Subclasses must implement `buildEntityList`, `buildLiveData`, `buildSchedules`, and (rarely) `_init`. Do **not** suggest overriding `getEntities()`, `getLiveData()`, `getSchedules()`, or `getDestinations()` on a `Destination` subclass — those are non-overridable public entry points that the framework wires up.

## Park-implementation expectations

When reviewing a new file under `src/parks/<park>/<park>.ts`:

### Required structure

```ts
import {Destination, DestinationConstructor} from '../../destination.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {hostnameFromUrl, constructDateTime} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';

const DESTINATION_ID = 'foopark';
const PARK_ID = 'foopark-park';

@destinationController({category: 'Foo'})
export class FooPark extends Destination {
  @config apiBase: string = '';
  @config token: string = '';
  @config timezone: string = 'Region/City';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('FOOPARK');
  }

  @inject({eventName: 'httpRequest', hostname: function () { return hostnameFromUrl(this.apiBase); }})
  async injectAuth(req: HTTPObj): Promise<void> { … }

  @http({cacheSeconds: 60, retries: 2})
  async fetchLive(): Promise<HTTPObj> { … }

  @cache({ttlSeconds: 60})
  async getLive(): Promise<...> { … }

  async getDestinations(): Promise<Entity[]> { return [{id: DESTINATION_ID, …, entityType: 'DESTINATION'}]; }
  protected async buildEntityList(): Promise<Entity[]> { … }
  protected async buildLiveData(): Promise<LiveData[]> { … }
  protected async buildSchedules(): Promise<EntitySchedule[]> { … }
}
```

### Cache-TTL conventions

- Live data: ~60s (matches typical app polling cadence)
- Entity / facility lists: ~6h (`21600`s)
- Schedules / opening calendars: ~6h
- Auth tokens: as long as the issuer permits, often 30 days+; clear on 401 via an `httpError` injector

### Status / wait-time mapping

`LiveData.status` is one of: `OPERATING`, `CLOSED`, `DOWN`, `REFURBISHMENT`, plus a few rarer values from `@themeparks/typelib`.

- Numeric wait time → `OPERATING` + `queue: {STANDBY: {waitTime: N}}`
- "Maintenance" / "refurbishment" / equivalent → `REFURBISHMENT`
- Anything that isn't running or maintaining → `CLOSED`
- Down/temporary fault → `DOWN`

When the source API uses localised strings (e.g. `"営業準備中"` / `"Preparing"`), normalise via a phrase enum + numeric regex; do not assume a single locale.

### Entities to surface

- `DESTINATION` — the resort umbrella (always 1)
- `PARK` — each ticketed gate (often 1; multiple for multi-park resorts)
- `ATTRACTION` — rides, simulators, dark rides, walkthroughs
- `RESTAURANT` — counter service, table service, snack carts
- Skip: services, toilets, themed-area markers, parking, photo points, shops (unless the project asks for them)

### Schedules

- One `EntitySchedule` per `PARK`, with daily entries
- Emit only days the park is **open** (skip closed days; the absence is the signal)
- Use `constructDateTime(date, hhmmss, timezone)` to produce timezone-aware ISO strings

## Things that **are** worth flagging

- Hardcoded URLs / API keys / tokens / app versions in source — must be in `.env`
- Use of `isNaN()` on values from external APIs (use `Number.isFinite` or `parseInt`/`parseFloat`)
- `waitTime` ever being NaN or non-numeric (must be a finite number or null/undefined)
- Cache keys that collide across destinations sharing a base class (use `getCacheKeyPrefix()` or unique method args)
- Direct overrides of `getDestinations` / `getEntities` / `getLiveData` / `getSchedules` (must implement `build*` instead)
- Entity IDs that are not strings
- Adding `@config` to a class that already uses `@destinationController`
- Caching non-JSON-safe types (Set, Map, Date)
- Missing `addConfigPrefix(...)` call in the constructor
- Real bugs: off-by-one in loops, unhandled promise rejections, swallowed errors, type coercion that silently corrupts data

## Test plan for new parks

```bash
npm run dev -- <destinationid>           # 4/4 tests should pass
npm run audit:live -- --local --only=<destinationid>   # 0 schema errors, 0 warnings
npx tsc --noEmit                         # type-check across the whole project
```

A new park PR is expected to ship with all three green.
