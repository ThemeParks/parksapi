---
name: implementing-parks
description: Use when implementing a new theme park destination in TypeScript, given API documentation, HAR dumps, or cURL requests. Also use when modifying existing park implementations or debugging park data output issues.
---

# Implementing Theme Parks

Build a Destination class that fetches entities (rides, shows), live data (wait times, statuses, queues), and schedules (operating hours) from a park's API.

## Input

You'll typically receive one or more of:
- **cURL requests** intercepted from the park's mobile app (most common)
- **HAR dump** from browser/proxy capture
- **API documentation** (rare — most park APIs are undocumented)
- **Existing JS implementation** in `lib/parks/` to reference

## Analysis Checklist

Before writing code, identify from the input:

1. **Endpoints** — what URLs, what HTTP methods
2. **Auth** — API keys, tokens, OAuth, app version headers, client certificates
3. **Entity source** — which endpoint returns the list of rides/shows (POI data)
4. **Live data source** — which endpoint returns wait times/statuses
5. **Schedule source** — which endpoint returns operating hours (often a different domain)
6. **Response shapes** — document the JSON structure, field names, nesting
7. **Language** — does the API support multiple languages? Via query param or header?
8. **Timezone** — what timezone does the park operate in?
9. **Entity ID format** — what format are IDs in? Must match JS for backwards compatibility

## File Structure

```
src/parks/<parkname>/<parkname>.ts    # Single file per destination
src/parks/<parkname>/__tests__/       # Tests if needed
```

**Framework pattern** (multiple parks sharing one API): single file with base class + subclasses:
```
src/parks/<framework>/<framework>.ts  # Base class + subclasses in one file
```

## Implementation Order

### 1. Scaffold

```typescript
import {Destination, DestinationConstructor} from '../../destination.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {constructDateTime, formatInTimezone, addDays} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';
import {decodeHtmlEntities, stripHtmlTags} from '../../htmlUtils.js';

// @destinationController automatically applies @config to the class.
// Use @config on individual properties for env var resolution.
@destinationController({ category: 'ParkName' })
export class ParkName extends Destination {
  @config apiKey: string = '';
  @config timezone: string = 'America/New_York';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('PARKNAME');
  }
```

Config properties become env vars: `PARKNAME_APIKEY`, `PARKNAME_TIMEZONE`, etc.

### 2. Header Injection

One `@inject` per hostname. Preserve existing headers with spread. Use dynamic hostname from config:

```typescript
@inject({
  eventName: 'httpRequest',
  hostname: function() { return this.getApiHostname(); },
})
async injectHeaders(req: HTTPObj): Promise<void> {
  req.headers = {
    ...req.headers,
    'x-api-key': this.apiKey,
    'user-agent': 'okhttp/5.1.0',
  };
}

private getApiHostname(): string | undefined {
  if (!this.apiBase) return undefined;
  try { return new URL(this.apiBase).hostname; } catch { return undefined; }
}
```

### 3. HTTP Methods

Pattern: `@http` fetch method returns HTTPObj, `@cache` wrapper calls it and parses response. Add `healthCheckArgs` for endpoints with parameters so `npm run health` can test them:

```typescript
@http({ cacheSeconds: 43200 })  // 12h for entity data
async fetchPOI(): Promise<HTTPObj> {
  return { method: 'GET', url: `${this.apiBase}/poi`, options: { json: true } } as any as HTTPObj;
}

@http({ cacheSeconds: 43200, healthCheckArgs: ['{year}', '{month}'] })  // Test with current date
async fetchCalendar(year: number, month: number): Promise<HTTPObj> {
  return { method: 'GET', url: `${this.apiBase}/calendar/${year}/${month}`, options: { json: true } } as any as HTTPObj;
}

@cache({ ttlSeconds: 43200 })
async getPOI(): Promise<any[]> {
  const resp = await this.fetchPOI();
  const data = await resp.json();
  return data?.results || [];
}
```

