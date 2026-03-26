# Comparison Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a CLI tool that captures JS park output as golden snapshots and compares TS park output against them, validating migration correctness.

**Architecture:** Two-mode CLI (capture/compare) with a standalone ESM JS runner spawned as a child process. Normalizer translates both JS and TS output to a common format. Differ compares normalized data and produces structured reports.

**Tech Stack:** Node.js child_process, tsx, vitest, existing destination registry, existing @themeparks/typelib types.

**Spec:** `docs/superpowers/specs/2026-03-25-comparison-harness-design.md`

---

### Task 1: Snapshot types and park mapping

**Files:**
- Create: `src/harness/types.ts`
- Create: `src/harness/parkMapping.ts`

- [ ] **Step 1: Create `src/harness/types.ts` with all shared types**

```typescript
// src/harness/types.ts

/** Normalized entity for comparison (common format between JS and TS) */
export type NormalizedEntity = {
  id: string;
  name: string;
  entityType: string;
  parentId: string | null;
  destinationId: string | null;
  parkId: string | null;
  timezone: string;
  location: { latitude: number; longitude: number } | null;
};

/** Snapshot format stored to disk */
export type Snapshot = {
  parkId: string;
  capturedAt: string;
  source: 'js' | 'ts';
  version: number;
  entities: NormalizedEntity[];
  liveData: {
    entityIds: string[];
    perEntityQueueTypes: Record<string, string[]>;
    statusTypes: string[];
  };
  schedules: {
    entityIds: string[];
    entityCount: number;
    hasScheduleEntries: boolean;
  };
};

export const SNAPSHOT_VERSION = 1;

/** Raw output from JS runner or TS park (before normalization) */
export type RawParkOutput = {
  entities: any[];
  liveData: any[];
  schedules: any[];
};

/** Entity comparison result */
export type EntityDiffResult = {
  matches: number;
  mismatches: { id: string; field: string; snapshot: any; ts: any }[];
  missingInTs: string[];
  extraInTs: string[];
};

/** Live data comparison result */
export type LiveDataDiffResult = {
  snapshotEntityIds: number;
  tsEntityIds: number;
  missingIds: string[];
  queueTypeMismatches: { id: string; snapshot: string[]; ts: string[] }[];
  structureValid: boolean;
};

/** Schedule comparison result */
export type ScheduleDiffResult = {
  snapshotEntityIds: number;
  tsEntityIds: number;
  missingIds: string[];
  structureValid: boolean;
};

/** Full comparison report */
export type ComparisonReport = {
  parkId: string;
  timestamp: string;
  result: 'PASS' | 'FAIL';
  entities: EntityDiffResult & { snapshotCount: number; tsCount: number };
  liveData: LiveDataDiffResult;
  schedules: ScheduleDiffResult;
};
```

- [ ] **Step 2: Create `src/harness/parkMapping.ts`**

```typescript
// src/harness/parkMapping.ts

/**
 * Maps TS destination registry IDs to JS export class names.
 * Manually curated — JS class names don't follow a predictable pattern.
 *
 * Add entries as parks are migrated to TypeScript.
 * This is also the registry of "which parks have both implementations."
 */
export const parkMapping: Record<string, string> = {
  'universalorlando': 'UniversalOrlando',
  'universalstudios': 'UniversalStudios',
};

/**
 * Reverse mapping: JS class name -> TS park ID
 */
export function jsClassToTsParkId(jsClassName: string): string | undefined {
  return Object.entries(parkMapping).find(([, js]) => js === jsClassName)?.[0];
}
```

- [ ] **Step 3: Commit**

```bash
git add src/harness/types.ts src/harness/parkMapping.ts
git commit -m "feat(harness): add snapshot types and park mapping"
```

---

### Task 2: Normalizer

**Files:**
- Create: `src/harness/__tests__/normalizer.test.ts`
- Create: `src/harness/normalizer.ts`

- [ ] **Step 1: Write failing tests for JS normalization**

