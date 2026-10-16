/**
 * @module
 * Live check that Phantasialand's signage endpoint accepts the positions the
 * park sends. It draws from SIGNAGE_BOX through the park's own `fetchSignage()`
 * and exits 1 if any position is refused, so a refusal that unit tests cannot
 * see shows up before it costs a poll.
 *
 *   npm run probe:phantasialand                       # 60 draws, 2s apart
 *   npm run probe:phantasialand -- --draws 200 --gap 3000
 *
 * Needs the park's API base in the environment, as `npm run dev` does.
 */
import {Phantasialand, SIGNAGE_BOX} from '../parks/phantasialand/phantasialand.js';
import {setHttpTransport} from '../httpProxy.js';
import {stopHttpQueue} from '../http.js';
import {summarise, type ProbeResult} from './signageProbeReport.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv: string[]): {draws: number; gap: number} {
  const o = {draws: 60, gap: 2000};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a !== '--draws' && a !== '--gap') throw new Error(`unknown argument ${a}`);
    const n = Number(argv[++i]);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${a} needs a positive number`);
    if (a === '--draws') o.draws = n;
    else o.gap = n;
  }
  return o;
}

async function probeDraws(park: Phantasialand, n: number, gap: number): Promise<ProbeResult[]> {
  // First answer per position: a refused draw is retried at the same loc, and
  // those retries are one draw, not six.
  const first = new Map<string, ProbeResult>();
  const record = (loc: string | null, status: number) => {
    if (!loc || first.has(loc)) return;
    const [lat, lng] = loc.split(',').map(Number);
    first.set(loc, {lat, lng, status});
  };

  setHttpTransport(async (request, _caller, send) => {
    const loc = new URL(request.url).searchParams.get('loc');
    try {
      const resp = await send(request);
      record(loc, resp.status);
      return resp;
    } catch (err) {
      record(loc, -1);
      throw err;
    }
  });

  for (let i = 1; i <= n; i++) {
    try {
      await park.fetchSignage();
    } catch {
      // The transport recorded the status already.
    }
    if (i % 10 === 0) console.log(`  ${i}/${n}`);
    if (i < n) await sleep(gap);
  }
  setHttpTransport(null);
  return [...first.values()];
}

async function main(): Promise<number> {
  const {draws, gap} = parseArgs(process.argv.slice(2));
  console.log(`${draws} draws from ${JSON.stringify(SIGNAGE_BOX)}, ${gap}ms apart`);

  const s = summarise(await probeDraws(new Phantasialand(), draws, gap));
  console.log(`\n${s.accepted} accepted, ${s.refused} refused, ${s.other} other of ${s.total} positions`);
  if (!s.ok) {
    console.log('FAIL: the park sent a position the endpoint did not accept.');
    return 1;
  }
  console.log('PASS');
  return 0;
}

main()
  .then((code) => { stopHttpQueue(); process.exit(code); })
  .catch((err) => { console.error(err); stopHttpQueue(); process.exit(2); });
