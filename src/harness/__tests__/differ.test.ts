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