```typescript
// src/harness/__tests__/normalizer.test.ts
import { describe, test, expect } from 'vitest';
import { normalizeJsEntity, normalizeTsEntity, normalizeJsLiveData, normalizeTsLiveData, normalizeJsSchedule, normalizeTsSchedule, sortById, buildLiveDataStructure, buildScheduleStructure } from '../normalizer.js';

describe('normalizeJsEntity', () => {
  test('strips underscore prefixes from fields', () => {
    const jsEntity = {
      _id: '123',
      name: 'Test Ride',
      entityType: 'ATTRACTION',
      _parentId: 'park1',
      _destinationId: 'dest1',
      _parkId: 'park1',
      timezone: 'America/New_York',
      slug: 'test-ride',
      _tags: [{ id: 'tag1' }],
    };
    const result = normalizeJsEntity(jsEntity);

    expect(result.id).toBe('123');
    expect(result.parentId).toBe('park1');
    expect(result.destinationId).toBe('dest1');
    expect(result.parkId).toBe('park1');
    expect(result).not.toHaveProperty('slug');
    expect(result).not.toHaveProperty('_id');
    expect(result).not.toHaveProperty('_tags');
  });

  test('stringifies numeric IDs', () => {
    const jsEntity = {
      _id: 456,
      name: 'Test',
      entityType: 'ATTRACTION',
      _parentId: 789,
      _destinationId: 'dest1',
      timezone: 'UTC',
    };
    const result = normalizeJsEntity(jsEntity);

    expect(result.id).toBe('456');
    expect(result.parentId).toBe('789');
  });

  test('normalizes location field order', () => {
    const jsEntity = {
      _id: '1',
      name: 'Test',
      entityType: 'PARK',
      _destinationId: 'dest1',
      timezone: 'UTC',
      location: { longitude: -81.46, latitude: 28.47 },
    };
    const result = normalizeJsEntity(jsEntity);

    expect(result.location).toEqual({ latitude: 28.47, longitude: -81.46 });
  });

  test('treats undefined and null parentId as null', () => {
    const withUndefined = { _id: '1', name: 'T', entityType: 'DESTINATION', _destinationId: 'd', timezone: 'UTC' };
    const withNull = { _id: '2', name: 'T', entityType: 'DESTINATION', _destinationId: 'd', _parentId: null, timezone: 'UTC' };

    expect(normalizeJsEntity(withUndefined).parentId).toBeNull();
    expect(normalizeJsEntity(withNull).parentId).toBeNull();
  });
});

describe('normalizeTsEntity', () => {
  test('extracts English from multi-language name', () => {
    const tsEntity = {
      id: '1',
      name: { en: 'Space Mountain', fr: 'Space Mountain' },
      entityType: 'ATTRACTION',
      parentId: 'park1',
      destinationId: 'dest1',
      parkId: 'park1',
      timezone: 'America/New_York',
    };
    const result = normalizeTsEntity(tsEntity);

    expect(result.name).toBe('Space Mountain');
  });

  test('falls back to first available language if no English', () => {
    const tsEntity = {
      id: '1',
      name: { nl: 'Vliegende Hollander', de: 'Fliegender Holländer' },
      entityType: 'ATTRACTION',
      parentId: 'park1',
      destinationId: 'dest1',
      timezone: 'UTC',
    };
    const result = normalizeTsEntity(tsEntity);

    expect(result.name).toBe('Vliegende Hollander');
  });

  test('passes through string names unchanged', () => {
    const tsEntity = {
      id: '1',
      name: 'Test Ride',
      entityType: 'ATTRACTION',
      parentId: 'park1',
      destinationId: 'dest1',
      timezone: 'UTC',
    };
    const result = normalizeTsEntity(tsEntity);

    expect(result.name).toBe('Test Ride');
  });
});

describe('normalizeJsLiveData', () => {
  test('strips underscore prefix from _id', () => {
    const jsLive = { _id: 'ride1', status: 'OPERATING', queue: { STANDBY: { waitTime: 30 } } };
    const result = normalizeJsLiveData(jsLive);

    expect(result.id).toBe('ride1');
    expect(result).not.toHaveProperty('_id');
  });
});

describe('normalizeTsLiveData', () => {
  test('stringifies id', () => {
    const tsLive = { id: 'ride1', status: 'OPERATING', queue: { STANDBY: { waitTime: 30 } } };
    const result = normalizeTsLiveData(tsLive);

    expect(result.id).toBe('ride1');
  });
});

describe('normalizeJsSchedule', () => {
  test('strips underscore prefix from _id', () => {
    const jsSched = { _id: 'park1', schedule: [{ date: '2025-03-15', type: 'OPERATING' }] };
    const result = normalizeJsSchedule(jsSched);

    expect(result.id).toBe('park1');
    expect(result).not.toHaveProperty('_id');
  });
});

describe('normalizeTsSchedule', () => {
  test('stringifies id', () => {
    const tsSched = { id: 'park1', schedule: [{ date: '2025-03-15', type: 'OPERATING' }] };
    const result = normalizeTsSchedule(tsSched);

    expect(result.id).toBe('park1');
  });
});

describe('sortById', () => {
  test('sorts items by id field', () => {
    const items = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
    const result = sortById(items);

    expect(result.map(i => i.id)).toEqual(['a', 'b', 'c']);
  });

  test('does not mutate original array', () => {
    const items = [{ id: 'b' }, { id: 'a' }];
    sortById(items);

    expect(items[0].id).toBe('b');
  });
});

describe('buildLiveDataStructure', () => {
  test('extracts entity IDs, queue types, and status types', () => {
    const liveData = [
      { id: 'a', status: 'OPERATING', queue: { STANDBY: { waitTime: 30 } } },
      { id: 'b', status: 'CLOSED', queue: { STANDBY: { waitTime: null }, RETURN_TIME: { state: 'AVAILABLE' } } },
    ];
    const result = buildLiveDataStructure(liveData);

    expect(result.entityIds).toEqual(['a', 'b']);
    expect(result.perEntityQueueTypes).toEqual({ a: ['STANDBY'], b: ['RETURN_TIME', 'STANDBY'] });
    expect(result.statusTypes).toEqual(['CLOSED', 'OPERATING']);
  });
});

describe('buildScheduleStructure', () => {
  test('extracts entity IDs and counts', () => {
    const schedules = [
      { id: 'park1', schedule: [{ date: '2025-03-15' }] },
      { id: 'park2', schedule: [] },
    ];
    const result = buildScheduleStructure(schedules);

    expect(result.entityIds).toEqual(['park1', 'park2']);
    expect(result.entityCount).toBe(2);
    expect(result.hasScheduleEntries).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/harness/__tests__/normalizer.test.ts`