**healthCheckArgs template variables:** `{year}`, `{month}`, `{today}` (YYYY-MM-DD), `{yyyymmdd}`, `{yyyymm}`, `{date+N}` (N days from now).

**Cache TTL guidelines:**
- Entity/POI data: 12h (`43200`)
- Live wait times: 1min (`60`)
- Schedules/calendar: 12h (`43200`)
- Auth tokens: dynamic via callback

**Cache serialization:** Only JSON-safe types survive caching. Do NOT cache `Set`, `Map`, or `Date` objects — use arrays, `Record<string, true>`, or ISO strings instead.

### 4. Entity Building

Override `buildEntityList()` and `getDestinations()`:

```typescript
async getDestinations(): Promise<Entity[]> {
  return [{ id: 'parkresort', name: 'Park Resort', entityType: 'DESTINATION',
    timezone: this.timezone, location: { latitude: 0, longitude: 0 } } as Entity];
}

protected async buildEntityList(): Promise<Entity[]> {
  const poi = await this.getPOI();
  const parkEntity: Entity = { id: 'park', name: 'Park', entityType: 'PARK',
    parentId: 'parkresort', destinationId: 'parkresort', timezone: this.timezone } as Entity;

  const attractions = this.mapEntities(poi.filter(p => p.type === 'ride'), {
    idField: 'id',
    nameField: 'name',
    entityType: 'ATTRACTION',
    parentIdField: () => 'park',
    destinationId: 'parkresort',
    timezone: this.timezone,
    locationFields: { lat: 'latitude', lng: 'longitude' },
    transform: (entity, item) => {
      entity.tags = [/* TagBuilder calls */];
      return entity;
    },
  });

  return [parkEntity, ...attractions];
}
```

### 5. Live Data

```typescript
protected async buildLiveData(): Promise<LiveData[]> {
  const waitTimes = await this.getWaitTimes();
  return waitTimes.map(entry => {
    const status = this.mapStatus(entry.state);
    const ld: LiveData = { id: String(entry.id), status } as LiveData;
    if (status === 'OPERATING' && entry.waitTime != null) {
      ld.queue = { STANDBY: { waitTime: entry.waitTime } };
    }
    return ld;
  });
}
```

### 6. Schedules

Use `constructDateTime()` for building timezone-aware ISO strings from date + time:

```typescript
protected async buildSchedules(): Promise<EntitySchedule[]> {
  const calendar = await this.getCalendar();
  const schedule = calendar.map(day => ({
    date: day.date,
    type: 'OPERATING',
    openingTime: constructDateTime(day.date, day.open, this.timezone),
    closingTime: constructDateTime(day.date, day.close, this.timezone),
  }));
  return [{ id: 'park', schedule } as EntitySchedule];
}
```

## Validation

### Health Check
```bash
npm run health                          # All parks — tests every @http endpoint
npm run health -- parkname              # Single park
npm run health -- --category Disney     # Category
```

### Comparison Harness
```bash
npm run harness -- capture parkname     # Capture JS snapshot (if JS exists)
npm run harness -- compare parkname     # Compare TS vs snapshot
```

### Manual Test
```bash
npm run dev -- parkname -v              # Full test
npm run dev -- parkname --skip-live-data --skip-schedules -v  # Entities only
```

## Shared Utilities

### `constructDateTime(dateStr, timeStr, timezone)`
Builds ISO 8601 from "YYYY-MM-DD" + "HH:mm" (or "HH:mm:ss") + timezone. **Always use this instead of manual offset construction.** Handles DST correctly.

```typescript
constructDateTime('2024-07-15', '10:00', 'Europe/Amsterdam')
// → "2024-07-15T10:00:00+02:00"
```

### `decodeHtmlEntities(str)` / `stripHtmlTags(str)`
Clean HTML from API responses. Import from `../../htmlUtils.js`.

