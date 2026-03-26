# Comparison Harness Design

## Purpose

A CLI tool that validates TypeScript park migrations produce semantically equivalent output to the legacy JavaScript implementations. Supports pre-capturing JS output as golden snapshots before migration begins, then comparing TS output against those snapshots.

## CLI Interface

```bash
npm run harness -- capture <parkId>       # Run JS park, save normalized snapshot
npm run harness -- capture --all          # Capture all mapped JS parks
npm run harness -- capture --force <id>   # Overwrite existing snapshot
npm run harness -- compare <parkId>       # Run TS park, diff against snapshot
npm run harness -- compare --all          # Compare all parks with both implementations
npm run harness -- list                   # Show parks, snapshot status, TS availability
```

Entry point: `src/harness/compare.ts`, invoked via `tsx --env-file=.env src/harness/compare.ts`.

Add to `package.json`:
```json
"harness": "tsx --env-file=.env src/harness/compare.ts"
```

## Comparison Strategy

### Entities — strict comparison

Entities are stable data. The same park should produce the same entity list regardless of when it runs. Comparison checks:

- **Same set of entity IDs** — every ID in the snapshot must appear in TS output
- **Same `entityType` per ID** — PARK, ATTRACTION, SHOW, RESTAURANT, DESTINATION
- **Same `name` per ID** — after normalizing multi-language names to English (fallback: first available language)
- **Same `parentId` / hierarchy** — parent-child relationships must match (`null`, `undefined`, and missing are treated as equivalent)
- **Same `timezone`** — per entity

Not compared:
- **`location`** — reported as a warning if present in one but not the other, not a failure
- **`tags`** — excluded from comparison (JS `_tags` and TS `TagBuilder` produce structurally different output by design)

Extra entities in TS (not in snapshot) are reported as warnings, not failures — the TS implementation may intentionally add entities the JS version missed.

### Live data — structural comparison only

Live data is time-sensitive. Wait times and statuses change minute to minute. Comparison checks:

- **Same set of entity IDs** present (entity has live data in both)
- **Valid structure** — each entry has `status` field, `queue` object if applicable
- **Per-entity queue type keys match** — if snapshot records `STANDBY` and `RETURN_TIME` for an entity, TS should have the same queue type keys (values are not compared)

Missing live data entity IDs are warnings. Extra ones are noted but don't fail.

### Schedules — structural comparison only

Schedule data changes day to day. Comparison checks:

- **Same set of entity IDs** present
- **Valid structure** — each entry has `schedule` array with entries containing `date`, `type`, `openingTime`, `closingTime`

## Normalization

Both JS and TS output are normalized to a common format before comparison. This accounts for known intentional differences between the two implementations. Normalization applies to all three data types (entities, live data, schedules).

### JS normalization (all data types)
- Strip underscore prefixes on all objects: `_id` -> `id`, `_parentId` -> `parentId`, `_destinationId` -> `destinationId`, `_parkId` -> `parkId`, `_tags` -> `tags`
- Remove `slug` field (not present in TS)
- Stringify all IDs (ensure consistent types)
- Sort entities by `id` for stable ordering
- Normalize location field: `{longitude, latitude}` -> `{latitude, longitude}` (consistent key order)
- Treat `undefined` and `null` as equivalent for optional fields (`parentId`, `parkId`, `location`)

### TS normalization (all data types)
- For multi-language names (`{en: "...", fr: "..."}`), extract English value; if `en` is missing, try base language, then first available
- Stringify all IDs
- Sort entities by `id`

### Fields excluded from comparison
- `lastUpdated` / timestamps on live data
- `waitTime` values (time-varying)
- `showtimes` values (time-varying)
- `returnStart` / `returnEnd` values (time-varying)
- Schedule `date` / `openingTime` / `closingTime` values (day-varying)
- `tags` (structurally different between JS and TS by design)

## Snapshot Format

Stored at `snapshots/<parkId>.json`:

```json
{
  "parkId": "universalorlando",
  "capturedAt": "2026-03-25T14:30:00.000Z",
  "source": "js",
  "version": 1,
  "entities": [
    {
      "id": "universal_studios_florida",
      "name": "Universal Studios Florida",
      "entityType": "PARK",
      "parentId": "universalorlando",
      "destinationId": "universalorlando",
      "parkId": null,
      "timezone": "America/New_York",
      "location": { "latitude": 28.47, "longitude": -81.46 }
    }
  ],
  "liveData": {
    "entityIds": ["entity1", "entity2"],
    "perEntityQueueTypes": {
      "entity1": ["STANDBY"],
      "entity2": ["STANDBY", "RETURN_TIME"]
    },
    "statusTypes": ["OPERATING", "CLOSED", "DOWN", "COMING_SOON"]
  },
  "schedules": {
    "entityIds": ["entity1", "entity2"],
    "entityCount": 12,
    "hasScheduleEntries": true
  }
}
```

The `version` field allows future format changes. If the harness encounters a snapshot with an unrecognized version, it logs a warning and attempts comparison anyway (best-effort forward compatibility).

## JS Runner

`src/harness/jsRunner.mjs` is a standalone ESM script (the JS codebase uses `"type": "module"`). It is spawned as a child process to keep JS and TS runtimes fully isolated.