Expected: FAIL — module `../normalizer.js` not found

- [ ] **Step 3: Implement normalizer**

```typescript
// src/harness/normalizer.ts
import type { NormalizedEntity } from './types.js';

/**
 * Normalize a JS entity to common format.
 * Strips underscore prefixes, removes slug, stringifies IDs.
 */
export function normalizeJsEntity(raw: any): NormalizedEntity {
  return {
    id: String(raw._id ?? raw.id),
    name: String(raw.name ?? ''),
    entityType: raw.entityType,
    parentId: raw._parentId != null ? String(raw._parentId) : null,
    destinationId: raw._destinationId != null ? String(raw._destinationId) : null,
    parkId: raw._parkId != null ? String(raw._parkId) : null,
    timezone: raw.timezone ?? 'UTC',
    location: raw.location
      ? { latitude: Number(raw.location.latitude), longitude: Number(raw.location.longitude) }
      : null,
  };
}

/**
 * Normalize a TS entity to common format.
 * Extracts English from multi-language names, stringifies IDs.
 */
export function normalizeTsEntity(raw: any): NormalizedEntity {
  let name: string;
  if (typeof raw.name === 'string') {
    name = raw.name;
  } else if (typeof raw.name === 'object' && raw.name !== null) {
    name = raw.name.en ?? raw.name['en-us'] ?? raw.name['en-gb'] ?? Object.values(raw.name)[0] ?? '';
  } else {
    name = '';
  }

  return {
    id: String(raw.id),
    name,
    entityType: raw.entityType,
    parentId: raw.parentId != null ? String(raw.parentId) : null,
    destinationId: raw.destinationId != null ? String(raw.destinationId) : null,
    parkId: raw.parkId != null ? String(raw.parkId) : null,
    timezone: raw.timezone ?? 'UTC',
    location: raw.location
      ? { latitude: Number(raw.location.latitude), longitude: Number(raw.location.longitude) }
      : null,
  };
}

/**
 * Normalize JS live data entry (strip _id prefix).
 */
export function normalizeJsLiveData(raw: any): any {
  const { _id, ...rest } = raw;
  return { id: String(_id ?? raw.id), ...rest };
}

/**
 * Normalize TS live data entry (ensure string ID).
 */
export function normalizeTsLiveData(raw: any): any {
  return { ...raw, id: String(raw.id ?? raw.entityId) };
}

/**
 * Normalize JS schedule entry (strip _id prefix).
 */
export function normalizeJsSchedule(raw: any): any {
  const { _id, ...rest } = raw;
  return { id: String(_id ?? raw.id), ...rest };
}

/**
 * Normalize TS schedule entry (ensure string ID).
 */
export function normalizeTsSchedule(raw: any): any {
  return { ...raw, id: String(raw.id) };
}

/**
 * Sort normalized entities by ID for stable comparison.
 */
export function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Build snapshot live data structure from raw live data entries.
 */
export function buildLiveDataStructure(liveData: any[]): {
  entityIds: string[];
  perEntityQueueTypes: Record<string, string[]>;
  statusTypes: string[];
} {
  const entityIds: string[] = [];
  const perEntityQueueTypes: Record<string, string[]> = {};
  const statusTypes = new Set<string>();

  for (const entry of liveData) {
    const id = String(entry.id);
    entityIds.push(id);

    if (entry.status) {
      statusTypes.add(entry.status);
    }

    if (entry.queue && typeof entry.queue === 'object') {
      perEntityQueueTypes[id] = Object.keys(entry.queue).sort();
    }
  }

  return {
    entityIds: entityIds.sort(),
    perEntityQueueTypes,
    statusTypes: [...statusTypes].sort(),
  };
}

/**
 * Build snapshot schedule structure from raw schedule entries.
 */
export function buildScheduleStructure(schedules: any[]): {
  entityIds: string[];
  entityCount: number;
  hasScheduleEntries: boolean;
} {
  const entityIds = schedules.map(s => String(s.id)).sort();
  const hasScheduleEntries = schedules.some(
    s => Array.isArray(s.schedule) && s.schedule.length > 0
  );

  return {
    entityIds,
    entityCount: schedules.length,
    hasScheduleEntries,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/harness/__tests__/normalizer.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/harness/normalizer.ts src/harness/__tests__/normalizer.test.ts
git commit -m "feat(harness): add normalizer for JS and TS park output"
```

---

### Task 3: Differ

**Files:**
- Create: `src/harness/__tests__/differ.test.ts`
- Create: `src/harness/differ.ts`

- [ ] **Step 1: Write failing tests for entity diffing**

