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

// ---------- Edge case tests ----------

describe('normalizeJsEntity edge cases', () => {
  test('handles null _id by falling through to id field via ?? operator', () => {
    // _id: null triggers ?? fallback to raw.id
    const entity = {
      _id: null,
      id: 'backup-id',
      name: 'Null ID Ride',
      entityType: 'ATTRACTION',
      timezone: 'UTC',
    };
    const result = normalizeJsEntity(entity);
    expect(result.id).toBe('backup-id');
  });

  test('handles null _id with no id field, stringifies to "undefined"', () => {
    const entity = {
      _id: null,
      name: 'No ID',
      entityType: 'ATTRACTION',
      timezone: 'UTC',
    };
    const result = normalizeJsEntity(entity);
    expect(result.id).toBe('undefined');
  });

  test('handles undefined _id by falling back to id field', () => {
    const entity = {
      id: 'fallback-id',
      name: 'Fallback Ride',
      entityType: 'ATTRACTION',
      timezone: 'UTC',
    };
    const result = normalizeJsEntity(entity);
    expect(result.id).toBe('fallback-id');
  });

  test('handles numeric id field (no underscore prefix)', () => {
    const entity = {
      id: 42,
      name: 'Numeric',
      entityType: 'ATTRACTION',
      timezone: 'UTC',
    };
    const result = normalizeJsEntity(entity);
    expect(result.id).toBe('42');
  });

  test('returns empty string for missing name', () => {
    const entity = {
      _id: '1',
      entityType: 'PARK',
      timezone: 'UTC',
    };
    const result = normalizeJsEntity(entity);
    expect(result.name).toBe('');
  });

  test('handles null location as null', () => {
    const entity = {
      _id: '1',
      name: 'Test',
      entityType: 'PARK',
      timezone: 'UTC',
      location: null,
    };
    const result = normalizeJsEntity(entity);
    expect(result.location).toBeNull();
  });

  test('handles missing location as null', () => {
    const entity = {
      _id: '1',
      name: 'Test',
      entityType: 'PARK',
      timezone: 'UTC',
    };
    const result = normalizeJsEntity(entity);
    expect(result.location).toBeNull();
  });

  test('defaults timezone to UTC when missing', () => {
    const entity = {
      _id: '1',
      name: 'Test',
      entityType: 'PARK',
    };
    const result = normalizeJsEntity(entity);
    expect(result.timezone).toBe('UTC');
  });

  test('handles null _parkId as null', () => {
    const entity = {
      _id: '1',
      name: 'Test',
      entityType: 'ATTRACTION',
      _parkId: null,
      timezone: 'UTC',
    };
    const result = normalizeJsEntity(entity);
    expect(result.parkId).toBeNull();
  });
});

describe('normalizeTsEntity edge cases', () => {
  test('handles null name as empty string', () => {
    const entity = {
      id: '1',
      name: null,
      entityType: 'PARK',
      timezone: 'UTC',
    };
    const result = normalizeTsEntity(entity);
    expect(result.name).toBe('');
  });

  test('handles undefined name as empty string', () => {
    const entity = {
      id: '1',
      entityType: 'PARK',
      timezone: 'UTC',
    };
    const result = normalizeTsEntity(entity);
    expect(result.name).toBe('');
  });

  test('handles numeric id by stringifying', () => {
    const entity = {
      id: 99,
      name: 'Numeric',
      entityType: 'ATTRACTION',
      timezone: 'UTC',
    };
    const result = normalizeTsEntity(entity);
    expect(result.id).toBe('99');
  });

  test('falls back to en-us when en is missing', () => {
    const entity = {
      id: '1',
      name: { 'en-us': 'American Name', fr: 'Nom Francais' },
      entityType: 'ATTRACTION',
      timezone: 'UTC',
    };
    const result = normalizeTsEntity(entity);
    expect(result.name).toBe('American Name');
  });

  test('falls back to en-gb when en and en-us are missing', () => {
    const entity = {
      id: '1',
      name: { 'en-gb': 'British Name', fr: 'Nom Francais' },
      entityType: 'ATTRACTION',
      timezone: 'UTC',
    };
    const result = normalizeTsEntity(entity);
    expect(result.name).toBe('British Name');
  });

  test('handles empty multi-language object', () => {
    const entity = {
      id: '1',
      name: {},
      entityType: 'PARK',
      timezone: 'UTC',
    };
    const result = normalizeTsEntity(entity);
    // Object.values({}) returns [], so [0] is undefined, falls to ''
    expect(result.name).toBe('');
  });

  test('handles missing location as null', () => {
    const entity = {
      id: '1',
      name: 'Test',
      entityType: 'ATTRACTION',
      timezone: 'UTC',
    };
    const result = normalizeTsEntity(entity);
    expect(result.location).toBeNull();
  });

  test('handles null parentId as null', () => {
    const entity = {
      id: '1',
      name: 'Test',
      entityType: 'DESTINATION',
      parentId: null,
      timezone: 'UTC',
    };
    const result = normalizeTsEntity(entity);
    expect(result.parentId).toBeNull();
  });
});

