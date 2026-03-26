# Efteling TypeScript Migration Design

## Purpose

Migrate Efteling theme park from the legacy JavaScript implementation to TypeScript, using live API endpoints instead of static POI files. This is the first standalone park migration and serves as the template pattern for future park migrations.

## File

Create: `src/parks/efteling/efteling.ts`

## Configuration

Properties loaded via `@config` decorator from environment variables:

| Property | Env Var | Description |
|----------|---------|-------------|
| `apiKey` | `EFTELING_APIKEY` | API key for api.efteling.com |
| `apiVersion` | `EFTELING_APIVERSION` | API version header (currently `9`) |
| `appVersion` | `EFTELING_APPVERSION` | App version header (currently `v5.18.0`) |

Timezone: `Europe/Amsterdam`
Default language: `nl`

## API Endpoints

### POI Data — Entity Source

```
GET https://api.efteling.com/app/poi
```

Called twice — once with `x-app-language: en`, once with `x-app-language: nl`. Cached 12 hours each.

**Response shape:**
```json
{
  "status": { "rid": "...", "time-ms": 0 },
  "hits": {
    "found": 255,
    "start": 0,
    "hit": [
      {
        "id": "baron1898-en",
        "fields": {
          "id": "baron1898",
          "name": "Baron 1898",
          "category": "attraction",
          "latlon": "51.64827,5.050988",
          "minimum_length": "132",
          "properties": ["minimum132", "pregnantwomen", "wet", ...],
          "hide_in_app": false,
          "alternateid": "baron1898singlerider",
          "alternatetype": "singlerider",
          "wis_info": { "Id": "baron1898", "Name": "Baron 1898", "Type": "Attracties", "State": "open", "WaitingTime": 25 }
        }
      }
    ]
  }
}
```

Entities are at `response.hits.hit[].fields`. The outer `hit[].id` is a language-suffixed key (e.g., `baron1898-en`); the inner `fields.id` is the canonical entity ID.

### Wait Times — Live Data Source

```
GET https://api.efteling.com/app/wis
```

Called with `x-app-language: en`. Cached 1 minute.

**Response shape:**
```json
{
  "AttractionInfo": [
    {
      "Id": "baron1898",
      "Type": "Attracties",
      "State": "open",
      "WaitingTime": 25,
      "ShowTimes": [],
      "PastShowTimes": [],
      "VirtualQueue": {
        "State": "enabled",
        "WaitingTime": 45
      }
    }
  ]
}
```

Show time entries have format:
```json
{
  "ShowDateTime": "2026-03-26T18:15:00+01:00",
  "StartDateTime": "2026-03-26T18:15:00+01:00",
  "EndDateTime": "2026-03-26T18:27:00+01:00",
  "Duration": 12,
  "Edition": "Efteling Symphonica",
  "Title": { "NL": "...", "EN": "...", "DE": "...", "FR": "..." }
}
```

### Calendar — Schedule Source

```
GET https://www.efteling.com/service/cached/getpoiinfo/en/{year}/{month}
```

Fetched for current month + 3 months forward. Cached 12 hours per month. Returns `400` for past months (handled gracefully). Different auth headers from the API endpoints.

**Response shape:**
```json
{
  "OpeningHours": [
    {
      "Date": "2024-10-15",
      "OpeningHours": [
        { "Open": "10:00", "Close": "18:00" },
        { "Open": "19:00", "Close": "22:00" }
      ]
    }
  ]
}
```

## HTTP Headers

### api.efteling.com (POI + WIS endpoints)

Injected via `@inject` on hostname `api.efteling.com`:

```
x-api-key: {apiKey}
x-api-version: {apiVersion}
x-app-version: {appVersion}
x-app-name: Efteling
x-app-id: nl.efteling.android
x-app-platform: Android
x-app-language: en
x-app-timezone: Europe/Amsterdam
x-app-deviceid: {v4 UUID generated in constructor, ephemeral per process}
user-agent: okhttp/5.1.0
```

