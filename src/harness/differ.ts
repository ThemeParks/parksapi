import type {
  NormalizedEntity,
  EntityDiffResult,
  LiveDataDiffResult,
  ScheduleDiffResult,
  ComparisonReport,
  Snapshot,
} from './types.js';

const COMPARED_FIELDS: (keyof NormalizedEntity)[] = [
  'entityType', 'name', 'parentId', 'timezone',
];

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

  for (const id of tsMap.keys()) {
    if (!snapshotMap.has(id)) {
      extraInTs.push(id);
    }
  }

  return { matches, mismatches, missingInTs, extraInTs };
}

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
