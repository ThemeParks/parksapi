/**
 * A throwaway HTTP server on loopback, for tests that need the real
 * `node:http` path rather than a mock of it.
 *
 * The tracing tests exercise `src/http.ts`, which is built on `node:http` /
 * `node:https` rather than `fetch` precisely so proxying behaves. Mocking that
 * module would leave the code under test unexercised, so these tests get a
 * server instead: same sockets, same queue, same tracing events, no third
 * party and no DNS.
 *
 * The port is assigned by the OS (`listen(0)`), which also keeps every run on
 * its own URLs — the `@http` cache key is derived from the URL, so nothing can
 * survive from a previous run's SQLite cache into this one.
 */
import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';

export type LocalServer = {
  /** e.g. `http://127.0.0.1:38273` — no trailing slash. */
  baseURL: string;
  /** Every path this server was asked for, in order. */
  requests: string[];
  close: () => Promise<void>;
};

/** Fixtures the tracing tests read back. Small and stable on purpose. */
const USERS = [
  {id: 1, name: 'Ada Lovelace'},
  {id: 2, name: 'Alan Turing'},
  {id: 3, name: 'Grace Hopper'},
  {id: 4, name: 'Edsger Dijkstra'},
];

const POSTS = [
  {id: 1, userId: 1, title: 'first'},
  {id: 2, userId: 2, title: 'second'},
];

/**
 * Routes cover what the two tracing suites used to reach for on httpbin.org
 * and jsonplaceholder.typicode.com. `/delay/:ms` is capped well below the
 * old one-second sleep: the test needs a request that finishes later than
 * its sibling, not a real second of wall clock.
 */
function handle(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url || '/').split('?')[0];

  const status = /^\/status\/(\d{3})$/.exec(path);
  if (status) {
    res.writeHead(Number(status[1]), {'Content-Type': 'application/json'});
    res.end('{}');
    return;
  }

  const delay = /^\/delay\/(\d+)$/.exec(path);
  if (delay) {
    const ms = Math.min(Number(delay[1]), 50);
    setTimeout(() => {
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({delayed: true}));
    }, ms);
    return;
  }

  const body =
    path === '/users' ? USERS :
    path === '/posts' ? POSTS :
    {path};

  res.writeHead(200, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(body));
}

export async function startLocalServer(): Promise<LocalServer> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push((req.url || '').split('?')[0]);
    handle(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const {port} = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
