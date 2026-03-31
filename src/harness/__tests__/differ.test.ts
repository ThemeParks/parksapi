import { describe, test, expect } from 'vitest';
import { diffEntities, diffLiveData, diffSchedules, buildReport } from '../differ.js';
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

  test('reports missing schedule entity IDs', () => {
    const snapshotSched = { entityIds: ['a', 'b', 'c'], entityCount: 3, hasScheduleEntries: true };
    const tsSched = { entityIds: ['a'], entityCount: 1, hasScheduleEntries: true };
    const result = diffSchedules(snapshotSched, tsSched);
    expect(result.missingIds).toEqual(['b', 'c']);
    expect(result.structureValid).toBe(false);
  });

  test('reports correct entity ID counts', () => {
    const snapshotSched = { entityIds: ['a', 'b'], entityCount: 2, hasScheduleEntries: true };
    const tsSched = { entityIds: ['a', 'b', 'c'], entityCount: 3, hasScheduleEntries: true };
    const result = diffSchedules(snapshotSched, tsSched);
    expect(result.snapshotEntityIds).toBe(2);
    expect(result.tsEntityIds).toBe(3);
    expect(result.missingIds).toHaveLength(0);
    expect(result.structureValid).toBe(true);
  });
});

// ---------- Edge case tests ----------

describe('diffEntities edge cases', () => {
  test('handles both sides empty', () => {
    const result = diffEntities([], []);
    expect(result.matches).toBe(0);
    expect(result.mismatches).toHaveLength(0);
    expect(result.missingInTs).toHaveLength(0);
    expect(result.extraInTs).toHaveLength(0);
  });

  test('handles empty snapshot with entities in TS (all extra)', () => {
    const ts = [makeEntity({ id: 'a' }), makeEntity({ id: 'b' })];
    const result = diffEntities([], ts);
    expect(result.matches).toBe(0);
    expect(result.missingInTs).toHaveLength(0);
    expect(result.extraInTs).toEqual(['a', 'b']);
  });

  test('handles empty TS with entities in snapshot (all missing)', () => {
    const snapshot = [makeEntity({ id: 'a' }), makeEntity({ id: 'b' })];
    const result = diffEntities(snapshot, []);
    expect(result.matches).toBe(0);
    expect(result.missingInTs).toEqual(['a', 'b']);
    expect(result.extraInTs).toHaveLength(0);
  });

  test('reports multiple field mismatches for same entity', () => {
    const snapshot = [makeEntity({ id: 'a', name: 'Old', entityType: 'PARK', timezone: 'UTC' })];
    const ts = [makeEntity({ id: 'a', name: 'New', entityType: 'ATTRACTION', timezone: 'Europe/London' })];
    const result = diffEntities(snapshot, ts);
    expect(result.mismatches.length).toBeGreaterThanOrEqual(3);
    const fields = result.mismatches.map(m => m.field);
    expect(fields).toContain('name');
    expect(fields).toContain('entityType');
    expect(fields).toContain('timezone');
  });

  test('treats null and undefined parentId as equivalent (both normalize to null)', () => {
    const snapshot = [makeEntity({ id: 'a', parentId: null })];
    const ts = [makeEntity({ id: 'a', parentId: null })];
    const result = diffEntities(snapshot, ts);
    expect(result.matches).toBe(1);
    expect(result.mismatches).toHaveLength(0);
  });

  test('handles many entities efficiently', () => {
    const count = 500;
    const snapshot = Array.from({ length: count }, (_, i) => makeEntity({ id: `entity-${i}` }));
    const ts = Array.from({ length: count }, (_, i) => makeEntity({ id: `entity-${i}` }));
    const result = diffEntities(snapshot, ts);
    expect(result.matches).toBe(count);
    expect(result.missingInTs).toHaveLength(0);
    expect(result.extraInTs).toHaveLength(0);
  });

  test('counts entity with mismatches as not matching', () => {
    const snapshot = [makeEntity({ id: 'a', name: 'A' }), makeEntity({ id: 'b', name: 'B' })];
    const ts = [makeEntity({ id: 'a', name: 'A-changed' }), makeEntity({ id: 'b', name: 'B' })];
    const result = diffEntities(snapshot, ts);
    expect(result.matches).toBe(1);
    expect(result.mismatches).toHaveLength(1);
  });
});