```typescript
const name = decodeHtmlEntities(stripHtmlTags('<p>Tom &amp; Jerry&#x27;s</p>'));
// → "Tom & Jerry's"
```

### `formatDate(date, timezone?)`
Format a Date as `YYYY-MM-DD`. Use instead of verbose `getFullYear() + padStart(getMonth()+1) + padStart(getDate())`.

```typescript
formatDate(new Date())                              // → "2026-04-01"
formatDate(new Date('2026-03-31T23:00:00Z'), 'Europe/Amsterdam') // → "2026-04-01" (next day in Amsterdam)
```

### `localFromFakeUtc(fakeUtcStr, timezone)`
Convert "fake UTC" timestamps (local time encoded as UTC) to correctly-offset ISO strings. Many park APIs (SeaWorld, etc.) return timestamps ending in `Z` that actually represent local time.

```typescript
localFromFakeUtc('2026-04-01T09:00:00Z', 'America/New_York')
// → "2026-04-01T09:00:00-04:00"
```

### `hostnameFromUrl(url)`
Extract hostname from a URL string for `@inject` filters. Replaces the `getApiHostname()` private method that was duplicated in every park.

```typescript
import {hostnameFromUrl} from '../../datetime.js';

@inject({
  eventName: 'httpRequest',
  hostname: function() { return hostnameFromUrl(this.apiBase); },
})
```

### `createStatusMap(config, options)`
Declarative status mapping with unknown-state logging. Import from `../../statusMap.js`.

```typescript
import {createStatusMap} from '../../statusMap.js';
const mapStatus = createStatusMap({
  OPERATING: ['open', 'opened'],
  DOWN: ['temp closed', 'temp closed due weather'],
  CLOSED: ['closed', 'not scheduled', ''],
  REFURBISHMENT: ['maintenance'],
}, { parkName: 'MyPark' });
```

## Tips & Tricks

### No Hardcoded URLs or Secrets
All API URLs, keys, tokens, and credentials go in `@config` properties with empty defaults. Values come from env vars at runtime. **Never commit secrets to source code.**

### Entity IDs — Backwards Compatibility
Entity IDs must match the JS implementation exactly — the ThemeParks.wiki collector references entities by ID. Always verify with `npm run harness -- compare parkname`.

### Entity IDs Must Be Strings
Even if the API returns numbers: `id: String(apiId)`.

### Coordinates as Strings
Some APIs return lat/lng as strings. Always `Number()` before passing to TagBuilder or location fields.

### @config Inheritance (Framework Pattern)
For framework parks (base class + subclasses): the base class has `@config` for shared properties, subclasses use `@destinationController` (which auto-applies `@config`). Each subclass adds its own config prefix:

```typescript
@config
class FrameworkBase extends Destination {
  @config sharedToken: string = '';
  constructor(options?) { super(options); this.addConfigPrefix('SHARED'); }
}

@destinationController({ category: 'MyPark' })
export class ParkA extends FrameworkBase {
  constructor(options?) { super(options); this.addConfigPrefix('PARKA'); }
}
```

### Cache Key Collisions
Framework parks sharing a base class MUST implement `getCacheKeyPrefix()`:

```typescript
getCacheKeyPrefix(): string {
  return `framework:${this.parkId}`;
}
```

### Virtual Queues / Return Times
Use base class helpers. Three patterns:

```typescript
// Calculated window (Efteling pattern)
const window = this.calculateReturnWindow(waitMinutes, { windowMinutes: 15 });
liveData.queue.RETURN_TIME = this.buildReturnTimeQueue('AVAILABLE', window.start, window.end);

// Explicit time slots (DLP pattern)
liveData.queue.RETURN_TIME = this.buildReturnTimeQueue('AVAILABLE', slotStart, slotEnd);

// State-only, no windows (TDR pattern — Priority Pass / Premier Access)
liveData.queue.RETURN_TIME = { state: 'AVAILABLE', returnStart: null, returnEnd: null };
```

