/**
 * Live data audit
 *
 * Validates the shape and sanity of live data from either the wiki API
 * (remote), local parksapi emissions, or both (diff mode). Ensures every
 * LiveData item conforms to the typelib schema (types, enums, nested
 * shape) and flags anything suspicious (stale during operating hours,
 * zombie parks, empty destinations, waitTime out of range, etc.).
 *
 * Usage:
 *   npm run audit:live                 # remote-only, all destinations
 *   npm run audit:live -- --local      # local parksapi output only
 *   npm run audit:live -- --diff       # run local + remote, diff the two
 *   npm run audit:live -- --only=dlp,sixflags  # filter by parksapi id
 *   npm run audit:live -- --json       # machine-readable output
 */
import {getAllDestinations, getDestinationById} from '../../destinationRegistry.js';
import {stopHttpQueue} from '../../http.js';

// ── Enums (mirrored from typelib for validation) ─────────────────────

const LIVE_STATUSES = new Set(['OPERATING', 'DOWN', 'CLOSED', 'REFURBISHMENT']);
const QUEUE_TYPES = new Set(['STANDBY', 'SINGLE_RIDER', 'RETURN_TIME', 'PAID_RETURN_TIME', 'BOARDING_GROUP', 'PAID_STANDBY']);
const RETURN_STATES = new Set(['AVAILABLE', 'TEMP_FULL', 'FINISHED']);
const BOARDING_STATES = new Set(['AVAILABLE', 'PAUSED', 'CLOSED']);

const ENTITY_ID_RE = /^[\w.\-]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const MAX_WAIT_MINUTES = 600;
const MAX_STALE_OPEN_MINUTES = 30;
const MAX_FUTURE_MINUTES = 5;

// ── Types ────────────────────────────────────────────────────────────

type Issue = {
  level: 'error' | 'warn';
  path: string;
  message: string;
};

type LiveItem = {
  id?: unknown;
  status?: unknown;
  queue?: unknown;
  showtimes?: unknown;
  operatingHours?: unknown;
  diningAvailability?: unknown;
  lastUpdated?: unknown;
};

type DestReport = {
  parksApiId: string;
  wikiExternalId: string | null;
  name: string;
  source: 'local' | 'remote';
  totalItems: number;
  validItems: number;
  issues: Issue[];
  stats: {
    byStatus: Record<string, number>;
    withStandby: number;
    withSingleRider: number;
    withReturnTime: number;
    withPaidReturn: number;
    withBoarding: number;
    withPaidStandby: number;
    withShowtimes: number;
    withOperatingHours: number;
  };
  freshest: string | null;
  stalest: string | null;
  currentlyOpen: boolean | null;  // from getSchedules, if known
};

// ── Shape validation ────────────────────────────────────────────────

