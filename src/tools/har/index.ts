/**
 * HAR Analysis Tool
 *
 * Usage:
 *   npm run har -- <file.har>                    Overview of all API traffic
 *   npm run har -- <file.har> --host <hostname>   Detail for a specific host
 *   npm run har -- <file.har> --dump <path>       Dump full response for a URL path
 */

import {readFileSync} from 'fs';

// ── Noise filter ───────────────────────────────────────────────

const NOISE_HOSTNAMES = [
  'google', 'facebook', 'firebase', 'doubleclick', 'analytics',
  'sentry', 'datadog', 'apple.com', 'icloud', 'fonts.', 'gstatic',
  'detectportal', 'connectivitycheck', 'crashlytics', 'app-measurement',
  'adjust.', 'branch.io', 'appsflyer', 'amplitude', 'mparticle',
  'mixpanel', 'cdn.optimizely', 'quantummetric', 'swrve',
  'demdex.net', 'adobedtm', 'adobe.com', 'omtrdc.net',
  'bugly.qq.com', 'snowflake.qq.com', 'tpns.tencent.com',
  'weibo.com', 'gtm', 'tag.', 'segment.',
];

const NOISE_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
  '.css', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.webm', '.mp3',
];

interface HarEntry {
  request: {
    method: string;
    url: string;
    headers: Array<{name: string; value: string}>;
    postData?: {text?: string; mimeType?: string};
  };
  response: {
    status: number;
    content: {text?: string; size?: number; mimeType?: string};
  };
}

function isNoise(hostname: string, path: string): boolean {
  if (NOISE_HOSTNAMES.some(n => hostname.includes(n))) return true;
  if (NOISE_EXTENSIONS.some(ext => path.toLowerCase().endsWith(ext))) return true;
  return false;
}

// ── Helpers ────────────────────────────────────────────────────

function parseUrl(url: string): {hostname: string; path: string; search: string} | null {
  try {
    const u = new URL(url);
    return {hostname: u.hostname, path: u.pathname, search: u.search};
  } catch {
    return null;
  }
}

