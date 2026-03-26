import type { NormalizedEntity } from './types.js';

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

export function normalizeJsLiveData(raw: any): any {
  const { _id, ...rest } = raw;
  return { id: String(_id ?? raw.id), ...rest };
}

export function normalizeTsLiveData(raw: any): any {
  return { ...raw, id: String(raw.id ?? raw.entityId) };
}

export function normalizeJsSchedule(raw: any): any {
  const { _id, ...rest } = raw;
  return { id: String(_id ?? raw.id), ...rest };
}

export function normalizeTsSchedule(raw: any): any {
  return { ...raw, id: String(raw.id) };
}

export function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

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
