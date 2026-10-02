/**
 * The two asset-pack requests are made outside the @http queue, because the
 * /data endpoint answers 303 with the ZIP's Location and the ZIP is binary.
 * They still have to reach a tracing listener like every other request the
 * class makes: start and complete with status, duration, headers, class and
 * method, or start and error when the connection fails. The server is a
 * loopback one serving a real ZIP, so the whole sync runs, down to the SQLite
 * entity store.
 */
import {describe, test, expect, beforeAll, afterAll, beforeEach} from 'vitest';
import {createServer, Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import AdmZip from 'adm-zip';
import {AttractionsIOV1} from '../attractionsiov1.js';
import {CacheLib, database} from '../../../cache.js';
import {tracing, HttpTraceEvent} from '../../../tracing.js';

const RECORDS = {
  Resort: [{_id: 1, Name: 'Probe Resort'}],
  Category: [{_id: 10, Name: 'Rides'}],
  Item: [{_id: 100, Name: 'Big Coaster', Category: 10}],
};

function buildZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({version: 'probe-v1'})));
  zip.addFile('records.json', Buffer.from(JSON.stringify(RECORDS)));
  return zip.toBuffer();
}

class Probe extends AttractionsIOV1 {
  constructor(baseURL: string) {
    super({config: {destinationId: 'probe-resort', parkId: 'probe-park', timezone: 'Europe/London', baseURL, apiKey: 'probe-key'}});
  }

  override async getInstallationToken(): Promise<string> {
    return 'probe-token';
  }
}

describe('asset pack requests on the trace', () => {
  let server: Server;
  let baseURL: string;

  beforeAll(async () => {
    const zip = buildZip();
    server = createServer((req, res) => {
      if (req.url === '/data') {
        res.writeHead(303, {'Location': `${baseURL}pack.zip`});
        res.end();
      } else if (req.url === '/pack.zip') {
        res.writeHead(200, {'Content-Type': 'application/zip', 'Content-Length': zip.length});
        res.end(zip);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  });

  beforeEach(() => {
    CacheLib.clearAll();
    database.exec('DELETE FROM attractionsio_entities');
    database.exec('DELETE FROM attractionsio_versions');
  });

  function ofUrl(events: HttpTraceEvent[], path: string): HttpTraceEvent[] {
    return events.filter(e => e.url === `${baseURL}${path}`);
  }

  test('a sync emits start and complete for the redirect and for the ZIP', async () => {
    const probe = new Probe(baseURL);
    const {result, events} = await tracing.trace(() => probe.getPOIData());

    // The sync itself ran: the records came out of the ZIP and the store.
    expect(result.Item.map(item => item._id)).toEqual([100]);

    const data = ofUrl(events, 'data');
    expect(data.map(e => e.eventType)).toEqual(['http.request.start', 'http.request.complete']);
    expect(data[1]).toMatchObject({method: 'GET', status: 303, cacheHit: false, className: 'Probe', methodName: '_syncFromAPI'});
    expect(data[1].duration).toBeGreaterThanOrEqual(0);
    expect(data[0].headers?.authorization).toContain('installation-token="probe-token"');

    const pack = ofUrl(events, 'pack.zip');
    expect(pack.map(e => e.eventType)).toEqual(['http.request.start', 'http.request.complete']);
    expect(pack[1]).toMatchObject({method: 'GET', status: 200, cacheHit: false, className: 'Probe', methodName: 'downloadAssetPack'});
    expect(pack[1].body).toBeUndefined();

    // Nothing else was requested along the way.
    expect(events).toHaveLength(4);
  });

  test('a failed connection emits start and error', async () => {
    const probe = new Probe('http://127.0.0.1:1/');
    const {events} = await tracing.trace(async () => {
      await expect(probe.getPOIData()).rejects.toThrow();
    });

    expect(events.map(e => e.eventType)).toEqual(['http.request.start', 'http.request.error']);
    expect(events[1]).toMatchObject({url: 'http://127.0.0.1:1/data', method: 'GET', className: 'Probe', methodName: '_syncFromAPI'});
    expect(events[1].error).toBeInstanceOf(Error);
    expect(events[1].status).toBeUndefined();
  });
});