```typescript
// src/harness/__tests__/differ.test.ts
import { describe, test, expect } from 'vitest';
import { diffEntities, diffLiveData, diffSchedules } from '../differ.js';
import type { NormalizedEntity, Snapshot } from '../types.js';

const makeEntity = (overrides: Partial<NormalizedEntity> = {}): NormalizedEntity => ({
  id: 'ride1',
  name: 'Test Ride',
  entityType: 'ATTRACTION',
  parentId: 'park1',
  destinationId: 'dest1',
  parkId: 'park1',
  timezone: 'America/New_York',
  location: null,
  ...overrides,
});

describe('diffEntities', () => {
  test('reports exact match when entities are identical', () => {
    const entities = [makeEntity()];
    const result = diffEntities(entities, entities);

    expect(result.matches).toBe(1);
    expect(result.mismatches).toHaveLength(0);
    expect(result.missingInTs).toHaveLength(0);
    expect(result.extraInTs).toHaveLength(0);
  });

  test('reports missing entities', () => {
    const snapshot = [makeEntity({ id: 'a' }), makeEntity({ id: 'b' })];
    const ts = [makeEntity({ id: 'a' })];
    const result = diffEntities(snapshot, ts);

    expect(result.missingInTs).toEqual(['b']);
  });

  test('reports extra entities in TS', () => {
    const snapshot = [makeEntity({ id: 'a' })];
    const ts = [makeEntity({ id: 'a' }), makeEntity({ id: 'b' })];
    const result = diffEntities(snapshot, ts);

    expect(result.extraInTs).toEqual(['b']);
  });

  test('reports field mismatches', () => {
    const snapshot = [makeEntity({ id: 'a', name: 'Old Name' })];
    const ts = [makeEntity({ id: 'a', name: 'New Name' })];
    const result = diffEntities(snapshot, ts);

    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toEqual({
      id: 'a', field: 'name', snapshot: 'Old Name', ts: 'New Name',
    });
  });

  test('does not compare location (warning only)', () => {
    const snapshot = [makeEntity({ id: 'a', location: { latitude: 28, longitude: -81 } })];
    const ts = [makeEntity({ id: 'a', location: null })];
    const result = diffEntities(snapshot, ts);

    // Location differences are not mismatches
    expect(result.mismatches).toHaveLength(0);
    expect(result.matches).toBe(1);
  });
});

describe('diffLiveData', () => {
  test('reports matching entity IDs', () => {
    const snapshotLive = { entityIds: ['a', 'b'], perEntityQueueTypes: { a: ['STANDBY'], b: ['STANDBY'] }, statusTypes: ['OPERATING'] };
    const tsLive = { entityIds: ['a', 'b'], perEntityQueueTypes: { a: ['STANDBY'], b: ['STANDBY'] }, statusTypes: ['OPERATING'] };
    const result = diffLiveData(snapshotLive, tsLive);

    expect(result.missingIds).toHaveLength(0);
    expect(result.structureValid).toBe(true);
  });

  test('reports missing live data entity IDs', () => {
    const snapshotLive = { entityIds: ['a', 'b', 'c'], perEntityQueueTypes: {}, statusTypes: [] };
    const tsLive = { entityIds: ['a'], perEntityQueueTypes: {}, statusTypes: [] };
    const result = diffLiveData(snapshotLive, tsLive);

    expect(result.missingIds).toEqual(['b', 'c']);
  });

  test('reports per-entity queue type mismatches', () => {
    const snapshotLive = { entityIds: ['a'], perEntityQueueTypes: { a: ['STANDBY', 'RETURN_TIME'] }, statusTypes: [] };
    const tsLive = { entityIds: ['a'], perEntityQueueTypes: { a: ['STANDBY'] }, statusTypes: [] };
    const result = diffLiveData(snapshotLive, tsLive);

    expect(result.queueTypeMismatches).toHaveLength(1);
    expect(result.queueTypeMismatches[0].id).toBe('a');
  });
});

describe('diffSchedules', () => {
  test('reports matching schedule entity IDs', () => {
    const snapshotSched = { entityIds: ['a', 'b'], entityCount: 2, hasScheduleEntries: true };
    const tsSched = { entityIds: ['a', 'b'], entityCount: 2, hasScheduleEntries: true };
    const result = diffSchedules(snapshotSched, tsSched);

    expect(result.missingIds).toHaveLength(0);
    expect(result.structureValid).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/harness/__tests__/differ.test.ts`
Expected: FAIL — module `../differ.js` not found

- [ ] **Step 3: Implement differ**

