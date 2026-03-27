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
2. **Auth** — API keys, tokens, OAuth, app version headers
3. **Entity source** — which endpoint returns the list of rides/shows (POI data)
4. **Live data source** — which endpoint returns wait times/statuses
5. **Schedule source** — which endpoint returns operating hours (often a different domain)
6. **Response shapes** — document the JSON structure, field names, nesting
7. **Language** — does the API support multiple languages? Via query param or header?
8. **Timezone** — what timezone does the park operate in?

## File Structure

```
src/parks/<parkname>/<parkname>.ts    # Single file per destination
src/parks/<parkname>/__tests__/       # Tests if needed (parks are integration-tested via harness)
```

## Implementation Order

### 1. Scaffold

```typescript
import {Destination, DestinationConstructor} from '../../destination.js';
import crypto from 'crypto';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {Entity, LiveData, EntitySchedule, LanguageCode} from '@themeparks/typelib';
import {formatInTimezone, parseTimeInTimezone, addDays, addMinutes} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';

// @destinationController automatically applies @config to the class.
// No need for a separate @config class decorator.
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

One `@inject` per hostname. Preserve existing headers with spread:

```typescript
@inject({ eventName: 'httpRequest', hostname: 'api.parkname.com' })
async injectHeaders(req: HTTPObj): Promise<void> {
  req.headers = {
    ...req.headers,  // Preserve any per-request overrides
    'x-api-key': this.apiKey,
    'user-agent': 'okhttp/5.1.0',
  };
}
```

### 3. HTTP Methods

Pattern: `@http` fetch method returns HTTPObj, `@cache` wrapper calls it and parses response.

```typescript
@http({ cacheSeconds: 43200 })  // 12h for entity data
async fetchPOI(): Promise<HTTPObj> {
  return { method: 'GET', url: 'https://api.park.com/poi', options: { json: true } } as any as HTTPObj;
}

@cache({ ttlSeconds: 43200 })
async getPOI(): Promise<any[]> {
  const resp = await this.fetchPOI();
  const data = await resp.json();
  return data?.results || [];
}
```

**Cache TTL guidelines:**
- Entity/POI data: 12h (`43200`)
- Live wait times: 1min (`60`)
- Schedules/calendar: 12h (`43200`)
- Auth tokens: dynamic via callback

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
    parentId: 'parkresort', destinationId: 'parkresort', timezone: this.timezone,
    location: { latitude: 0, longitude: 0 } } as Entity;

  const attractions = this.mapEntities(poi.filter(p => p.type === 'ride'), {
    idField: 'id',
    nameField: 'name',
    entityType: 'ATTRACTION',
    parentIdField: () => 'park',
    destinationId: 'parkresort',
    timezone: this.timezone,
    locationFields: { lat: 'latitude', lng: 'longitude' },
    filter: (item) => !item.hidden,
    transform: (entity, item) => {
      entity.tags = [/* TagBuilder calls */];
      return entity;
    },
  });

  return [parkEntity, ...attractions];
}
```

### 5. Live Data

Override `buildLiveData()`. Common pattern:

```typescript
protected async buildLiveData(): Promise<LiveData[]> {
  const waitTimes = await this.getWaitTimes();
  const liveData: LiveData[] = [];

  for (const entry of waitTimes) {
    const status = this.mapStatus(entry.state);
    const ld: LiveData = { id: String(entry.id), status } as LiveData;

    if (status === 'OPERATING' && entry.waitTime != null) {
      ld.queue = { STANDBY: { waitTime: entry.waitTime } };
    }

    liveData.push(ld);
  }
  return liveData;
}
```

### 6. Schedules

Override `buildSchedules()`. Return `EntitySchedule[]` — typically just the park entity:

```typescript
protected async buildSchedules(): Promise<EntitySchedule[]> {
  const calendar = await this.getCalendar();
  const schedule = calendar.map(day => ({
    date: day.date,
    type: 'OPERATING',
    openingTime: /* ISO string in park timezone */,
    closingTime: /* ISO string in park timezone */,
  }));

  return [{ id: 'park', schedule } as EntitySchedule];
}
```

## Validation

### Comparison Harness

If a JS implementation exists:

```bash
# 1. Add to park mapping (src/harness/parkMapping.ts)
# 2. Capture JS snapshot
npm run harness -- capture parkname
# 3. Implement TS
# 4. Compare
npm run harness -- compare parkname
```

### Manual Test

```bash
npm run dev -- parkname -v              # Full test (entities + live data + schedules)
npm run dev -- parkname --skip-live-data --skip-schedules -v  # Entities only
```