function getHeader(headers: Array<{name: string; value: string}>, name: string): string | undefined {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function truncate(str: string, len: number): string {
  return str.length > len ? str.substring(0, len) + '...' : str;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ── Analysis modes ─────────────────────────────────────────────

function overview(entries: HarEntry[]) {
  // Group by hostname
  const byHost: Record<string, HarEntry[]> = {};

  for (const e of entries) {
    if (e.response.status === 0) continue; // DNS/connection entries
    const u = parseUrl(e.request.url);
    if (!u) continue;
    if (isNoise(u.hostname, u.path)) continue;

    if (!byHost[u.hostname]) byHost[u.hostname] = [];
    byHost[u.hostname].push(e);
  }

  // Sort hosts by number of calls
  const hosts = Object.entries(byHost).sort((a, b) => b[1].length - a[1].length);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  HAR Analysis — ${entries.length} total entries, ${hosts.length} API hosts`);
  console.log(`${'═'.repeat(70)}\n`);

  for (const [hostname, hostEntries] of hosts) {
    // Deduplicate by method + path
    const unique = new Map<string, {method: string; path: string; search: string; status: number; size: number; contentType: string}>();
    for (const e of hostEntries) {
      const u = parseUrl(e.request.url)!;
      const key = `${e.request.method} ${u.path}`;
      if (!unique.has(key)) {
        unique.set(key, {
          method: e.request.method,
          path: u.path,
          search: u.search,
          status: e.response.status,
          size: e.response.content?.size || 0,
          contentType: e.response.content?.mimeType || '',
        });
      }
    }

    // Detect auth pattern
    const authPatterns = detectAuth(hostEntries);

    console.log(`┌─ ${hostname} (${unique.size} unique endpoint${unique.size !== 1 ? 's' : ''}, ${hostEntries.length} call${hostEntries.length !== 1 ? 's' : ''})${authPatterns.length > 0 ? ` [${authPatterns.join(', ')}]` : ''}`);

    for (const [, call] of unique) {
      const statusColor = call.status >= 200 && call.status < 300 ? '\x1b[32m' :
        call.status >= 400 ? '\x1b[31m' : '\x1b[33m';
      const reset = '\x1b[0m';
      const pathDisplay = truncate(call.path + (call.search ? call.search : ''), 80);
      console.log(`│  ${call.method.padEnd(6)} ${pathDisplay.padEnd(82)} ${statusColor}${call.status}${reset}  ${formatSize(call.size)}`);
    }
    console.log('│');
  }

  console.log(`\nUse --host <hostname> for details, --dump <path> for full response body.\n`);
}

function detectAuth(entries: HarEntry[]): string[] {
  const patterns: Set<string> = new Set();

  for (const e of entries) {
    const auth = getHeader(e.request.headers, 'authorization');
    if (auth) {
      if (auth.startsWith('Bearer ')) patterns.add('Bearer');
      else if (auth.startsWith('Basic ')) patterns.add('Basic');
      else patterns.add('Auth: ' + truncate(auth, 20));
    }

    const apiKey = getHeader(e.request.headers, 'x-api-key');
    if (apiKey) patterns.add('x-api-key');

    const token = getHeader(e.request.headers, 'token');
    if (token) patterns.add('token header');

    const xToken = getHeader(e.request.headers, 'x-token');
    if (xToken) patterns.add('x-token');
  }

  return [...patterns];
}

function hostDetail(entries: HarEntry[], hostname: string) {
  const hostEntries = entries.filter(e => {
    const u = parseUrl(e.request.url);
    return u && u.hostname === hostname && e.response.status > 0;
  });

  if (hostEntries.length === 0) {
    console.log(`No entries found for hostname: ${hostname}`);
    return;
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${hostname} — ${hostEntries.length} request${hostEntries.length !== 1 ? 's' : ''}`);
  console.log(`${'═'.repeat(70)}\n`);

  // Group by method + path
  const grouped = new Map<string, HarEntry[]>();
  for (const e of hostEntries) {
    const u = parseUrl(e.request.url)!;
    const key = `${e.request.method} ${u.path}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(e);
  }

  for (const [key, group] of grouped) {
    const e = group[0]; // representative entry
    const u = parseUrl(e.request.url)!;

    console.log(`┌─ ${key} (${group.length}x) → ${e.response.status}`);

    // Query params
    if (u.search) {
      const params = new URLSearchParams(u.search);
      const paramList = [...params.entries()].map(([k, v]) => `${k}=${truncate(v, 40)}`);
      console.log(`│  Params: ${paramList.join(', ')}`);
    }

    // Key request headers
    const interestingHeaders = ['authorization', 'content-type', 'x-api-key', 'token',
      'x-token', 'user-agent', 'accept', 'language', 'x-date', 'x-s2'];
    const headers = e.request.headers.filter(h =>
      interestingHeaders.includes(h.name.toLowerCase())
    );
    if (headers.length > 0) {
      console.log(`│  Headers:`);
      for (const h of headers) {
        console.log(`│    ${h.name}: ${truncate(h.value, 70)}`);
      }
    }

    // Request body
    if (e.request.postData?.text) {
      console.log(`│  Body: ${truncate(e.request.postData.text, 200)}`);
    }

    // Response preview
    const body = e.response.content?.text;
    if (body) {
      try {
        const json = JSON.parse(body);
        if (Array.isArray(json)) {
          console.log(`│  Response: Array[${json.length}]`);
          if (json[0]) {
            console.log(`│    Keys: ${Object.keys(json[0]).join(', ')}`);
            console.log(`│    Sample: ${truncate(JSON.stringify(json[0]), 200)}`);
          }
        } else {
          console.log(`│  Response: Object`);
          console.log(`│    Keys: ${Object.keys(json).join(', ')}`);
          // Show nested structure for key fields
          for (const [k, v] of Object.entries(json)) {
            if (Array.isArray(v)) {
              console.log(`│    ${k}: Array[${(v as any[]).length}]${(v as any[])[0] ? ' → keys: ' + Object.keys((v as any[])[0]).join(', ') : ''}`);
            } else if (v && typeof v === 'object') {
              console.log(`│    ${k}: ${truncate(JSON.stringify(v), 100)}`);
            } else {
              console.log(`│    ${k}: ${truncate(String(v), 80)}`);
            }
          }
        }
      } catch {
        console.log(`│  Response: ${truncate(body, 200)}`);
      }
    }

    console.log('│');
  }
}

function dumpResponse(entries: HarEntry[], pathMatch: string) {
  const matching = entries.filter(e => {
    const u = parseUrl(e.request.url);
    return u && e.request.url.includes(pathMatch) && e.response.status > 0;
  });

  if (matching.length === 0) {
    console.log(`No entries matching: ${pathMatch}`);
    return;
  }

  for (const e of matching) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  ${e.request.method} ${e.request.url}`);
    console.log(`  Status: ${e.response.status}  Size: ${formatSize(e.response.content?.size || 0)}`);
    console.log(`${'═'.repeat(70)}\n`);

    const body = e.response.content?.text;
    if (body) {
      try {
        console.log(JSON.stringify(JSON.parse(body), null, 2));
      } catch {
        console.log(body);
      }
    } else {
      console.log('(no response body)');
    }
  }
}

// ── Main ───────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage:');
    console.log('  npm run har -- <file.har>                    Overview of all API traffic');
    console.log('  npm run har -- <file.har> --host <hostname>  Detail for a specific host');
    console.log('  npm run har -- <file.har> --dump <path>      Dump full response for a URL path');
    process.exit(1);
  }

  const harFile = args[0];
  let har: any;
  try {
    har = JSON.parse(readFileSync(harFile, 'utf-8'));
  } catch (err: any) {
    console.error(`Failed to read ${harFile}: ${err.message}`);
    process.exit(1);
  }

  const entries: HarEntry[] = har.log?.entries || [];
  console.log(`Loaded ${entries.length} entries from ${harFile}`);

  const hostIdx = args.indexOf('--host');
  const dumpIdx = args.indexOf('--dump');

  if (hostIdx >= 0 && args[hostIdx + 1]) {
    hostDetail(entries, args[hostIdx + 1]);
  } else if (dumpIdx >= 0 && args[dumpIdx + 1]) {
    dumpResponse(entries, args[dumpIdx + 1]);
  } else {
    overview(entries);
  }
}

main();