function validateLiveItem(item: LiveItem, idx: number): Issue[] {
  const issues: Issue[] = [];
  const pathFor = (key: string) => `[${idx}:${item.id ?? '?'}].${key}`;

  // id
  if (typeof item.id !== 'string') {
    issues.push({level: 'error', path: pathFor('id'), message: `id must be string, got ${typeof item.id}`});
  } else {
    if (!item.id) issues.push({level: 'error', path: pathFor('id'), message: 'id is empty'});
    if (!ENTITY_ID_RE.test(item.id)) issues.push({level: 'warn', path: pathFor('id'), message: `id "${item.id}" contains non-standard characters`});
  }

  // status
  if (item.status !== undefined) {
    if (typeof item.status !== 'string') {
      issues.push({level: 'error', path: pathFor('status'), message: `status must be string, got ${typeof item.status}`});
    } else if (!LIVE_STATUSES.has(item.status)) {
      issues.push({level: 'error', path: pathFor('status'), message: `invalid status "${item.status}"`});
    }
  }

  // queue
  if (item.queue !== undefined) {
    if (typeof item.queue !== 'object' || item.queue === null || Array.isArray(item.queue)) {
      issues.push({level: 'error', path: pathFor('queue'), message: 'queue must be an object'});
    } else {
      for (const [qType, q] of Object.entries(item.queue as Record<string, unknown>)) {
        if (!QUEUE_TYPES.has(qType)) {
          issues.push({level: 'error', path: pathFor(`queue.${qType}`), message: `unknown queue type`});
          continue;
        }
        issues.push(...validateQueueEntry(qType, q, pathFor(`queue.${qType}`)));
      }
    }
  }

  // showtimes + operatingHours (same shape: LiveTimeSlot[])
  for (const key of ['showtimes', 'operatingHours'] as const) {
    const val = item[key];
    if (val === undefined) continue;
    if (!Array.isArray(val)) {
      issues.push({level: 'error', path: pathFor(key), message: `${key} must be an array`});
      continue;
    }
    for (let i = 0; i < val.length; i++) {
      issues.push(...validateTimeSlot(val[i], pathFor(`${key}[${i}]`)));
    }
  }

  // lastUpdated (type-only; staleness is judged at the destination level, not per-item,
  // because closed/seasonal parks legitimately have months-old lastUpdated values)
  if (item.lastUpdated !== undefined) {
    if (typeof item.lastUpdated !== 'string') {
      issues.push({level: 'error', path: pathFor('lastUpdated'), message: `lastUpdated must be ISO string`});
    } else {
      const ts = Date.parse(item.lastUpdated);
      if (isNaN(ts)) {
        issues.push({level: 'error', path: pathFor('lastUpdated'), message: `lastUpdated "${item.lastUpdated}" is not parseable`});
      } else {
        const ageMs = Date.now() - ts;
        if (ageMs < -MAX_FUTURE_MINUTES * 60_000) {
          issues.push({level: 'warn', path: pathFor('lastUpdated'), message: `lastUpdated is in the future (${Math.abs(ageMs) / 60_000 | 0} min)`});
        }
      }
    }
  }

  // undefined leaks (should never happen after framework scrubber)
  for (const [k, v] of Object.entries(item)) {
    if (v === undefined) issues.push({level: 'error', path: pathFor(k), message: 'value is undefined (should be omitted)'});
  }

  return issues;
}

function validateQueueEntry(qType: string, q: unknown, path: string): Issue[] {
  const issues: Issue[] = [];
  if (typeof q !== 'object' || q === null) {
    issues.push({level: 'error', path, message: `queue entry must be object`});
    return issues;
  }
  const qe = q as Record<string, unknown>;

  switch (qType) {
    case 'STANDBY':
    case 'SINGLE_RIDER':
    case 'PAID_STANDBY': {
      const wt = qe.waitTime;
      if (wt !== undefined && wt !== null) {
        if (typeof wt !== 'number' || !Number.isFinite(wt)) {
          issues.push({level: 'error', path: `${path}.waitTime`, message: `waitTime must be finite number, got ${typeof wt} ${String(wt)}`});
        } else {
          if (wt < 0) issues.push({level: 'error', path: `${path}.waitTime`, message: `negative waitTime ${wt}`});
          if (wt > MAX_WAIT_MINUTES) issues.push({level: 'warn', path: `${path}.waitTime`, message: `absurd waitTime ${wt}`});
        }
      }
      break;
    }
    case 'RETURN_TIME':
    case 'PAID_RETURN_TIME': {
      const state = qe.state;
      if (typeof state !== 'string' || !RETURN_STATES.has(state)) {
        issues.push({level: 'error', path: `${path}.state`, message: `invalid state "${String(state)}"`});
      }
      for (const k of ['returnStart', 'returnEnd']) {
        const v = qe[k];
        if (v !== null && v !== undefined && typeof v !== 'string') {
          issues.push({level: 'error', path: `${path}.${k}`, message: `${k} must be string or null, got ${typeof v}`});
        } else if (typeof v === 'string' && !ISO_DATE_RE.test(v)) {
          issues.push({level: 'warn', path: `${path}.${k}`, message: `${k} "${v}" doesn't look like ISO date`});
        }
      }
      if (qType === 'PAID_RETURN_TIME') {
        const price = qe.price as Record<string, unknown> | undefined;
        if (!price) {
          issues.push({level: 'error', path: `${path}.price`, message: 'paid return time must include price'});
        } else {
          if (typeof price.currency !== 'string') issues.push({level: 'error', path: `${path}.price.currency`, message: 'currency must be string'});
          if (price.amount !== null && typeof price.amount !== 'number') issues.push({level: 'error', path: `${path}.price.amount`, message: 'amount must be number|null'});
        }
      }
      break;
    }
    case 'BOARDING_GROUP': {
      const as = qe.allocationStatus;
      if (typeof as !== 'string' || !BOARDING_STATES.has(as)) {
        issues.push({level: 'error', path: `${path}.allocationStatus`, message: `invalid allocationStatus "${String(as)}"`});
      }
      for (const k of ['currentGroupStart', 'currentGroupEnd', 'estimatedWait']) {
        const v = qe[k];
        if (v !== null && v !== undefined && typeof v !== 'number') {
          issues.push({level: 'error', path: `${path}.${k}`, message: `${k} must be number|null`});
        }
      }
      break;
    }
  }
  return issues;
}

