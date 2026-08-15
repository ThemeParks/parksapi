// Vitest setup file
// This file runs before the test suite

import dns from 'node:dns';

// Set up test-specific environment variables
process.env.CACHE_DB_PATH = ':memory:';

// ---------------------------------------------------------------------------
// The gate suite does not touch the network.
//
// It used to: two tracing tests drove live requests at httpbin.org and
// jsonplaceholder.typicode.com, so every run depended on two free public
// services being up and quick from whatever IP the runner had. That produced
// exactly the failure you would expect — a 35s timeout in CI on a commit that
// touched neither file.
//
// Rewriting those two to run against a loopback server fixed the instances.
// This makes the class unreachable: any hostname that is not loopback fails at
// resolution, with a message naming the offender, rather than opening a socket
// to the internet. A test that needs an endpoint gets a local server
// (src/__tests__/helpers/localHttpServer.ts); a test that only needs a URL to
// assert on never resolves it and is unaffected.
// ---------------------------------------------------------------------------
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function blockedLookup(hostname: string): Error | null {
  if (LOOPBACK.has(hostname)) return null;
  return new Error(
    `Blocked DNS lookup for "${hostname}" — the test suite must not touch the network. ` +
    `Use src/__tests__/helpers/localHttpServer.ts for a real endpoint on loopback.`,
  );
}

const realLookup = dns.lookup;
// @ts-expect-error — overload-heavy signature; the wrapper forwards verbatim
dns.lookup = function patchedLookup(hostname: string, ...args: any[]) {
  const blocked = blockedLookup(hostname);
  if (!blocked) return (realLookup as any)(hostname, ...args);
  const callback = args[args.length - 1];
  if (typeof callback === 'function') return callback(blocked);
  throw blocked;
};

const realPromisesLookup = dns.promises.lookup;
// @ts-expect-error — as above
dns.promises.lookup = function patchedPromisesLookup(hostname: string, ...args: any[]) {
  const blocked = blockedLookup(hostname);
  if (blocked) return Promise.reject(blocked);
  return (realPromisesLookup as any)(hostname, ...args);
};