describe('normalizeJsLiveData edge cases', () => {
  test('falls back to id field when _id is missing', () => {
    const live = { id: 'ride-fallback', status: 'CLOSED' };
    const result = normalizeJsLiveData(live);
    expect(result.id).toBe('ride-fallback');
  });

  test('preserves extra fields beside _id', () => {
    const live = { _id: 'r1', status: 'OPERATING', queue: { STANDBY: { waitTime: 5 } }, customField: true };
    const result = normalizeJsLiveData(live);
    expect(result.customField).toBe(true);
    expect(result.status).toBe('OPERATING');
  });
});

describe('normalizeTsLiveData edge cases', () => {
  test('falls back to entityId when id is missing', () => {
    const live = { entityId: 'entity-1', status: 'OPERATING' };
    const result = normalizeTsLiveData(live);
    expect(result.id).toBe('entity-1');
  });

  test('prefers id over entityId', () => {
    const live = { id: 'primary', entityId: 'secondary', status: 'CLOSED' };
    const result = normalizeTsLiveData(live);
    expect(result.id).toBe('primary');
  });
});

describe('normalizeJsSchedule edge cases', () => {
  test('falls back to id field when _id is missing', () => {
    const sched = { id: 'park-fallback', schedule: [] };
    const result = normalizeJsSchedule(sched);
    expect(result.id).toBe('park-fallback');
  });

  test('preserves schedule array', () => {
    const sched = { _id: 'p1', schedule: [{ date: '2025-01-01', type: 'OPERATING' }] };
    const result = normalizeJsSchedule(sched);
    expect(result.schedule).toEqual([{ date: '2025-01-01', type: 'OPERATING' }]);
  });
});

describe('normalizeTsSchedule edge cases', () => {
  test('stringifies numeric id', () => {
    const sched = { id: 123, schedule: [] };
    const result = normalizeTsSchedule(sched);
    expect(result.id).toBe('123');
  });
});

describe('buildLiveDataStructure edge cases', () => {
  test('handles empty live data array', () => {
    const result = buildLiveDataStructure([]);
    expect(result.entityIds).toEqual([]);
    expect(result.perEntityQueueTypes).toEqual({});
    expect(result.statusTypes).toEqual([]);
  });

  test('handles entries without status', () => {
    const liveData = [
      { id: 'a', queue: { STANDBY: { waitTime: 10 } } },
    ];
    const result = buildLiveDataStructure(liveData);
    expect(result.statusTypes).toEqual([]);
    expect(result.entityIds).toEqual(['a']);
  });

  test('handles entries without queue', () => {
    const liveData = [
      { id: 'a', status: 'CLOSED' },
    ];
    const result = buildLiveDataStructure(liveData);
    expect(result.perEntityQueueTypes).toEqual({});
    expect(result.statusTypes).toEqual(['CLOSED']);
  });

  test('deduplicates status types', () => {
    const liveData = [
      { id: 'a', status: 'OPERATING' },
      { id: 'b', status: 'OPERATING' },
      { id: 'c', status: 'CLOSED' },
    ];
    const result = buildLiveDataStructure(liveData);
    expect(result.statusTypes).toEqual(['CLOSED', 'OPERATING']);
  });

  test('stringifies numeric IDs', () => {
    const liveData = [
      { id: 42, status: 'OPERATING' },
    ];
    const result = buildLiveDataStructure(liveData);
    expect(result.entityIds).toEqual(['42']);
  });
});

describe('buildScheduleStructure edge cases', () => {
  test('handles empty schedule array', () => {
    const result = buildScheduleStructure([]);
    expect(result.entityIds).toEqual([]);
    expect(result.entityCount).toBe(0);
    expect(result.hasScheduleEntries).toBe(false);
  });

  test('returns hasScheduleEntries false when all schedules empty', () => {
    const schedules = [
      { id: 'a', schedule: [] },
      { id: 'b', schedule: [] },
    ];
    const result = buildScheduleStructure(schedules);
    expect(result.hasScheduleEntries).toBe(false);
  });

  test('handles entries without schedule array', () => {
    const schedules = [
      { id: 'a' },
    ];
    const result = buildScheduleStructure(schedules);
    expect(result.hasScheduleEntries).toBe(false);
    expect(result.entityCount).toBe(1);
  });

  test('sorts entity IDs alphabetically', () => {
    const schedules = [
      { id: 'z-park', schedule: [] },
      { id: 'a-park', schedule: [{ date: '2025-01-01' }] },
      { id: 'm-park', schedule: [] },
    ];
    const result = buildScheduleStructure(schedules);
    expect(result.entityIds).toEqual(['a-park', 'm-park', 'z-park']);
  });
});