function validateTimeSlot(s: unknown, path: string): Issue[] {
  const issues: Issue[] = [];
  if (typeof s !== 'object' || s === null) {
    issues.push({level: 'error', path, message: 'time slot must be object'});
    return issues;
  }
  const slot = s as Record<string, unknown>;
  if (typeof slot.type !== 'string') {
    issues.push({level: 'error', path: `${path}.type`, message: 'type must be string'});
  }
  for (const k of ['startTime', 'endTime']) {
    const v = slot[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') {
      issues.push({level: 'error', path: `${path}.${k}`, message: `${k} must be string|null|omitted`});
    } else if (!ISO_DATE_RE.test(v)) {
      issues.push({level: 'warn', path: `${path}.${k}`, message: `${k} "${v}" doesn't look like ISO date`});
    }
  }
  return issues;
}

// ── Report builder ─────────────────────────────────────────────────

function buildReport(
  parksApiId: string,
  wikiExternalId: string | null,
  name: string,
  source: 'local' | 'remote',
  liveData: LiveItem[],
  currentlyOpen: boolean | null,
): DestReport {
  const report: DestReport = {
    parksApiId, wikiExternalId, name, source,
    totalItems: liveData.length, validItems: 0, issues: [],
    stats: {
      byStatus: {}, withStandby: 0, withSingleRider: 0, withReturnTime: 0,
      withPaidReturn: 0, withBoarding: 0, withPaidStandby: 0,
      withShowtimes: 0, withOperatingHours: 0,
    },
    freshest: null, stalest: null, currentlyOpen,
  };

  let freshest = -Infinity;
  let stalest = Infinity;

  for (let i = 0; i < liveData.length; i++) {
    const item = liveData[i];
    const itemIssues = validateLiveItem(item, i);
    report.issues.push(...itemIssues);
    if (!itemIssues.some(x => x.level === 'error')) report.validItems++;

    const status = typeof item.status === 'string' ? item.status : '?';
    report.stats.byStatus[status] = (report.stats.byStatus[status] ?? 0) + 1;
    const q = item.queue as Record<string, unknown> | undefined;
    if (q) {
      if (q.STANDBY) report.stats.withStandby++;
      if (q.SINGLE_RIDER) report.stats.withSingleRider++;
      if (q.RETURN_TIME) report.stats.withReturnTime++;
      if (q.PAID_RETURN_TIME) report.stats.withPaidReturn++;
      if (q.BOARDING_GROUP) report.stats.withBoarding++;
      if (q.PAID_STANDBY) report.stats.withPaidStandby++;
    }
    if (Array.isArray(item.showtimes) && item.showtimes.length > 0) report.stats.withShowtimes++;
    if (Array.isArray(item.operatingHours) && item.operatingHours.length > 0) report.stats.withOperatingHours++;

    if (typeof item.lastUpdated === 'string') {
      const ts = Date.parse(item.lastUpdated);
      if (!isNaN(ts)) {
        if (ts > freshest) { freshest = ts; report.freshest = item.lastUpdated; }
        if (ts < stalest) { stalest = ts; report.stalest = item.lastUpdated; }
      }
    }
  }

  // Cross-item sanity: currently open + no recent updates
  if (currentlyOpen && report.freshest) {
    const ageMin = (Date.now() - new Date(report.freshest).getTime()) / 60_000;
    if (ageMin > MAX_STALE_OPEN_MINUTES) {
      report.issues.push({
        level: 'warn',
        path: '<destination>',
        message: `park is currently within operating hours but freshest item is ${ageMin.toFixed(0)}min old`,
      });
    }
  }

  // Empty park
  if (liveData.length === 0) {
    report.issues.push({level: 'warn', path: '<destination>', message: 'no live data items at all'});
  }

  return report;
}