### Paid Return Time with Pricing (DLP pattern)
```typescript
liveData.queue.PAID_RETURN_TIME = {
  state: available ? 'AVAILABLE' : 'FINISHED',
  returnStart: startTime, returnEnd: endTime,
  price: { currency: 'EUR', amount: priceInCents },
};
```

### Single Rider Queues
Some APIs return separate entries. Two-pass pattern: first pass collects alternates, second pass merges into parent.

### Express / Paid Standby
```typescript
ld.queue.PAID_STANDBY = { waitTime: null };
```
Watch for sentinel values (Universal uses `995` for "unavailable").

### Standby Pass Pattern (Shanghai Disney)
Entities with "(Standby Pass Required)" in name aren't separate entities — fold into parent's RETURN_TIME queue.

### Anonymous Auth (Phantasialand pattern)
Create throwaway account, cache credentials for months, inject token via `@inject`. Exclude auth endpoints using tags.

### Location Spoofing (Phantasialand pattern)
Generate random coords within park bounds for endpoints requiring GPS.

### Client SSL Certificates (PortAventura pattern)
Store cert files outside repo, configure path via env var `PARKNAME_CERTDIR`. Read certs in `@inject`, set `requestObj.options.key` and `requestObj.options.cert`.

### HTML Scraping Gotchas
- Match both `value='...'` and `value="..."` in regex
- Decode HTML entities before JSON.parse: use `decodeHtmlEntities()`
- Calendar URLs change — make them configurable via env vars

### Schedule Batching
Some APIs time out on large day ranges. Batch in 7-day chunks (HFE pattern):

```typescript
for (let i = 0; i < 9; i++) {
  const startDate = addDays(now, i * 7);
  const resp = await this.fetchSchedule(formatDate(startDate));
  allDays.push(...resp);
}
```

### GraphQL APIs (DLP pattern)
POST to query endpoint with `x-application-id` and `x-request-id` headers. Fetch entities and per-date schedules separately.

### Dynamic Park Discovery (Six Flags pattern)
Firebase Remote Config → park list. Single class serves all parks. Entity IDs include park code prefix.

### Device Registration (TDR pattern)
Bootstrap device ID via POST, cache for weeks. Send as header on subsequent requests. Handle 400 (version enforcement) by refreshing app version.

## Quick Reference

| What | Decorator | TTL | Notes |
|------|-----------|-----|-------|
| Entity data (POI) | `@http` + `@cache` | 12h | Rarely changes |
| Wait times | `@http` + `@cache` | 1min | Real-time |
| Calendar/schedules | `@http` + `@cache` | 12h | Per month/date |
| Auth tokens | `@cache` with callback | Dynamic | Refresh before expiry |
| Header injection | `@inject` | N/A | Per hostname, dynamic |
| Entity mapping | `mapEntities()` | N/A | Declarative config |
| Virtual queues | `buildReturnTimeQueue()` | N/A | Base class helper |
| DateTime construction | `constructDateTime()` | N/A | Timezone-aware ISO |
| Date formatting | `formatDate()` | N/A | YYYY-MM-DD from Date |
| Fake UTC conversion | `localFromFakeUtc()` | N/A | UTC-encoded local → ISO |
| Hostname extraction | `hostnameFromUrl()` | N/A | For @inject filters |
| HTML decoding | `decodeHtmlEntities()` | N/A | From htmlUtils.js |
| Status mapping | `createStatusMap()` | N/A | From statusMap.js |
| Tags | `TagBuilder.*()` | N/A | Static factory methods |

### User-Agent Headers
A default User-Agent (`parksapi/2.0`, configurable via `DEFAULT_USER_AGENT` env var) is sent on all HTTP requests. Parks that need app-specific UAs override via `@inject` headers. Some park websites (calendar endpoints) require a browser-like UA — use a Chrome/Android string for those.