```typescript
// src/harness/differ.ts
import type {
  NormalizedEntity,
  EntityDiffResult,
  LiveDataDiffResult,
  ScheduleDiffResult,
  ComparisonReport,
  Snapshot,
} from './types.js';

/** Fields to compare strictly between entities */
const COMPARED_FIELDS: (keyof NormalizedEntity)[] = [
  'entityType', 'name', 'parentId', 'timezone',
];

/**
 * Compare two entity lists. Entities are matched by ID.
 * Location and tags are excluded from comparison.
 */
export function diffEntities(
  snapshotEntities: NormalizedEntity[],
  tsEntities: NormalizedEntity[],
): EntityDiffResult {
  const snapshotMap = new Map(snapshotEntities.map(e => [e.id, e]));
  const tsMap = new Map(tsEntities.map(e => [e.id, e]));

  const missingInTs: string[] = [];
  const extraInTs: string[] = [];
  const mismatches: EntityDiffResult['mismatches'] = [];
  let matches = 0;

  // Check all snapshot entities exist in TS
  for (const [id, snapshotEntity] of snapshotMap) {
    const tsEntity = tsMap.get(id);
    if (!tsEntity) {
      missingInTs.push(id);
      continue;
    }

    let hasFieldMismatch = false;
    for (const field of COMPARED_FIELDS) {
      const snapshotVal = snapshotEntity[field] ?? null;
      const tsVal = tsEntity[field] ?? null;
      if (snapshotVal !== tsVal) {
        mismatches.push({ id, field, snapshot: snapshotVal, ts: tsVal });
        hasFieldMismatch = true;
      }
    }

    if (!hasFieldMismatch) {
      matches++;
    }
  }

  // Check for extra entities in TS
  for (const id of tsMap.keys()) {
    if (!snapshotMap.has(id)) {
      extraInTs.push(id);
    }
  }

  return { matches, mismatches, missingInTs, extraInTs };
}

/**
 * Compare live data structures (entity IDs and per-entity queue types).
 */
export function diffLiveData(
  snapshotLive: Snapshot['liveData'],
  tsLive: Snapshot['liveData'],
): LiveDataDiffResult {
  const tsIdSet = new Set(tsLive.entityIds);
  const missingIds = snapshotLive.entityIds.filter(id => !tsIdSet.has(id));

  const queueTypeMismatches: LiveDataDiffResult['queueTypeMismatches'] = [];
  for (const [id, snapshotTypes] of Object.entries(snapshotLive.perEntityQueueTypes)) {
    const tsTypes = tsLive.perEntityQueueTypes[id];
    if (tsTypes && JSON.stringify(snapshotTypes) !== JSON.stringify(tsTypes)) {
      queueTypeMismatches.push({ id, snapshot: snapshotTypes, ts: tsTypes });
    }
  }

  return {
    snapshotEntityIds: snapshotLive.entityIds.length,
    tsEntityIds: tsLive.entityIds.length,
    missingIds,
    queueTypeMismatches,
    structureValid: missingIds.length === 0 && queueTypeMismatches.length === 0,
  };
}

/**
 * Compare schedule structures (entity IDs).
 */
export function diffSchedules(
  snapshotSched: Snapshot['schedules'],
  tsSched: Snapshot['schedules'],
): ScheduleDiffResult {
  const tsIdSet = new Set(tsSched.entityIds);
  const missingIds = snapshotSched.entityIds.filter(id => !tsIdSet.has(id));

  return {
    snapshotEntityIds: snapshotSched.entityIds.length,
    tsEntityIds: tsSched.entityIds.length,
    missingIds,
    structureValid: missingIds.length === 0,
  };
}

/**
 * Build a full comparison report.
 */
export function buildReport(
  parkId: string,
  snapshotEntities: NormalizedEntity[],
  tsEntities: NormalizedEntity[],
  snapshotLive: Snapshot['liveData'],
  tsLive: Snapshot['liveData'],
  snapshotSched: Snapshot['schedules'],
  tsSched: Snapshot['schedules'],
): ComparisonReport {
  const entityDiff = diffEntities(snapshotEntities, tsEntities);
  const liveDiff = diffLiveData(snapshotLive, tsLive);
  const schedDiff = diffSchedules(snapshotSched, tsSched);

  const failed = entityDiff.missingInTs.length > 0 || !liveDiff.structureValid || !schedDiff.structureValid;

  return {
    parkId,
    timestamp: new Date().toISOString(),
    result: failed ? 'FAIL' : 'PASS',
    entities: {
      snapshotCount: snapshotEntities.length,
      tsCount: tsEntities.length,
      ...entityDiff,
    },
    liveData: liveDiff,
    schedules: schedDiff,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/harness/__tests__/differ.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/harness/differ.ts src/harness/__tests__/differ.test.ts
git commit -m "feat(harness): add differ for entity, live data, and schedule comparison"
```

---

### Task 4: Reporter

**Files:**
- Create: `src/harness/reporter.ts`

- [ ] **Step 1: Implement reporter (no tests needed — pure formatting output)**