// ── Data sources ────────────────────────────────────────────────────

type WikiDest = {id: string; name: string; slug: string; externalId: string};

async function fetchWikiDestinations(): Promise<WikiDest[]> {
  const r = await fetch('https://api.themeparks.wiki/v1/destinations');
  const data = (await r.json()) as {destinations: WikiDest[]};
  return data.destinations;
}

async function fetchRemoteLive(destUuid: string): Promise<LiveItem[]> {
  const r = await fetch(`https://api.themeparks.wiki/v1/entity/${destUuid}/live`);
  if (!r.ok) throw new Error(`wiki /live ${destUuid}: ${r.status}`);
  const data = (await r.json()) as {liveData?: LiveItem[]};
  return data.liveData ?? [];
}

async function emitLocalLive(parksApiId: string): Promise<LiveItem[]> {
  const entry = await getDestinationById(parksApiId);
  if (!entry) throw new Error(`registry miss: ${parksApiId}`);
  const inst: any = new entry.DestinationClass();
  const ld = await inst.getLiveData();
  return ld as LiveItem[];
}

/** Check the wiki for operating-hours data. Covers the whole tree under the destination. */
async function isCurrentlyOpenRemote(destUuid: string): Promise<boolean | null> {
  try {
    const r = await fetch(`https://api.themeparks.wiki/v1/entity/${destUuid}/schedule`);
    if (!r.ok) return null;
    const data = (await r.json()) as {schedule?: Array<{openingTime?: string; closingTime?: string; type?: string}>; parks?: Array<{schedule?: Array<{openingTime?: string; closingTime?: string; type?: string}>}>};
    const now = Date.now();
    const testSlot = (s: {openingTime?: string; closingTime?: string; type?: string}): boolean => {
      if (s.type && s.type !== 'OPERATING') return false;
      if (!s.openingTime || !s.closingTime) return false;
      const open = Date.parse(s.openingTime);
      const close = Date.parse(s.closingTime);
      if (isNaN(open) || isNaN(close)) return false;
      return now >= open && now <= close;
    };
    for (const s of data.schedule ?? []) {
      if (testSlot(s)) return true;
    }
    for (const p of data.parks ?? []) {
      for (const s of p.schedule ?? []) {
        if (testSlot(s)) return true;
      }
    }
    return false;
  } catch {
    return null;
  }
}

async function isCurrentlyOpenLocal(parksApiId: string): Promise<boolean | null> {
  try {
    const entry = await getDestinationById(parksApiId);
    if (!entry) return null;
    const inst: any = new entry.DestinationClass();
    const schedules = await inst.getSchedules();
    const now = Date.now();
    for (const park of schedules) {
      for (const day of (park.schedule ?? [])) {
        if (day.type && day.type !== 'OPERATING') continue;
        const open = Date.parse(day.openingTime);
        const close = Date.parse(day.closingTime);
        if (isNaN(open) || isNaN(close)) continue;
        if (now >= open && now <= close) return true;
      }
    }
    return false;
  } catch {
    return null;
  }
}

// ── Main ───────────────────────────────────────────────────────────

interface Args {
  mode: 'remote' | 'local' | 'diff';
  only: string[] | null;
  json: boolean;
  checkOpen: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const mode = args.includes('--local') ? 'local' : args.includes('--diff') ? 'diff' : 'remote';
  const onlyArg = args.find(a => a.startsWith('--only='))?.split('=')[1];
  const only = onlyArg ? onlyArg.split(',').map(s => s.trim()).filter(Boolean) : null;
  return {
    mode,
    only,
    json: args.includes('--json'),
    checkOpen: !args.includes('--no-open-check'),
  };
}