**Invocation:**
```
node --env-file=.env src/harness/jsRunner.mjs <JsClassName>
```

The harness runs this with `child_process.execFile`, setting `cwd` to the JS codebase directory (resolved from `../parksapi_js/` relative to the TS project root). The `--env-file=.env` flag loads credentials from the JS project's `.env`.

**Timeout:** 120 seconds. If the process doesn't exit within this window, it is killed and the capture reports failure for that park.

**What it does:**
1. Receives JS class name via argv (e.g., `UniversalStudiosOrlando`)
2. Dynamically imports the JS entry point: `const mod = await import('../parksapi_js/lib/index.js')`
3. Accesses the class via `mod.default.destinations[className]` (JS exports a default object with a `destinations` map)
4. Instantiates and calls `getAllEntities()` (includes destination entity), `getEntityLiveData()`, `getEntitySchedules()`
5. Writes JSON to stdout: `{ entities: [...], liveData: [...], schedules: [...] }`
6. Exits

Note: only `getAllEntities()` is called for entities — it already includes destination and park entities. `getDestinationEntity()` is not called separately to avoid duplicates.

Errors are written to stderr. Non-zero exit code signals failure.

**Error handling for `capture --all`:** If a park fails during capture (API error, timeout, missing credentials), it is skipped with a log message. Other parks continue. A summary at the end reports which parks failed.

## Park Mapping

`src/harness/parkMapping.ts` maps TS destination registry IDs to JS export class names:

```typescript
export const parkMapping: Record<string, string> = {
  'universalorlando': 'UniversalStudiosOrlando',
  'universalhollywood': 'UniversalStudiosHollywood',
  'cedarpoint': 'CedarPoint',
  'knottsberryfarm': 'KnottsBerryFarm',
  // ... added as parks are migrated
};
```

This mapping requires manual curation — JS class names don't follow a predictable pattern (e.g., JS `WaltDisneyWorldResort` might map to TS `waltdisneyworld`). The mapping is the source of truth for which parks can be compared.

This mapping serves double duty:
- Tells the harness which JS class to instantiate for a given TS park ID
- Acts as the registry of "which parks have both implementations" — if a park ID isn't here, `compare` mode reports "no JS mapping"

For `capture --all`, the harness iterates all entries in the mapping.

## Comparison Report

### Console output

```
Comparing: Universal Orlando (universalorlando)
Snapshot: 2026-03-25 (js) | Live: ts

ENTITIES (45 in snapshot, 45 in TS)
  45 exact matches
  0 missing, 0 extra

LIVE DATA (45 in snapshot, 45 in TS)
  45/45 entity IDs present
  Per-entity queue types match

SCHEDULES (12 in snapshot, 12 in TS)
  12/12 entity IDs present
  All have valid schedule entries

RESULT: PASS
```

With mismatches:

```
ENTITIES (45 in snapshot, 43 in TS)
  41 exact matches
  2 field mismatches:
    ride_xyz: name differs
      snapshot: "The Amazing Ride"
      ts:       "Amazing Ride, The"
  2 missing in TS: ride_abc, show_def
  0 extra in TS

RESULT: FAIL (2 missing entities)
```

### Machine-readable report

Written to `snapshots/<parkId>.report.json`:

```json
{
  "parkId": "universalorlando",
  "timestamp": "2026-03-25T14:35:00.000Z",
  "result": "PASS",
  "entities": {
    "snapshotCount": 45,
    "tsCount": 45,
    "matches": 43,
    "mismatches": [
      { "id": "ride_xyz", "field": "name", "snapshot": "...", "ts": "..." }
    ],
    "missingInTs": [],
    "extraInTs": []
  },
  "liveData": {
    "snapshotEntityIds": 45,
    "tsEntityIds": 45,
    "missingIds": [],
    "queueTypeMismatches": [],
    "structureValid": true
  },
  "schedules": {
    "snapshotEntityIds": 12,
    "tsEntityIds": 12,
    "missingIds": [],
    "structureValid": true
  }
}
```

For `compare --all`, a summary line is printed at the end:

```
SUMMARY: 12/14 parks passed, 2 failed (cedarpoint, knottsberryfarm)
```

### Exit codes

- `0` — pass (no missing entities, no structural mismatches)
- `1` — fail (missing entities in TS or structural mismatches in live data/schedules)

Field-level warnings (name differences due to multi-language, extra entities in TS, location differences) do not cause failure.

## File Layout

```
src/harness/
  compare.ts          # CLI entry point — arg parsing, orchestration
  normalizer.ts       # Normalize JS and TS output to common format
  differ.ts           # Compare two normalized datasets, produce diff
  reporter.ts         # Console output and JSON report generation
  jsRunner.mjs        # Standalone ESM script, spawned against JS codebase
  parkMapping.ts      # TS park ID -> JS class name mapping
snapshots/
  .gitkeep
  universalorlando.json
  ...
```

Snapshots (`.json`) are committed to git. Report files (`.report.json`) are gitignored (regenerated on each compare run).

## Dependencies

No new dependencies. Uses:
- `child_process` (Node built-in) for spawning JS runner
- Existing destination registry for TS park instantiation
- Existing `@themeparks/typelib` types for structure validation
