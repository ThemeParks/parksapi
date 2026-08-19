/**
 * Show-retirement calibration capture (parksapi #74 / #83).
 *
 * Polls local buildLiveData() output for one or more destinations and
 * appends one JSONL row per live entity, so the actual absence pattern
 * (how long a show genuinely disappears from the feed before it comes back
 * vs. before it's truly gone) can be measured over days rather than
 * guessed. Feeds calibration of Destination.liveEntityRetirementMs — see
 * destination.ts and the DLP/SHDR opt-ins.
 *
 * Deliberately dumb: no aggregation, no judgement calls, just id/status/
 * showtime-count/timestamp per poll. Analysis happens later, over the
 * accumulated file.
 *
 * Usage:
 *   tsx --env-file=.env src/tools/liveDataRetirement/capture.ts \
 *     --only=disneylandparis,shanghaidisneylandresort \
 *     --out=/home/cube/monitoring/parksapi-show-retirement/capture.jsonl
 */
import {appendFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {getDestinationById} from '../../destinationRegistry.js';
import {stopHttpQueue} from '../../http.js';
import {LiveData} from '@themeparks/typelib';

export interface CaptureRow {
  ts: string;
  parksApiId: string;
  id: string;
  status: string | null;
  showtimeCount: number;
}

/** Pure: turn one destination's live-data snapshot into capture rows. */
export function buildCaptureRows(parksApiId: string, liveData: LiveData[], ts: string): CaptureRow[] {
  return liveData.map((entry) => ({
    ts,
    parksApiId,
    id: entry.id,
    status: entry.status ?? null,
    showtimeCount: entry.showtimes?.length ?? 0,
  }));
}

function parseArgs(): {only: string[]; out: string} {
  const args = process.argv.slice(2);
  const onlyArg = args.find((a) => a.startsWith('--only='))?.split('=')[1];
  const outArg = args.find((a) => a.startsWith('--out='))?.split('=')[1];
  if (!onlyArg) throw new Error('--only=<parksApiId,...> is required');
  if (!outArg) throw new Error('--out=<path> is required');
  return {only: onlyArg.split(',').map((s) => s.trim()).filter(Boolean), out: outArg};
}

async function main() {
  const {only, out} = parseArgs();
  mkdirSync(dirname(out), {recursive: true});

  const ts = new Date().toISOString();
  let rowCount = 0;

  for (const parksApiId of only) {
    try {
      const entry = await getDestinationById(parksApiId);
      if (!entry) {
        console.error(`[capture] registry miss: ${parksApiId}`);
        continue;
      }
      const inst: any = new entry.DestinationClass();
      const liveData: LiveData[] = await inst.getLiveData();
      const rows = buildCaptureRows(parksApiId, liveData, ts);
      const lines = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
      appendFileSync(out, lines);
      rowCount += rows.length;
    } catch (e: any) {
      console.error(`[capture] ${parksApiId} failed: ${e.message}`);
    }
  }

  console.log(`[capture] ${ts} wrote ${rowCount} row(s) to ${out}`);
}

main().catch((err) => {
  console.error('[capture] fatal:', err);
  process.exitCode = 1;
}).finally(() => stopHttpQueue());
