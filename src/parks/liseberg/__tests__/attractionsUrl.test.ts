import {describe, test, expect, beforeAll, afterAll, afterEach} from 'vitest';
import {createServer, IncomingMessage, ServerResponse} from 'http';
import {AddressInfo} from 'net';
import {Liseberg} from '../liseberg.js';
import {CacheLib} from '../../../cache.js';

/**
 * Liseberg moved its attractions feed from `/en/api/app/attractions/` to
 * `/en/api/app/attractions` (no trailing slash). The old path now answers
 * `308 Permanent Redirect` with a relative Location, which the HTTP layer
 * treats as a failure, so every entity sync and live update failed.
 *
 * The stub below reproduces the upstream exactly: the slashed path 308s, the
 * bare path serves the feed. The fixture is trimmed from a real capture.
 */
const KRAFTVERKET = {
  id: 79077,
  title: 'Kraftverket',
  type: 'attraction',
  coordinates: {latitude: 57.692342, longitude: 11.994168},
  state: {minWaitTime: 5, maxWaitTime: 15, status: 'Open', isOpen: true},
};
const NOT_A_RIDE = {id: 1, title: 'Restaurant', type: 'restaurant'};

describe('Liseberg attractions feed URL', () => {
  let server: ReturnType<typeof createServer>;
  let baseURL: string;
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      hits.push(req.url || '');
      if (req.url === '/en/api/app/attractions/') {
        res.writeHead(308, {location: '/en/api/app/attractions'});
        res.end();
        return;
      }
      if (req.url === '/en/api/app/attractions') {
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify([KRAFTVERKET, NOT_A_RIDE]));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/en/api/`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    CacheLib.clear();
  });

  afterEach(() => {
    CacheLib.clear();
    hits.length = 0;
  });

  function park(): Liseberg {
    const p = new Liseberg();
    p.baseURL = baseURL;
    return p;
  }

  test('requests the attractions feed without a trailing slash', async () => {
    await park().getAttractions();
    expect(hits).toEqual(['/en/api/app/attractions']);
  });

  test('builds entities from the moved feed', async () => {
    const ids = (await park().getEntities()).map(e => e.id);
    expect(ids).toContain('lisebergpark');
    expect(ids).toContain('79077');
    expect(ids).not.toContain('1');
  });

  test('builds live data from the moved feed', async () => {
    const live = await park().getLiveData();
    const kraft = live.find(l => l.id === '79077');
    expect(kraft?.status).toBe('OPERATING');
    expect(kraft?.queue?.STANDBY?.waitTime).toBe(15);
  });
});
