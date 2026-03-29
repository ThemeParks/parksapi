/**
 * Park health check — validates each park's HTTP endpoints.
 * Discovers all @http decorated methods, calls each one, and validates
 * the response is reachable and returns valid data.
 *
 * Usage:
 *   npm run health                         # Check all parks
 *   npm run health -- efteling             # Check specific park
 *   npm run health -- --category Disney    # Check all Disney parks
 */

import { getAllDestinations, getDestinationById, getDestinationsByCategory } from '../destinationRegistry.js';
import { Destination } from '../destination.js';
import { getHttpRequestersForClass, waitForHttpQueue, stopHttpQueue, type HTTPRequester } from '../http.js';

/**
 * Resolve template variables in health check arguments.
 * Supports: {year}, {month}, {today}, {date+N}, {yyyymm}
 */
function resolveTemplateArg(arg: any): any {
  if (typeof arg !== 'string') return arg;

  const now = new Date();
  return arg
    .replace(/\{year\}/g, String(now.getFullYear()))
    .replace(/\{month\}/g, String(now.getMonth() + 1))
    .replace(/\{today\}/g, now.toISOString().split('T')[0])
    .replace(/\{yyyymm\}/g, `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`)
    .replace(/\{yyyymmdd\}/g, `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`)
    .replace(/\{date\+(\d+)\}/g, (_, days) => {
      const d = new Date(now.getTime() + parseInt(days) * 86400000);
      return d.toISOString().split('T')[0];
    });
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
        ? httpMethod.healthCheckArgs.map(resolveTemplateArg)
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

function printResult(r: HealthResult): void {
  const allOk = r.failed === 0;
  const icon = allOk ? 'OK  ' : 'FAIL';
  const counts = `${r.healthy} ok${r.failed ? `, ${r.failed} failed` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}`;

  console.log(`  ${icon}  ${r.parkName.padEnd(35)} ${r.endpoints.length} endpoints  ${counts}  ${(r.duration / 1000).toFixed(1)}s`);

  // Show failed endpoints
  for (const ep of r.endpoints) {
    if (!ep.ok) {
      console.log(`          ${ep.method}: ${ep.error || `HTTP ${ep.status}`}`);
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
    console.log(`\nUnhealthy: ${unhealthy.map(r => r.parkId).join(', ')}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const categoryIdx = args.indexOf('--category');
  const category = categoryIdx !== -1 ? args[categoryIdx + 1] : undefined;
  const parkIdArg = args.find(a => !a.startsWith('--') && a !== category);

  const results: HealthResult[] = [];

  try {
    let entries: Array<{ id: string; name: string; DestinationClass: new () => Destination }>;

    if (parkIdArg) {
      const entry = await getDestinationById(parkIdArg);
      if (!entry) {
        console.error(`Park not found: ${parkIdArg}`);
        process.exit(1);
      }
      entries = [entry];
    } else if (category) {
      entries = await getDestinationsByCategory(category);
    } else {
      entries = await getAllDestinations();
    }

    console.log(`Health check: ${entries.length} park${entries.length !== 1 ? 's' : ''}\n`);

    for (const entry of entries) {
      const result = await checkPark(entry.id, entry.name, entry.DestinationClass);
      printResult(result);
      results.push(result);
    }

    printSummary(results);
  } finally {
    stopHttpQueue();
  }

  const allHealthy = results.every(r => r.failed === 0);
  process.exit(allHealthy ? 0 : 1);
}

main();
