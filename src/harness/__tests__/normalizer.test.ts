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