## Tips & Tricks

### Timezone Handling

**All timestamps must be in the park's local timezone with correct offset.**

```typescript
// GOOD: Format in park timezone
formatInTimezone(date, 'Europe/Amsterdam', 'iso')
// → "2024-10-15T14:30:00+02:00"

// BAD: UTC or system timezone
date.toISOString()
// → "2024-10-15T12:30:00.000Z"  (wrong for consumer display)
```

**Calendar time parsing (HH:mm strings):** Don't pass bare time strings to `new Date()` — it interprets them as local system time, not park time. Construct the full ISO string manually:

```typescript
// GOOD: Construct with known timezone offset
const offset = getAmsterdamOffset(dateStr);  // "+01:00" or "+02:00"
const openingTime = `${dateStr}T${timeStr}:00${offset}`;

// BAD: new Date() uses system timezone
const openingTime = new Date(`${dateStr}T${timeStr}:00`);
```

**`addMinutes` is DST-safe** — uses millisecond arithmetic, not `setMinutes`.

### HTML Scraping Gotchas

When scraping HTML for calendar/schedule data:
- **Quote styles vary:** Match both `value='...'` and `value="..."` in regex
- **HTML entities in attributes:** `&#34;` instead of `"`, `&#39;` instead of `'`. Decode before JSON.parse:
  ```typescript
  const decoded = raw.replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  ```
- **URLs change:** Park websites restructure frequently. Calendar URLs should be configurable via env vars, not hardcoded. Handle 301/404 gracefully.

### Status Mapping

Create a private `mapStatus()` method. Every park has its own state strings:

```typescript
private mapStatus(state: string): string {
  switch (state?.toLowerCase()) {
    case 'open': return 'OPERATING';
    case 'closed': return 'CLOSED';
    case 'down': case 'broken': return 'DOWN';
    case 'maintenance': return 'REFURBISHMENT';
    default:
      console.warn(`[ParkName] Unknown state: ${state}`);
      return 'CLOSED';
  }
}
```

Always log unknown states — they reveal API changes.

### Multi-Language Names

Fetch POI data per language, merge into `{ en: "...", nl: "..." }` objects. English is primary, other languages fill gaps. The framework's `getLocalizedString()` handles fallback display.

```typescript
nameField: (item) => ({ en: item.enName, nl: item.nlName }),
```

### Virtual Queues

Use the Destination base class helpers:

```typescript
// Calculated return window (e.g., Efteling pattern)
const window = this.calculateReturnWindow(waitMinutes, { windowMinutes: 15 });
liveData.queue.RETURN_TIME = this.buildReturnTimeQueue('AVAILABLE', window.start, window.end);

// Explicit time slots (e.g., Universal pattern)
liveData.queue.RETURN_TIME = this.buildReturnTimeQueue('AVAILABLE', slotStart, slotEnd);

// States: 'AVAILABLE', 'TEMP_FULL', 'FINISHED'
```

### Single Rider Queues

Some APIs return separate entries for single rider. Pattern:
1. During entity building, store a mapping: `{ alternateId → parentEntityId }`
2. During live data, first pass collects single rider entries, second pass merges them into the parent's queue.

```typescript
ld.queue.SINGLE_RIDER = { waitTime: null };  // Available, no specific time
```

### Express / Paid Queues

Map paid skip-the-line to `PAID_STANDBY`:

```typescript
ld.queue.PAID_STANDBY = { waitTime: null };  // Available, time unreliable
```

Watch for sentinel values (e.g., Universal uses `995` for "unavailable").

### Tags

Use `TagBuilder` for entity metadata:

```typescript
entity.tags = [
  TagBuilder.minimumHeight(132, 'cm'),
  TagBuilder.mayGetWet(),
  TagBuilder.unsuitableForPregnantPeople(),
  TagBuilder.childSwap(),
  TagBuilder.singleRider(),
  TagBuilder.location(lat, lng, 'Attraction Location'),
].filter(Boolean);
```

### @config Properties for Secrets

API base URLs, keys, and tokens should use `@config` with empty defaults — the env var provides the real value at runtime. Don't hardcode secrets in source:

```typescript
@config apiBase: string = '';   // Loaded from PARKNAME_APIBASE env var
@config apiKey: string = '';    // Loaded from PARKNAME_APIKEY env var
```

The `@config` decorator resolves from env vars automatically (`CLASSNAME_PROPERTY` or `PREFIX_PROPERTY`). If no env var is set, the empty default is used and requests will fail with clear errors.

### Entity IDs