```typescript
// src/harness/reporter.ts
import * as fs from 'fs';
import * as path from 'path';
import type { ComparisonReport } from './types.js';

/**
 * Print comparison report to console.
 */
export function printReport(report: ComparisonReport, snapshotDate: string): void {
  console.log(`\nComparing: ${report.parkId}`);
  console.log(`Snapshot: ${snapshotDate} (js) | Live: ts\n`);

  // Entities
  const { entities } = report;
  console.log(`ENTITIES (${entities.snapshotCount} in snapshot, ${entities.tsCount} in TS)`);
  console.log(`  ${entities.matches} exact matches`);
  if (entities.mismatches.length > 0) {
    console.log(`  ${entities.mismatches.length} field mismatches:`);
    for (const m of entities.mismatches) {
      console.log(`    ${m.id}: ${m.field} differs`);
      console.log(`      snapshot: ${JSON.stringify(m.snapshot)}`);
      console.log(`      ts:       ${JSON.stringify(m.ts)}`);
    }
  }
  console.log(`  ${entities.missingInTs.length} missing in TS${entities.missingInTs.length > 0 ? ': ' + entities.missingInTs.join(', ') : ''}`);
  console.log(`  ${entities.extraInTs.length} extra in TS${entities.extraInTs.length > 0 ? ': ' + entities.extraInTs.join(', ') : ''}`);

  // Live data
  const { liveData } = report;
  console.log(`\nLIVE DATA (${liveData.snapshotEntityIds} in snapshot, ${liveData.tsEntityIds} in TS)`);
  console.log(`  ${liveData.tsEntityIds}/${liveData.snapshotEntityIds} entity IDs present`);
  if (liveData.queueTypeMismatches.length > 0) {
    console.log(`  ${liveData.queueTypeMismatches.length} queue type mismatches:`);
    for (const m of liveData.queueTypeMismatches) {
      console.log(`    ${m.id}: snapshot=${m.snapshot.join(',')} ts=${m.ts.join(',')}`);
    }
  } else {
    console.log(`  Per-entity queue types match`);
  }

  // Schedules
  const { schedules } = report;
  console.log(`\nSCHEDULES (${schedules.snapshotEntityIds} in snapshot, ${schedules.tsEntityIds} in TS)`);
  console.log(`  ${schedules.tsEntityIds}/${schedules.snapshotEntityIds} entity IDs present`);

  // Result
  const icon = report.result === 'PASS' ? 'PASS' : 'FAIL';
  const detail = report.result === 'FAIL'
    ? ` (${report.entities.missingInTs.length} missing entities, ${report.liveData.missingIds.length} missing live data)`
    : '';
  console.log(`\nRESULT: ${icon}${detail}\n`);
}

/**
 * Write machine-readable report JSON to disk.
 */
export function writeReportJson(report: ComparisonReport, snapshotsDir: string): string {
  const reportPath = path.join(snapshotsDir, `${report.parkId}.report.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  return reportPath;
}

/**
 * Print summary for --all mode.
 */