async function resolveRemoteTargets(
  wikiDests: WikiDest[],
  only: string[] | null,
): Promise<Array<{parksApiId: string; wiki: WikiDest}>> {
  const wikiByExt = new Map(wikiDests.map(d => [d.externalId, d]));
  const registry = await getAllDestinations();

  // Build a parksapi→wiki mapping:
  //   - for 1:1 classes, registry.id usually equals wiki.externalId
  //   - for multi-dest classes (SixFlags, Chimelong), we must query getDestinations()
  const out: Array<{parksApiId: string; wiki: WikiDest}> = [];
  const claimedExt = new Set<string>();

  for (const entry of registry) {
    if (only && !only.includes(entry.id)) continue;

    // Fast path: 1:1 by id
    const directMatch = wikiByExt.get(entry.id);
    if (directMatch) {
      out.push({parksApiId: entry.id, wiki: directMatch});
      claimedExt.add(directMatch.externalId);
      continue;
    }

    // Slow path: class emits multiple destinations (SixFlags, Chimelong) or has a
    // different externalId scheme. Instantiate and enumerate.
    try {
      const inst: any = new entry.DestinationClass();
      const emitted = await inst.getDestinations();
      for (const d of emitted) {
        const w = wikiByExt.get(d.id);
        if (w && !claimedExt.has(w.externalId)) {
          out.push({parksApiId: entry.id, wiki: w});
          claimedExt.add(w.externalId);
        }
      }
    } catch {
      // Class failed to instantiate; its data (if any) will show up as an
      // orphan wiki destination below.
    }
  }

  // Remaining wiki destinations with no parksapi match (orphans / retired)
  if (!only) {
    for (const w of wikiDests) {
      if (!claimedExt.has(w.externalId)) {
        out.push({parksApiId: '<unknown>', wiki: w});
      }
    }
  }

  return out;
}

async function main() {
  const args = parseArgs();
  const wikiDests = await fetchWikiDestinations();
  const wikiByExt = new Map(wikiDests.map(d => [d.externalId, d]));

  const allReports: DestReport[] = [];

  // ── Remote-side audit ─────────────────────────────────────
  if (args.mode === 'remote' || args.mode === 'diff') {
    const pairs = await resolveRemoteTargets(wikiDests, args.only);
    for (const {parksApiId, wiki} of pairs) {
      try {
        const remoteLive = await fetchRemoteLive(wiki.id);
        const open = args.checkOpen ? await isCurrentlyOpenRemote(wiki.id) : null;
        allReports.push(buildReport(parksApiId, wiki.externalId, wiki.name, 'remote', remoteLive, open));
      } catch (e: any) {
        console.error(`[${parksApiId}/${wiki.externalId}] wiki fetch failed: ${e.message}`);
      }
    }
  }

  // ── Local-side audit ─────────────────────────────────────
  if (args.mode === 'local' || args.mode === 'diff') {
    const registry = await getAllDestinations();
    const targets = args.only ? registry.filter(r => args.only!.includes(r.id)) : registry;

    for (const entry of targets) {
      let emittedDests: Array<{id: string; name: string}> = [];
      try {
        const inst: any = new entry.DestinationClass();
        emittedDests = await inst.getDestinations();
      } catch (e: any) {
        console.error(`[${entry.id}] getDestinations failed: ${e.message}`);
        continue;
      }

      let localLive: LiveItem[] | null = null;
      try {
        localLive = await emitLocalLive(entry.id);
      } catch (e: any) {
        console.error(`[${entry.id}] local getLiveData failed: ${e.message}`);
        continue;
      }

      const localOpen = args.checkOpen ? await isCurrentlyOpenLocal(entry.id) : null;

      const destsToReport = emittedDests.length > 0 ? emittedDests : [{id: entry.id, name: entry.name}];
      for (const d of destsToReport) {
        const wiki = wikiByExt.get(d.id);
        const name = wiki?.name ?? (typeof d.name === 'string' ? d.name : entry.id);
        if (emittedDests.length > 1) {
          allReports.push(buildReport(entry.id, d.id, `${name} (local shared)`, 'local', localLive, localOpen));
          break;  // one report per multi-dest class — shared live array
        } else {
          allReports.push(buildReport(entry.id, d.id, name, 'local', localLive, localOpen));
        }
      }
    }
  }

  // ── Output ───────────────────────────────────────────────
  if (args.json) {
    console.log(JSON.stringify(allReports, null, 2));
    return;
  }

  printHumanReport(allReports, args.mode);
}

