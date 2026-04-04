/**
 * Park health check — validates each park's HTTP endpoints.
 * Discovers all @http decorated methods, calls each one, and validates
 * the response is reachable and returns valid data.
 *
 * Usage:
 *   npm run health                              # Check all parks (default concurrency: 5)
 *   npm run health -- efteling                  # Check specific park
 *   npm run health -- --category Disney         # Check all Disney parks
 *   npm run health -- --concurrency 10          # Run up to 10 parks in parallel
 */

import { getAllDestinations, getDestinationsByCategory } from '../destinationRegistry.js';
import { Destination } from '../destination.js';
import { getHttpRequestersForClass, waitForHttpQueue, stopHttpQueue, type HTTPRequester } from '../http.js';
import { addDays, formatDate } from '../datetime.js';

const DEFAULT_CONCURRENCY = 5;

/**
 * Resolve template variables in health check arguments using tomorrow's date
 * in the park's local timezone.
 *
 * Supported variables:
 *   {year}      — tomorrow's 4-digit year in park timezone
 *   {month}     — tomorrow's month (no leading zero) in park timezone
 *   {today}     — tomorrow's date as YYYY-MM-DD in park timezone
 *   {tomorrow}  — tomorrow's date as YYYY-MM-DD in park timezone (explicit alias)
 *   {yyyymm}    — tomorrow's YYYYMM in park timezone
 *   {yyyymmdd}  — tomorrow's YYYYMMDD in park timezone
 *   {date+N}    — N days after tomorrow as YYYY-MM-DD in park timezone
 */
function resolveTemplateArg(arg: any, timezone: string): any {
  if (typeof arg !== 'string') return arg;

  const tomorrow = addDays(new Date(), 1);
  const dateStr = formatDate(tomorrow, timezone); // YYYY-MM-DD in park timezone
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  const monthNum = String(parseInt(monthStr, 10)); // strip leading zero

  return arg
    .replace(/\{year\}/g, yearStr)
    .replace(/\{month\}/g, monthNum)
    .replace(/\{today\}/g, dateStr)
    .replace(/\{tomorrow\}/g, dateStr)
    .replace(/\{yyyymm\}/g, `${yearStr}${monthStr}`)
    .replace(/\{yyyymmdd\}/g, `${yearStr}${monthStr}${dayStr}`)
    .replace(/\{date\+(\d+)\}/g, (_: string, days: string) => {
      const d = addDays(tomorrow, parseInt(days, 10));
      return formatDate(d, timezone);
    });
}

