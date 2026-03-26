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

if (!fs.existsSync(SNAPSHOTS_DIR)) {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
}

function runJsRunner(jsClassName: string): Promise<RawParkOutput> {
  return new Promise((resolve, reject) => {
    execFile(
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

function loadSnapshot(parkId: string): Snapshot | null {
  const filePath = path.join(SNAPSHOTS_DIR, `${parkId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function saveSnapshot(snapshot: Snapshot): string {
  const filePath = path.join(SNAPSHOTS_DIR, `${snapshot.parkId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2) + '\n');
  return filePath;
}

const args = process.argv.slice(2);
const command = args[0];
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