The `x-app-language` header is overridden per-request for multi-language POI fetching. Default is `en`. The user-agent version is `5.1.0` (updated from JS implementation's `4.12.0` to match the current app).

### www.efteling.com (Calendar endpoint)

Injected via `@inject` on hostname `www.efteling.com`:

```
X-Requested-With: XMLHttpRequest
referer: https://www.efteling.com/en/park/opening-hours?app=true
cookie: website#lang=en
```

## Entity Building

### Hierarchy

- Destination: `eftelingresort` (lat: 51.649515, lng: 5.043776)
- Park: `efteling`, parent: `eftelingresort` (same coords)
- Attractions/Shows: parent: `efteling`

### getDestinations()

Override to return the destination entity:

```typescript
async getDestinations(): Promise<Entity[]> {
  return [{
    id: 'eftelingresort',
    name: { en: 'Efteling', nl: 'Efteling' },
    entityType: 'DESTINATION',
    timezone: 'Europe/Amsterdam',
    location: { latitude: 51.649515, longitude: 5.043776 },
  }];
}
```

### POI Merge Strategy

1. Fetch English POI data (`x-app-language: en`) — returns `response.hits.hit[]`
2. Fetch Dutch POI data (`x-app-language: nl`) — returns `response.hits.hit[]`
3. Index both by `fields.id`. For each entry in the Dutch set, if no English match exists, keep the Dutch version. English is primary.
4. Build multi-language name: `{ en: englishName, nl: dutchName }`

### Entity Filtering

Include categories: `attraction`, `show`
Exclude:
- `fields.hide_in_app === true`
- `fields.latlon === '0.0,0.0'` or missing (no valid location)
- `category: 'attraction-alternative'` (accessible alternatives like Danse Macabre Film Room — not standalone attractions)

### Name Overrides

- `stoomtreinr` → append ` - Oost` to name (both languages)
- `stoomtreinm` → append ` - Marerijk` to name (both languages)

(Two boarding stations for the steam railway share the name "Stoomtrein" in the POI data.)

### Single Rider Mapping

Some POI entries have `fields.alternateid` + `fields.alternatetype === 'singlerider'`. Store this mapping (`{ singleRiderId → parentEntityId }`) for live data processing — the WIS API returns separate entries for single rider queues using the alternate ID.

Other `alternatetype` values (e.g., `boatride` on `dezeszwanen`) are intentionally ignored — only `singlerider` is used.

### Tags

Extract from `fields.properties` array:
- `minimumNNN` → `TagBuilder.minimumHeight(NNN, 'cm')` (parse digits after `minimum` prefix)
- `wet` → `TagBuilder.mayGetWet()`
- `pregnantwomen` → `TagBuilder.unsuitableForPregnantPeople()`
- `babyswitch` → `TagBuilder.childSwap()`
- Single rider entries (has `alternatetype === 'singlerider'`) → `TagBuilder.singleRider()`
- Location from `fields.latlon` → `TagBuilder.location(lat, lng, entityName)`

Note: Tags are net-new functionality not present in the JS implementation. The golden snapshot has no tag data, so tags will not affect the harness entity comparison (tags are excluded from comparison by design).

### Entity Mapping

Use `mapEntities()` helper from the Destination base class with a `transform` callback for tags.

## Live Data

### Status Mapping

| `entry.State` (lowercased) | Status |
|---|---|
| `open` | `OPERATING` |
| `storing` | `DOWN` |
| `tijdelijkbuitenbedrijf` | `DOWN` |
| `buitenbedrijf` | `CLOSED` |
| `inonderhoud` | `REFURBISHMENT` |
| `gesloten` | `CLOSED` |
| `''` (empty) | `CLOSED` |
| `wachtrijgesloten` | `CLOSED` |
| `nognietopen` | `CLOSED` |

Unknown states are logged as warnings.

### Wait Times

`parseInt(entry.WaitingTime, 10)` — only populated when status is `OPERATING`, otherwise `null`.

### Processing Flow

1. **First pass:** Scan for entries where the ID is NOT in POI data but matches a `singleRiderId` from POI. These are single rider queue entries — collect `{ parentId, waitTime }`.

2. **Second pass:** For each entry with a matching POI entry:
   - `Type === 'Attraction'` or `'Attracties'` → build attraction live data (STANDBY queue + optional SINGLE_RIDER from first pass)
   - `Type === 'Shows en Entertainment'` → build show live data (showtimes from `ShowTimes` + `PastShowTimes` arrays)

### Droomvlucht Special Case

The WIS API returns both `droomvlucht` (virtual queue entry) and `droomvluchtstandby` (standby queue). Both map to entity ID `droomvlucht` — merge into a single live data record.

### Virtual Queue

The WIS API optionally includes a `VirtualQueue` object on attraction entries.

| `VirtualQueue.State` | Return Time State | Return Window |
|---|---|---|
| `walkin` | `TEMP_FULL` | null / null |
| `enabled` | `AVAILABLE` | Calculated: `[now + WaitingTime, now + WaitingTime + 15min]` |
| `full` | `FINISHED` | null / null |

Use `this.calculateReturnWindow(vq.WaitingTime, { windowMinutes: 15 })` from the Destination base class.

### Show Times

Shows get status OPERATING if `ShowTimes` array is non-empty, CLOSED otherwise. Build `showtimes` array from `ShowTimes` (upcoming) and `PastShowTimes` (past). Show time entries have ISO 8601 format with timezone offset (e.g., `2026-03-26T18:15:00+01:00`). Parse with `parseTimeInTimezone()`. Each entry has `startTime`, `endTime`, and `type` (from `time.Edition` or `'Showtime'` fallback).

## Schedules

### Calendar Fetching

Fetch 4 months of calendar data (current + 3 forward). Each month is a separate HTTP call:

```
GET https://www.efteling.com/service/cached/getpoiinfo/en/{year}/{month}
```

Month is 1-indexed. Returns `400` for past months — return empty array on error.

### Schedule Building

Only the park entity `efteling` gets schedule data. For each day in the response:

1. Parse `OpeningHours` array, sort by `Open` time
2. First entry → schedule type `OPERATING`
3. Subsequent entries → schedule type `INFO` with description `'Evening Hours'`
4. Parse `"HH:mm"` time strings into full ISO datetimes in `Europe/Amsterdam`

## Registration

```typescript
@destinationController({ category: 'Efteling' })
```

## Validation

Run comparison harness after implementation:
```bash
npm run harness -- compare efteling
```

Golden snapshot already captured: 46 entity IDs, 46 live data entity IDs (with per-entity queue type mapping), 1 schedule entity ID. The harness compares entity IDs/types/names/hierarchy strictly, and live data/schedule entity ID sets + queue type keys structurally.

Note: Multi-language names (`{ en: "...", nl: "..." }`) will differ from the snapshot's English-only strings. The harness normalizer extracts English for comparison, so this should still match.

## Roadmap

- **Restaurant entities:** Efteling POI data includes `restaurant` category entries with locations and operating times. The JS implementation had this stubbed but disabled. Adding restaurants is a straightforward follow-up — filter for `category: 'restaurant'`, map to RESTAURANT entity type, include operating hours from WIS data.