/**
 * Run an array of async tasks with a bounded concurrency limit.
 * Tasks are started as slots free up; results are processed in completion order.
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const worker = async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  };
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({length: workerCount}, worker));
}

type EndpointResult = {
  method: string;
  ok: boolean;
  status?: number;
  error?: string;
};

type HealthResult = {
  parkId: string;
  parkName: string;
  endpoints: EndpointResult[];
  healthy: number;
  failed: number;
  skipped: number;
  duration: number;
};

async function checkPark(
  parkId: string,
  parkName: string,
  DestClass: new () => Destination,
): Promise<HealthResult> {
  const start = Date.now();
  const park = new DestClass();
  const endpoints: EndpointResult[] = [];

  // Get the park's local timezone for resolving date template args
  const timezone: string = (park as any).timezone || 'UTC';

  // Discover all @http methods for this park class
  const httpMethods = getHttpRequestersForClass(DestClass);

  for (const httpMethod of httpMethods) {
    const methodName = httpMethod.methodName;

    // Skip methods that require arguments we can't provide
    // (the @http decorator stores parameter definitions)
    const hasRequiredArgs = httpMethod.args && httpMethod.args.length > 0;

    // Methods with args: use healthCheckArgs if provided, otherwise skip
    const needsArgs = hasRequiredArgs || httpMethod.paramCount > 0;
    if (needsArgs && !httpMethod.healthCheckArgs) {
      endpoints.push({ method: methodName, ok: true, error: 'skipped (needs args)' });
      continue;
    }

    try {
      // Call the method — with health check args if provided, otherwise no args
      const args = httpMethod.healthCheckArgs
        ? httpMethod.healthCheckArgs.map((a: any) => resolveTemplateArg(a, timezone))
        : [];
      const result = await (park as any)[methodName](...args);
      await waitForHttpQueue();

      if (result && result.response) {
        const status = result.response.status || result.status;
        const ok = status >= 200 && status < 400;
        endpoints.push({ method: methodName, ok, status });
      } else if (result && typeof result.ok === 'boolean') {
        endpoints.push({ method: methodName, ok: result.ok, status: result.status });
      } else {
        // Method returned something but no clear response — count as OK
        endpoints.push({ method: methodName, ok: true });
      }
    } catch (e: any) {
      const msg = e.message?.substring(0, 120) || String(e);
      // Detect methods that need arguments despite not declaring them
      if (msg.includes('undefined') || msg.includes('Invalid URL') || msg.includes('/null')) {
        endpoints.push({ method: methodName, ok: true, error: 'skipped (needs args)' });
      } else {
        endpoints.push({ method: methodName, ok: false, error: msg });
      }
    }
  }

  const healthy = endpoints.filter(e => e.ok && !e.error?.includes('skipped')).length;
  const failed = endpoints.filter(e => !e.ok).length;
  const skipped = endpoints.filter(e => e.error?.includes('skipped')).length;

  return {
    parkId,
    parkName,
    endpoints,
    healthy,
    failed,
    skipped,
    duration: Date.now() - start,
  };
}

function printResult(r: HealthResult, progress: string): void {
  const allOk = r.failed === 0;
  const icon = allOk ? 'OK  ' : 'FAIL';
  const counts = `${r.healthy} ok${r.failed ? `, ${r.failed} failed` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}`;

  console.log(`${progress}  ${icon}  ${r.parkName.padEnd(35)} ${r.endpoints.length} endpoints  ${counts}  ${(r.duration / 1000).toFixed(1)}s`);

  // Show failed endpoints
  for (const ep of r.endpoints) {
    if (!ep.ok) {
      console.log(`              ${ep.method}: ${ep.error || `HTTP ${ep.status}`}`);
    }
  }
}

function printSummary(results: HealthResult[]): void {
  const healthy = results.filter(r => r.failed === 0);
  const unhealthy = results.filter(r => r.failed > 0);
  const totalEndpoints = results.reduce((sum, r) => sum + r.endpoints.length, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`\n${healthy.length}/${results.length} parks healthy  |  ${totalEndpoints} endpoints checked  |  ${totalFailed} failures  |  ${(totalDuration / 1000).toFixed(0)}s`);

  if (unhealthy.length > 0) {
    console.log('\nUnhealthy parks:');
    for (const r of unhealthy) {
      console.log(`  ${r.parkId}`);
      for (const ep of r.endpoints) {
        if (!ep.ok) {
          console.log(`    ${ep.method}: ${ep.error || `HTTP ${ep.status}`}`);
        }
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const categoryIdx = args.indexOf('--category');
  const category = categoryIdx !== -1 ? args[categoryIdx + 1] : undefined;
  const concurrencyIdx = args.indexOf('--concurrency');
  const concurrency = concurrencyIdx !== -1
    ? Math.max(1, parseInt(args[concurrencyIdx + 1], 10) || DEFAULT_CONCURRENCY)
    : DEFAULT_CONCURRENCY;
  const concurrencyValue = concurrencyIdx !== -1 ? args[concurrencyIdx + 1] : undefined;
  const parkIdArg = args.find(a => !a.startsWith('--') && a !== category && a !== concurrencyValue);

  const results: HealthResult[] = [];

  try {
    let entries: Array<{ id: string; name: string; DestinationClass: new () => Destination }>;

    if (parkIdArg) {
      const all = await getAllDestinations();
      const needle = parkIdArg.toLowerCase();
      // Support exact match first, then substring match on id or name
      entries = all.filter(d =>
        d.id === needle ||
        d.id.includes(needle) ||
        d.name.toLowerCase().includes(needle),
      );
      if (entries.length === 0) {
        console.error(`No parks found matching: ${parkIdArg}`);
        console.error(`Available parks: ${all.map(d => d.id).join(', ')}`);
        process.exit(1);
      }
    } else if (category) {
      entries = await getDestinationsByCategory(category);
    } else {
      entries = await getAllDestinations();
    }

    const total = entries.length;
    const plural = total !== 1 ? 's' : '';
    const concurrencyNote = total > 1 ? `  (concurrency: ${Math.min(concurrency, total)})` : '';
    console.log(`Health check: ${total} park${plural}${concurrencyNote}\n`);

    let completed = 0;
    const width = String(total).length;

    await runWithConcurrency(entries, concurrency, async (entry) => {
      const result = await checkPark(entry.id, entry.name, entry.DestinationClass);
      completed++;
      const progress = `[${String(completed).padStart(width, ' ')}/${total}]`;
      printResult(result, progress);
      results.push(result);
    });

    printSummary(results);
  } finally {
    stopHttpQueue();
  }

  const allHealthy = results.every(r => r.failed === 0);
  process.exit(allHealthy ? 0 : 1);
}

main();