function printHumanReport(reports: DestReport[], mode: string): void {
  const errorCount = reports.reduce((s, r) => s + r.issues.filter(i => i.level === 'error').length, 0);
  const warnCount = reports.reduce((s, r) => s + r.issues.filter(i => i.level === 'warn').length, 0);
  const clean = reports.filter(r => r.issues.length === 0).length;
  const empty = reports.filter(r => r.totalItems === 0).length;
  const openCount = reports.filter(r => r.currentlyOpen === true).length;
  const totalItems = reports.reduce((s, r) => s + r.totalItems, 0);

  console.log(`\n╭── Live data audit (${mode}) ───────────────────────────────`);
  console.log(`│  ${reports.length} destination-source pairs, ${totalItems} live items total`);
  console.log(`│  ${clean} clean, ${empty} empty, ${openCount} currently within operating hours`);
  console.log(`│  ${errorCount} schema/type error(s), ${warnCount} warning(s)`);
  console.log(`╰──────────────────────────────────────────────────────────\n`);

  // Compact per-destination line
  console.log(`${'Destination'.padEnd(40)} ${'src'.padEnd(6)} items  status-counts                      queue/show stats        freshest  open?`);
  console.log('─'.repeat(140));
  for (const r of reports.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source))) {
    const errs = r.issues.filter(i => i.level === 'error').length;
    const warns = r.issues.filter(i => i.level === 'warn').length;
    const flag = errs > 0 ? '✗' : warns > 0 ? '⚠' : r.totalItems === 0 ? '∅' : '✓';
    const statuses = Object.entries(r.stats.byStatus).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, c]) => `${s}=${c}`).join(' ');
    const stats: string[] = [];
    if (r.stats.withStandby) stats.push(`s=${r.stats.withStandby}`);
    if (r.stats.withSingleRider) stats.push(`sr=${r.stats.withSingleRider}`);
    if (r.stats.withReturnTime) stats.push(`rt=${r.stats.withReturnTime}`);
    if (r.stats.withPaidReturn) stats.push(`prt=${r.stats.withPaidReturn}`);
    if (r.stats.withBoarding) stats.push(`bg=${r.stats.withBoarding}`);
    if (r.stats.withShowtimes) stats.push(`sh=${r.stats.withShowtimes}`);
    if (r.stats.withOperatingHours) stats.push(`oh=${r.stats.withOperatingHours}`);
    const fresh = r.freshest ? `${((Date.now() - new Date(r.freshest).getTime()) / 60_000 | 0)}m` : '—';
    const open = r.currentlyOpen === true ? 'Y' : r.currentlyOpen === false ? 'N' : '?';
    console.log(
      `${flag} ${r.name.padEnd(38)} ${r.source.padEnd(6)} ${String(r.totalItems).padStart(4)}  ${statuses.padEnd(35)} ${stats.join(' ').padEnd(22)} ${fresh.padStart(7)}  ${open}`
      + (errs > 0 || warns > 0 ? `   (${errs}e ${warns}w)` : ''),
    );
  }

  // Issue detail — errors first, then warns grouped by destination
  const withErr = reports.filter(r => r.issues.some(i => i.level === 'error'));
  const withWarn = reports.filter(r => r.issues.some(i => i.level === 'warn') && !r.issues.some(i => i.level === 'error'));

  if (withErr.length) {
    console.log(`\n═══ ERRORS ═══`);
    for (const r of withErr) {
      const errs = r.issues.filter(i => i.level === 'error');
      console.log(`\n${r.name} [${r.source}]`);
      for (const e of errs.slice(0, 15)) console.log(`  ✗ ${e.path}: ${e.message}`);
      if (errs.length > 15) console.log(`  ...+${errs.length - 15} more`);
    }
  }
  if (withWarn.length) {
    console.log(`\n═══ WARNINGS ═══`);
    for (const r of withWarn) {
      const warns = r.issues.filter(i => i.level === 'warn');
      console.log(`\n${r.name} [${r.source}]`);
      for (const w of warns.slice(0, 10)) console.log(`  ⚠ ${w.path}: ${w.message}`);
      if (warns.length > 10) console.log(`  ...+${warns.length - 10} more`);
    }
  }

  if (errorCount > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exitCode = 1;
}).finally(() => stopHttpQueue());
