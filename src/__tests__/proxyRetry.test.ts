/**
 * A retried request starts from the request the caller built, wrapped by the
 * proxy once.
 *
 * `fireRequest()` broadcasts `httpRequest` on every attempt, on the same request
 * object. The injectors rewrite that object in place: the park's auth injector
 * adds a header, a signing injector edits the body, and `_injectProxy` swaps the
 * URL for the proxy's. Unless the request is put back first, the second attempt
 * starts from the proxy's request: CrawlBase is asked to fetch CrawlBase, a
 * Scrapfly POST turns into a GET without its body, an edit to the body is made
 * twice, and the park's injectors, matching on the target's host, no longer see
 * a request for it and do not run.
 *
 * A transport answers 500 to the first request each of those is sent and 200 to
 * the second, so the retry is the only thing that differs. They run once, in
 * `beforeAll`, so that the real retry backoff is waited for once and each claim
 * below reports on its own.
 */
import {setHttpTransport, HttpRequestOptions} from '../httpProxy.js';
import {Destination} from '../destination.js';
import {http, HTTPObj, stopHttpQueue} from '../http.js';
import {inject} from '../injector.js';
import {hostnameFromUrl} from '../datetime.js';

const PARK = 'https://park.example';

/** A value that serialises to a string, as a value object does. A structured clone would turn it into its fields. */
class Money {
  constructor(readonly cents: number) {}
  toJSON() {
    return `$${this.cents / 100}`;
  }
}

class ParkDestination extends Destination {
  /** The park's own authentication, added to requests for the park's host only. */
  @inject({
    eventName: 'httpRequest',
    hostname: function (this: ParkDestination) { return hostnameFromUrl(PARK); },
  })
  async injectAuth(req: HTTPObj): Promise<void> {
    req.headers = {...req.headers, 'x-api-key': 'park-key'};
  }

  /** Edits a plain-object body in place, as a signing injector might. */
  @inject({
    eventName: 'httpRequest',
    hostname: function (this: ParkDestination) { return hostnameFromUrl(PARK); },
    tags: {$in: ['signed']},
  })
  async signBody(req: HTTPObj): Promise<void> {
    req.body.signedCount = (req.body.signedCount ?? 0) + 1;
  }

  @http({cacheSeconds: 0, retries: 1})
  async fetchPois(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${PARK}/api/poi`,
      queryParams: {language: 'en', park: 'x'},
      tags: ['poi'],
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 0, retries: 1})
  async postQuery(): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${PARK}/api/query`,
      body: '{"q":"rides"}',
      headers: {'content-type': 'application/json'},
      tags: ['query'],
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 0, retries: 1})
  async postSigned(): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${PARK}/api/sign`,
      body: {q: 1},
      options: {json: true},
      tags: ['signed'],
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 0, retries: 1})
  async postMoney(): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${PARK}/api/money`,
      body: {price: new Money(500)},
      options: {json: true},
      tags: ['money'],
    } as any as HTTPObj;
  }

  /** Asks for no retries, so nothing will ever need the request as it was built. */
  @http({cacheSeconds: 0})
  async postOnce(): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${PARK}/api/once`,
      body: {q: 1},
      options: {json: true},
      tags: ['once'],
    } as any as HTTPObj;
  }

  /** Not what the types allow: a caller that gets it wrong must not be left waiting. */
  @http({cacheSeconds: 0, retries: 1})
  async fetchOddTags(): Promise<HTTPObj> {
    return {method: 'GET', url: `${PARK}/api/odd`, tags: 5} as any as HTTPObj;
  }
}

describe('a request retried through a proxy', () => {
  /** The requests the transport was sent, by `host/path`, in order. */
  const sent: Record<string, HttpRequestOptions[]> = {};
  /** Answered with a 500 the first time, so that they are retried. */
  const RETRIED = new Set(['api.crawlbase.com/', 'api.scrapfly.io/scrape', 'park.example/api/sign', 'park.example/api/money']);
  let direct: ParkDestination;

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setHttpTransport(async (request) => {
      const url = new URL(request.url);
      const key = `${url.hostname}${url.pathname}`;
      const attempts = (sent[key] ??= []);
      attempts.push({method: request.method, url: request.url, headers: request.headers, body: request.body});
      const status = RETRIED.has(key) && attempts.length === 1 ? 500 : 200;
      return new Response('{}', {status, headers: {'content-type': 'application/json'}});
    });

    const crawlbase = new ParkDestination();
    crawlbase.proxyConfig = {crawlbase: {apikey: 'crawl-key'}};
    const scrapfly = new ParkDestination();
    scrapfly.proxyConfig = {scrapfly: {apikey: 'scrap-key'}};
    direct = new ParkDestination();

    await Promise.all([crawlbase.fetchPois(), scrapfly.postQuery(), direct.postSigned(), direct.postMoney()]);
  }, 10000);

  afterAll(() => {
    setHttpTransport(null);
    vi.restoreAllMocks();
    stopHttpQueue();
  });

  it('reaches CrawlBase wrapped once, with the query inside the target, the same each attempt', () => {
    const attempts = sent['api.crawlbase.com/'];
    expect(attempts).toHaveLength(2);
    const target = encodeURIComponent(`${PARK}/api/poi?language=en&park=x`);
    expect(attempts[0].url).toBe(`https://api.crawlbase.com/?url=${target}&token=crawl-key`);
    expect(attempts[1]).toEqual(attempts[0]);
  });

  it('reaches Scrapfly as the same POST with its body and the park header each attempt', () => {
    const attempts = sent['api.scrapfly.io/scrape'];
    expect(attempts).toHaveLength(2);
    const first = new URL(attempts[0].url);
    expect(attempts[0].method).toBe('GET');
    expect(first.origin + first.pathname).toBe('https://api.scrapfly.io/scrape');
    expect(first.searchParams.get('url')).toBe(`${PARK}/api/query`);
    expect(first.searchParams.get('method')).toBe('POST');
    expect(first.searchParams.get('body')).toBe('{"q":"rides"}');
    expect(first.searchParams.get('headers[x-api-key]')).toBe('park-key');
    expect(attempts[1]).toEqual(attempts[0]);
  });

  it('shows an injector that edits a plain-object body in place the body as built on every attempt', () => {
    const attempts = sent['park.example/api/sign'];
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => JSON.parse(String(a.body)))).toEqual([
      {q: 1, signedCount: 1},
      {q: 1, signedCount: 1},
    ]);
  });

  it('sends a body that holds a value with toJSON the same on a retry', () => {
    const attempts = sent['park.example/api/money'];
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => String(a.body))).toEqual(['{"price":"$5"}', '{"price":"$5"}']);
  });

  it('does not copy the body of a request that cannot be retried', async () => {
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      await direct.postOnce();
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
  }, 5000);

  it('settles a request whose tags are not an array rather than leaving its caller waiting', async () => {
    await expect(direct.fetchOddTags()).resolves.toBeDefined();
  }, 5000);
});
