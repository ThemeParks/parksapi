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