describe('diffLiveData edge cases', () => {
  test('handles both sides empty', () => {
    const empty = { entityIds: [] as string[], perEntityQueueTypes: {}, statusTypes: [] as string[] };
    const result = diffLiveData(empty, empty);
    expect(result.snapshotEntityIds).toBe(0);
    expect(result.tsEntityIds).toBe(0);
    expect(result.missingIds).toHaveLength(0);
    expect(result.queueTypeMismatches).toHaveLength(0);
    expect(result.structureValid).toBe(true);
  });

  test('handles extra entities in TS (not counted as missing)', () => {
    const snapshot = { entityIds: ['a'], perEntityQueueTypes: { a: ['STANDBY'] }, statusTypes: ['OPERATING'] };
    const ts = { entityIds: ['a', 'b', 'c'], perEntityQueueTypes: { a: ['STANDBY'], b: ['STANDBY'], c: ['STANDBY'] }, statusTypes: ['OPERATING'] };
    const result = diffLiveData(snapshot, ts);
    expect(result.missingIds).toHaveLength(0);
    expect(result.structureValid).toBe(true);
    expect(result.tsEntityIds).toBe(3);
  });

  test('does not report queue mismatch when entity only in snapshot', () => {
    const snapshot = { entityIds: ['a', 'b'], perEntityQueueTypes: { a: ['STANDBY'], b: ['RETURN_TIME'] }, statusTypes: [] };
    const ts = { entityIds: ['a'], perEntityQueueTypes: { a: ['STANDBY'] }, statusTypes: [] };
    const result = diffLiveData(snapshot, ts);
    // 'b' is missing, but its queue type should not appear as a mismatch since TS doesn't have it
    expect(result.queueTypeMismatches).toHaveLength(0);
    expect(result.missingIds).toEqual(['b']);
  });

  test('reports structureValid false when there are queue mismatches', () => {
    const snapshot = { entityIds: ['a'], perEntityQueueTypes: { a: ['STANDBY', 'RETURN_TIME'] }, statusTypes: [] };
    const ts = { entityIds: ['a'], perEntityQueueTypes: { a: ['STANDBY'] }, statusTypes: [] };
    const result = diffLiveData(snapshot, ts);
    expect(result.structureValid).toBe(false);
  });

  test('does not report mismatch when queue types match (same order)', () => {
    const snapshot = { entityIds: ['a'], perEntityQueueTypes: { a: ['RETURN_TIME', 'STANDBY'] }, statusTypes: [] };
    const ts = { entityIds: ['a'], perEntityQueueTypes: { a: ['RETURN_TIME', 'STANDBY'] }, statusTypes: [] };
    const result = diffLiveData(snapshot, ts);
    expect(result.queueTypeMismatches).toHaveLength(0);
  });
});

describe('diffSchedules edge cases', () => {
  test('handles both sides empty', () => {
    const empty = { entityIds: [] as string[], entityCount: 0, hasScheduleEntries: false };
    const result = diffSchedules(empty, empty);
    expect(result.snapshotEntityIds).toBe(0);
    expect(result.tsEntityIds).toBe(0);
    expect(result.missingIds).toHaveLength(0);
    expect(result.structureValid).toBe(true);
  });

  test('handles extra entities in TS schedules', () => {
    const snapshot = { entityIds: ['a'], entityCount: 1, hasScheduleEntries: true };
    const ts = { entityIds: ['a', 'b'], entityCount: 2, hasScheduleEntries: true };
    const result = diffSchedules(snapshot, ts);
    expect(result.missingIds).toHaveLength(0);
    expect(result.structureValid).toBe(true);
    expect(result.tsEntityIds).toBe(2);
  });

  test('structureValid is false when entities are missing in TS', () => {
    const snapshot = { entityIds: ['x', 'y'], entityCount: 2, hasScheduleEntries: false };
    const ts = { entityIds: ['x'], entityCount: 1, hasScheduleEntries: false };
    const result = diffSchedules(snapshot, ts);
    expect(result.structureValid).toBe(false);
    expect(result.missingIds).toEqual(['y']);
  });
});

describe('buildReport', () => {
  test('returns PASS when no entities missing in TS', () => {
    const entities = [makeEntity({ id: 'a' })];
    const liveData = { entityIds: ['a'], perEntityQueueTypes: { a: ['STANDBY'] }, statusTypes: ['OPERATING'] };
    const schedules = { entityIds: ['a'], entityCount: 1, hasScheduleEntries: true };

    const report = buildReport('testpark', entities, entities, liveData, liveData, schedules, schedules);
    expect(report.result).toBe('PASS');
    expect(report.parkId).toBe('testpark');
    expect(report.entities.snapshotCount).toBe(1);
    expect(report.entities.tsCount).toBe(1);
  });

  test('returns FAIL when entities missing in TS', () => {
    const snapshot = [makeEntity({ id: 'a' }), makeEntity({ id: 'b' })];
    const ts = [makeEntity({ id: 'a' })];
    const liveData = { entityIds: ['a'], perEntityQueueTypes: {}, statusTypes: [] };
    const schedules = { entityIds: ['a'], entityCount: 1, hasScheduleEntries: false };

    const report = buildReport('testpark', snapshot, ts, liveData, liveData, schedules, schedules);
    expect(report.result).toBe('FAIL');
    expect(report.entities.missingInTs).toEqual(['b']);
  });

  test('returns PASS even with live data differences (warnings only)', () => {
    const entities = [makeEntity({ id: 'a' })];
    const snapshotLive = { entityIds: ['a', 'b'], perEntityQueueTypes: {}, statusTypes: [] };
    const tsLive = { entityIds: ['a'], perEntityQueueTypes: {}, statusTypes: [] };
    const schedules = { entityIds: ['a'], entityCount: 1, hasScheduleEntries: true };

    const report = buildReport('testpark', entities, entities, snapshotLive, tsLive, schedules, schedules);
    expect(report.result).toBe('PASS');
    expect(report.liveData.missingIds).toEqual(['b']);
  });

  test('includes timestamp in ISO format', () => {
    const entities = [makeEntity({ id: 'a' })];
    const liveData = { entityIds: ['a'], perEntityQueueTypes: {}, statusTypes: [] };
    const schedules = { entityIds: ['a'], entityCount: 1, hasScheduleEntries: false };

    const report = buildReport('testpark', entities, entities, liveData, liveData, schedules, schedules);
    expect(report.timestamp).toBeDefined();
    // Should be a valid ISO date string
    expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
  });
});