**Always strings.** Even if the API returns numbers: `id: String(apiId)`.

### Gzip / Compressed Responses

The HTTP library (`httpProxy.ts`) handles gzip/deflate/brotli decompression automatically. If an API returns compressed responses, this works out of the box.

### Cache Key Collisions

If multiple parks share the same base class, implement `getCacheKeyPrefix()`:

```typescript
getCacheKeyPrefix(): string {
  return `efteling:${this.parkId}`;
}
```

### Droomvlucht Pattern (Merged Entries)

Some parks return separate WIS entries for the same ride (e.g., standby vs VQ). Remap to a single entity ID:

```typescript
let entityId = entry.Id;
if (entityId === 'droomvluchtstandby') entityId = 'droomvlucht';
```

Use a `getOrCreate` map pattern to merge data into one LiveData object.

### Anonymous Auth (Token via Self-Registration)

Some parks (e.g., Phantasialand) require creating a throwaway account to get an API token. Pattern:

```typescript
@cache({ ttlSeconds: 28908060, key: 'park:credentials' })  // ~11 months
async createUser(): Promise<{ email: string; password: string }> {
  const email = `${crypto.randomUUID()}@android.com`;
  const password = crypto.randomUUID();
  // POST to user creation endpoint
  return { email, password };
}

@cache({ ttlSeconds: 28908060, key: 'park:accessToken' })
async getAccessToken(): Promise<string> {
  const creds = await this.createUser();
  // POST to login endpoint with creds
  return token;
}
```

Inject the token as a query parameter or header via `@inject`. Exclude auth endpoints from injection using tags or URL matching.

### Location Spoofing

Some live data endpoints require a GPS `loc` parameter. Generate random coords within the park's bounding box:

```typescript
const lat = 50.7997 + Math.random() * 0.001;
const lng = 6.8776 + Math.random() * 0.001;
const url = `${apiBase}/snapshots?loc=${lat},${lng}`;
```

### Client SSL Certificates (Mutual TLS)

Some parks (e.g., PortAventura) require client SSL certificates. The cert files are secrets — store them outside the repo, configured via env var:

```typescript
@config certDir: string = '';  // PARKNAME_CERTDIR env var

private loadCerts(): { key: string; cert: string } | undefined {
  if (!this.certDir) return undefined;
  return {
    key: readFileSync(join(this.certDir, 'private.pem'), 'utf8'),
    cert: readFileSync(join(this.certDir, 'cert.pem'), 'utf8'),
  };
}
```

Inject certs into requests via `@inject` by setting `requestObj.options.key` and `requestObj.options.cert`. The HTTP layer passes these to Node.js HTTPS for mutual TLS.

## Quick Reference

| What | Decorator | TTL | Notes |
|------|-----------|-----|-------|
| Entity data (POI) | `@http` + `@cache` | 12h | Rarely changes |
| Wait times | `@http` + `@cache` | 1min | Real-time |
| Calendar/schedules | `@http` + `@cache` | 12h | Per month |
| Auth tokens | `@cache` with callback | Dynamic | Refresh before expiry |
| Header injection | `@inject` | N/A | Per hostname |
| Entity mapping | `mapEntities()` | N/A | Declarative config |
| Virtual queues | `buildReturnTimeQueue()` | N/A | Base class helper |
| Tags | `TagBuilder.*()` | N/A | Static factory methods |

### HFE Corp (Herschend) API Pattern

Parks like Kennywood, Dollywood, Silver Dollar City use `hfecorp.com` APIs:
- **POI:** `{crmBase}/api/destination/activitiesbysite/{siteId}` — no auth, `user-agent: okhttp/5.1.0`
- **Schedule:** `{crmBase}/api/park/dailyschedulebytime?parkids={parkId}&days=60&date={date}`
- **Wait times:** `https://pulse.hfecorp.com/api/waitTimes/{destId}` — IDs: 1=Dollywood, 2=Silver Dollar City, 3=Wild Adventures, 4=Kentucky Kingdom

Wait time `rideName` has park suffix like `(DW)`, `(KK)`. Join to POI via `rideWaitTimeRideId` field, or fall back to name matching (strip suffix).

## Reference Implementations

- **Universal** (`src/parks/universal/universal.ts`) — Complex: multi-park resort, auth tokens, VQ, Express Pass
- **Efteling** (`src/parks/efteling/efteling.ts`) — Moderate: multi-language, virtual queue, calendar schedules, single rider
- **Cedar Fair** (`src/parks/cedarfair/attractionsio.ts`) — Framework: API-discovery, multiple parks from one class