### Form-Encoded vs JSON POST Bodies
Check whether the API expects `application/json` or `application/x-www-form-urlencoded`. The JS library used `needle` which defaults to form-encoding for object bodies. Use `URLSearchParams` for form-encoded:
```typescript
const params = new URLSearchParams({key: 'value', num: String(123)});
return {
  method: 'POST', url: '...', body: params.toString(),
  headers: {'Content-Type': 'application/x-www-form-urlencoded'},
  options: {json: false},
} as any as HTTPObj;
```

### Binary Downloads (ZIP files)
For endpoints returning binary data (ZIP, images), set `options: {json: false}` and `'accept-encoding': 'identity'` to prevent double-decompression. Use `resp.arrayBuffer()` then `Buffer.from(ab)` for adm-zip. Do NOT use `@http` caching for binary responses — the HTTP cache stores text, which corrupts binary data.

### 303 Redirect Handling
`makeHttpRequest` does NOT follow redirects. For APIs that return 303 with a `Location` header (e.g., Attractions.io `/data`), read the header and make a second request manually.

### SQLite Entity Store (Attractions.io pattern)
For parks that download ZIP/database entity packs, use the `attractionsio_entities` SQLite table pattern instead of caching giant JSON blobs. See `src/parks/attractionsio/attractionsiov1.ts` for the diff/upsert approach with soft-delete tracking.

### OAuth Client Credentials
For parks using OAuth2 (e.g., Europa-Park), POST to the token endpoint with `grant_type=client_credentials` as form-encoded body. Cache the token with dynamic TTL from `expires_in`. Use `tags: ['auth']` to exclude the token endpoint from Bearer injection.

## Reference Implementations

- **Universal** (`src/parks/universal/universal.ts`) — Complex: multi-park resort, auth tokens, VQ, Express Pass
- **Efteling** (`src/parks/efteling/efteling.ts`) — Moderate: multi-language, virtual queue, calendar schedules, restaurants
- **DLP** (`src/parks/dlp/disneylandparis.ts`) — GraphQL API, paid return times with pricing, single rider
- **TDR** (`src/parks/tdr/tokyodisneyresort.ts`) — Device registration, app version tracking, Priority Pass
- **Shanghai** (`src/parks/shdr/shanghaidisneyresort.ts`) — Version compare API, standby pass pattern
- **Six Flags** (`src/parks/sixflags/sixflags.ts`) — Firebase config, dynamic park discovery, 25+ parks
- **Parcs Reunidos** (`src/parks/parcsreunidos/parcsreunidos.ts`) — Framework: base class + 5 subclasses, HTML calendar scraping
- **HFE** (`src/parks/hfe/hfe.ts`) — Framework: 4 parks, configurable categories, name-based wait time matching
- **Cedar Fair** (`src/parks/cedarfair/attractionsio.ts`) — Framework: API-discovery, 12 parks
- **Attractions.io v1** (`src/parks/attractionsio/attractionsiov1.ts`) — Framework: 16 parks, SQLite entity store, ZIP data packs, form-encoded auth
- **TE2** (`src/parks/te2/te2.ts`) — Dual ride status endpoints, Basic Auth, category-based POI discovery
- **Phantasialand** (`src/parks/phantasialand/phantasialand.ts`) — Anonymous auth, location spoofing, HTML scraping
- **PortAventura** (`src/parks/portaventura/portaventura.ts`) — Client SSL certificates, Strapi CMS, FTPName join
- **Parc Asterix** (`src/parks/parcasterix/parcasterix.ts`) — GraphQL persisted queries, offline ZIP/SQLite package
- **Europa-Park** (`src/parks/europapark/europapark.ts`) — OAuth2, 3 sub-parks, showlocation recursion, virtual queues
- **Toverland** (`src/parks/toverland/toverland.ts`) — Simple REST API with bearer token, monthly calendar
- **Paultons Park** (`src/parks/paultons/paultonspark.ts`) — Directus CMS, dual auth (x-token + Bearer), orms_id mapping
