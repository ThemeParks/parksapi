import * as fs from 'fs';
import * as path from 'path';
import type { ComparisonReport } from './types.js';

export function printReport(report: ComparisonReport, snapshotDate: string): void {
  console.log(`\nComparing: ${report.parkId}`);
  console.log(`Snapshot: ${snapshotDate} (js) | Live: ts\n`);

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

  const { schedules } = report;
  console.log(`\nSCHEDULES (${schedules.snapshotEntityIds} in snapshot, ${schedules.tsEntityIds} in TS)`);
  console.log(`  ${schedules.tsEntityIds}/${schedules.snapshotEntityIds} entity IDs present`);

  const icon = report.result === 'PASS' ? 'PASS' : 'FAIL';
  const detail = report.result === 'FAIL'
    ? ` (${report.entities.missingInTs.length} missing entities, ${report.liveData.missingIds.length} missing live data)`
    : '';
  console.log(`\nRESULT: ${icon}${detail}\n`);
}

export function writeReportJson(report: ComparisonReport, snapshotsDir: string): string {
  const reportPath = path.join(snapshotsDir, `${report.parkId}.report.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  return reportPath;
}

export function printSummary(reports: ComparisonReport[]): void {
  const passed = reports.filter(r => r.result === 'PASS');
  const failed = reports.filter(r => r.result === 'FAIL');

  console.log(`\nSUMMARY: ${passed.length}/${reports.length} parks passed${
    failed.length > 0 ? ', ' + failed.length + ' failed (' + failed.map(r => r.parkId).join(', ') + ')' : ''
  }\n`);
}