export function printSummary(reports: ComparisonReport[]): void {
  const passed = reports.filter(r => r.result === 'PASS');
  const failed = reports.filter(r => r.result === 'FAIL');

  console.log(`\nSUMMARY: ${passed.length}/${reports.length} parks passed${
    failed.length > 0 ? ', ' + failed.length + ' failed (' + failed.map(r => r.parkId).join(', ') + ')' : ''
  }\n`);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/harness/reporter.ts
git commit -m "feat(harness): add console and JSON report output"
```

---

### Task 5: JS Runner

**Files:**
- Create: `src/harness/jsRunner.mjs`

- [ ] **Step 1: Create the ESM runner script**

```javascript
// src/harness/jsRunner.mjs
//
// Standalone ESM script — spawned as a child process against the JS codebase.
// Usage: node --env-file=.env src/harness/jsRunner.mjs <JsClassName>
//
// Writes JSON to stdout: { entities: [...], liveData: [...], schedules: [...] }
// Errors go to stderr. Non-zero exit on failure.

import { pathToFileURL } from 'url';
import * as path from 'path';

const className = process.argv[2];

if (!className) {
  console.error('Usage: node jsRunner.mjs <JsClassName>');
  process.exit(1);
}

try {
  // Dynamic import of the JS codebase entry point.
  // ESM import() resolves relative to import.meta.url, NOT process.cwd().
  // We must construct an absolute file:// URL from cwd to reach lib/index.js.
  const entryPath = pathToFileURL(path.resolve(process.cwd(), 'lib/index.js')).href;
  const mod = await import(entryPath);
  const destinations = mod.default?.destinations ?? mod.destinations;

  if (!destinations) {
    console.error('Could not find destinations export in lib/index.js');
    process.exit(1);
  }

  const DestClass = destinations[className];
  if (!DestClass) {
    console.error(`Class "${className}" not found in destinations. Available: ${Object.keys(destinations).join(', ')}`);
    process.exit(1);
  }

  const instance = new DestClass();

  // Fetch all three data types
  const entities = await instance.getAllEntities();
  const liveData = await instance.getEntityLiveData();
  const schedules = await instance.getEntitySchedules();

  // Write to stdout as JSON
  const output = JSON.stringify({ entities, liveData, schedules });
  process.stdout.write(output);

  process.exit(0);
} catch (error) {
  console.error(`jsRunner error for ${className}:`, error.message || error);
  process.exit(1);
}
```

- [ ] **Step 2: Manually verify the runner works with the JS codebase**

Run (from TS project root — will fail without .env credentials but should import correctly):
```bash
cd ../parksapi_js && node --env-file=.env ../parksapi/src/harness/jsRunner.mjs UniversalOrlando 2>&1 | head -c 200
```
Expected: Either JSON output (if credentials present) or a clear API error (not an import/syntax error).

- [ ] **Step 3: Commit**

```bash
git add src/harness/jsRunner.mjs
git commit -m "feat(harness): add ESM JS runner for spawning against legacy codebase"
```

---

### Task 6: CLI entry point (compare.ts)

**Files:**
- Create: `src/harness/compare.ts`
- Modify: `package.json` (add `harness` script)

- [ ] **Step 1: Implement the CLI orchestrator**

```typescript
// src/harness/compare.ts
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { getDestinationById, getAllDestinations } from '../destinationRegistry.js';
import { normalizeJsEntity, normalizeJsLiveData, normalizeJsSchedule, normalizeTsEntity, normalizeTsLiveData, normalizeTsSchedule, sortById, buildLiveDataStructure, buildScheduleStructure } from './normalizer.js';
import { buildReport } from './differ.js';
import { printReport, writeReportJson, printSummary } from './reporter.js';
import { parkMapping } from './parkMapping.js';
import type { Snapshot, RawParkOutput, NormalizedEntity, ComparisonReport } from './types.js';
import { SNAPSHOT_VERSION } from './types.js';
import { waitForHttpQueue, stopHttpQueue } from '../http.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const JS_CODEBASE = path.resolve(PROJECT_ROOT, '../parksapi_js');
const SNAPSHOTS_DIR = path.resolve(PROJECT_ROOT, 'snapshots');
const JS_RUNNER_PATH = path.resolve(__dirname, 'jsRunner.mjs');

// Ensure snapshots directory exists
if (!fs.existsSync(SNAPSHOTS_DIR)) {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
}

/**
 * Run JS runner as child process and parse output.
 */
function runJsRunner(jsClassName: string): Promise<RawParkOutput> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'node',
      ['--env-file=.env', JS_RUNNER_PATH, jsClassName],
      { cwd: JS_CODEBASE, timeout: 120_000, maxBuffer: 50 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`JS runner failed for ${jsClassName}: ${stderr || error.message}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`JS runner returned invalid JSON for ${jsClassName}: ${stdout.slice(0, 200)}`));
        }
      },
    );
  });
}

/**
 * Run TS park and collect output.
 */
async function runTsPark(parkId: string): Promise<RawParkOutput> {
  const entry = await getDestinationById(parkId);
  if (!entry) throw new Error(`TS park not found: ${parkId}`);

  const park = new entry.DestinationClass();
  const entities = await park.getEntities();
  await waitForHttpQueue();
  const liveData = await park.getLiveData();
  await waitForHttpQueue();
  const schedules = await park.getSchedules();
  await waitForHttpQueue();

  return { entities, liveData, schedules };
}

/**
 * Build a snapshot from raw park output (JS side).
 */
function buildSnapshot(parkId: string, raw: RawParkOutput): Snapshot {
  const normalizedEntities = sortById(raw.entities.map(normalizeJsEntity));
  const normalizedLive = raw.liveData.map(normalizeJsLiveData);
  const normalizedSched = raw.schedules.map(normalizeJsSchedule);

  return {
    parkId,
    capturedAt: new Date().toISOString(),
    source: 'js',
    version: SNAPSHOT_VERSION,
    entities: normalizedEntities,
    liveData: buildLiveDataStructure(normalizedLive),
    schedules: buildScheduleStructure(normalizedSched),
  };
}

/**
 * Load snapshot from disk.
 */
function loadSnapshot(parkId: string): Snapshot | null {
  const filePath = path.join(SNAPSHOTS_DIR, `${parkId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * Save snapshot to disk.
 */
function saveSnapshot(snapshot: Snapshot): string {
  const filePath = path.join(SNAPSHOTS_DIR, `${snapshot.parkId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2) + '\n');
  return filePath;
}

// --- CLI ---

const args = process.argv.slice(2);
const command = args[0]; // 'capture', 'compare', 'list'
const forceFlag = args.includes('--force');
const allFlag = args.includes('--all');
const parkIdArg = args.find(a => a !== command && !a.startsWith('--'));

async function captureOne(parkId: string, jsClassName: string): Promise<boolean> {
  const existing = loadSnapshot(parkId);
  if (existing && !forceFlag) {
    console.log(`Snapshot exists for ${parkId} (captured ${existing.capturedAt}). Use --force to overwrite.`);
    return true;
  }

  console.log(`Capturing: ${parkId} (JS class: ${jsClassName})...`);
  try {
    const raw = await runJsRunner(jsClassName);
    const snapshot = buildSnapshot(parkId, raw);
    const filePath = saveSnapshot(snapshot);
    console.log(`  Saved: ${filePath} (${snapshot.entities.length} entities, ${snapshot.liveData.entityIds.length} live data, ${snapshot.schedules.entityIds.length} schedules)`);
    return true;
  } catch (err: any) {
    console.error(`  Failed: ${err.message}`);
    return false;
  }
}

async function compareOne(parkId: string): Promise<boolean> {
  const snapshot = loadSnapshot(parkId);
  if (!snapshot) {
    console.error(`No snapshot for ${parkId}. Run: npm run harness -- capture ${parkId}`);
    return false;
  }

  if (snapshot.version !== SNAPSHOT_VERSION) {
    console.warn(`Warning: snapshot version ${snapshot.version} differs from current ${SNAPSHOT_VERSION}`);
  }

  console.log(`Comparing: ${parkId}...`);
  try {
    const raw = await runTsPark(parkId);
    const tsEntities = sortById(raw.entities.map(normalizeTsEntity));
    const tsLive = buildLiveDataStructure(raw.liveData.map(normalizeTsLiveData));
    const tsSched = buildScheduleStructure(raw.schedules.map(normalizeTsSchedule));

    const report = buildReport(
      parkId,
      snapshot.entities,
      tsEntities,
      snapshot.liveData,
      tsLive,
      snapshot.schedules,
      tsSched,
    );

    printReport(report, snapshot.capturedAt.split('T')[0]);
    writeReportJson(report, SNAPSHOTS_DIR);
    return report.result === 'PASS';
  } catch (err: any) {
    console.error(`  Failed: ${err.message}`);
    return false;
  }
}

async function listParks(): Promise<void> {
  const tsDestinations = await getAllDestinations();
  const tsIds = new Set(tsDestinations.map(d => d.id));

  console.log('\nPark ID                    Snapshot    TS    JS Class');
  console.log('-'.repeat(70));

  for (const [tsId, jsClass] of Object.entries(parkMapping)) {
    const hasSnapshot = loadSnapshot(tsId) !== null;
    const hasTs = tsIds.has(tsId);
    console.log(
      `${tsId.padEnd(27)}${hasSnapshot ? 'yes' : '-  '}         ${hasTs ? 'yes' : '-  '}   ${jsClass}`
    );
  }
  console.log('');
}

async function main() {
  try {
    if (command === 'list') {
      await listParks();
    } else if (command === 'capture') {
      if (allFlag) {
        let passed = 0, failed = 0;
        for (const [parkId, jsClass] of Object.entries(parkMapping)) {
          const ok = await captureOne(parkId, jsClass);
          if (ok) passed++; else failed++;
        }
        console.log(`\nCapture complete: ${passed} succeeded, ${failed} failed`);
      } else if (parkIdArg) {
        const jsClass = parkMapping[parkIdArg];
        if (!jsClass) {
          console.error(`No JS mapping for park: ${parkIdArg}. Add it to src/harness/parkMapping.ts`);
          process.exit(1);
        }
        await captureOne(parkIdArg, jsClass);
      } else {
        console.error('Usage: npm run harness -- capture <parkId> | --all');
        process.exit(1);
      }
    } else if (command === 'compare') {
      let allPassed = true;
      if (allFlag) {
        const tsDestinations = await getAllDestinations();
        const tsIds = new Set(tsDestinations.map(d => d.id));
        const reports: ComparisonReport[] = [];
        for (const parkId of Object.keys(parkMapping)) {
          if (tsIds.has(parkId) && loadSnapshot(parkId)) {
            const ok = await compareOne(parkId);
            if (!ok) allPassed = false;
            // Load the report we just wrote for summary
            const reportPath = path.join(SNAPSHOTS_DIR, `${parkId}.report.json`);
            if (fs.existsSync(reportPath)) {
              reports.push(JSON.parse(fs.readFileSync(reportPath, 'utf-8')));
            }
          }
        }
        if (reports.length > 1) printSummary(reports);
      } else if (parkIdArg) {
        allPassed = await compareOne(parkIdArg);
      } else {
        console.error('Usage: npm run harness -- compare <parkId> | --all');
        process.exit(1);
      }
      stopHttpQueue();
      process.exit(allPassed ? 0 : 1);
    } else {
      console.log('Usage:');
      console.log('  npm run harness -- capture <parkId>     Capture JS park snapshot');
      console.log('  npm run harness -- capture --all        Capture all mapped parks');
      console.log('  npm run harness -- compare <parkId>     Compare TS vs snapshot');
      console.log('  npm run harness -- compare --all        Compare all parks');
      console.log('  npm run harness -- list                 Show park status');
      process.exit(0);
    }
  } finally {
    stopHttpQueue();
  }
}

main();
```

- [ ] **Step 2: Add npm script to package.json**

Add to the `"scripts"` section of `package.json`:
```json
"harness": "tsx --env-file=.env src/harness/compare.ts"
```

- [ ] **Step 3: Create `snapshots/.gitkeep` and add `.report.json` to `.gitignore`**

Create empty `snapshots/.gitkeep`.
Add `snapshots/*.report.json` to `.gitignore`.

- [ ] **Step 4: Verify the CLI runs without errors**

Run: `npm run harness -- list`
Expected: Shows table with universalorlando and universalstudios mapped, snapshot/TS status

Run: `npm run harness`
Expected: Shows usage help text

- [ ] **Step 5: Commit**

```bash
git add src/harness/compare.ts snapshots/.gitkeep package.json .gitignore
git commit -m "feat(harness): add CLI entry point with capture, compare, and list modes"
```

---

### Task 7: End-to-end test with Universal Orlando

**Files:** None (manual verification)

- [ ] **Step 1: Capture Universal Orlando snapshot from JS**

Run: `npm run harness -- capture universalorlando`
Expected: Snapshot saved to `snapshots/universalorlando.json` with entities, live data structure, and schedule structure.

- [ ] **Step 2: Inspect the snapshot**

Read `snapshots/universalorlando.json` and verify:
- Entities have normalized IDs (no underscore prefix)
- Entity types look correct (DESTINATION, PARK, ATTRACTION, etc.)
- Live data has per-entity queue types
- Schedule entity IDs present

- [ ] **Step 3: Compare TS Universal Orlando against snapshot**

Run: `npm run harness -- compare universalorlando`
Expected: Comparison report showing PASS or detailed mismatches to investigate.

- [ ] **Step 4: Fix any issues discovered during comparison**

If there are mismatches, investigate:
- Missing entities → check TS buildEntityList()
- Name mismatches → likely multi-language normalization
- Queue type mismatches → check TS buildLiveData()

- [ ] **Step 5: Commit snapshot if comparison passes**

```bash
git add snapshots/universalorlando.json
git commit -m "feat(harness): add Universal Orlando golden snapshot"
```
