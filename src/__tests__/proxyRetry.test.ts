/**
 * A retried request is wrapped by the proxy once, and is the request it was.
 *
 * `fireRequest()` broadcasts `httpRequest` on every attempt, on the same request
 * object. The injectors rewrite that object in place: the park's auth injector
 * adds a header, and `_injectProxy` swaps the URL for the proxy's. Unless the
 * request is put back first, the second attempt starts from the proxy's request:
 * CrawlBase is asked to fetch CrawlBase, a Scrapfly POST turns into a GET
 * without its body, and the park's injectors, matching on the target's host,
 * no longer see a request for it and do not run.
 *
 * A transport answers for both proxies, 500 to the first request each is sent
 * and 200 to the second, so the retry is the only thing that differs.
 */
import {setHttpTransport, HttpRequestOptions} from '../httpProxy.js';
import {Destination} from '../destination.js';
import {http, HTTPObj, stopHttpQueue} from '../http.js';
import {inject} from '../injector.js';
import {hostnameFromUrl} from '../datetime.js';

const PARK = 'https://park.example';

class ParkDestination extends Destination {
  /** The park's own authentication, added to requests for the park's host only. */
  @inject({
    eventName: 'httpRequest',
    hostname: function (this: ParkDestination) { return hostnameFromUrl(PARK); },
  })
  async injectAuth(req: HTTPObj): Promise<void> {
    req.headers = {...req.headers, 'x-api-key': 'park-key'};
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
}

describe('a request retried through a proxy', () => {
  afterAll(() => {
    stopHttpQueue();
  });

  afterEach(() => {
    setHttpTransport(null);
    vi.restoreAllMocks();
  });

  it('reaches the proxy wrapped once, the same each attempt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sent: Record<string, HttpRequestOptions[]> = {};
    setHttpTransport(async (request) => {
      const attempts = (sent[new URL(request.url).hostname] ??= []);
      attempts.push({method: request.method, url: request.url, headers: request.headers, body: request.body});
      const status = attempts.length === 1 ? 500 : 200;
      return new Response('{}', {status, headers: {'content-type': 'application/json'}});
    });

    const crawlbase = new ParkDestination();
    crawlbase.proxyConfig = {crawlbase: {apikey: 'crawl-key'}};
    const scrapfly = new ParkDestination();
    scrapfly.proxyConfig = {scrapfly: {apikey: 'scrap-key'}};

    await Promise.all([crawlbase.fetchPois(), scrapfly.postQuery()]);

    // CrawlBase: the target once, with its own query inside `url` and none left
    // on the CrawlBase call, then the same request again.
    const cb = sent['api.crawlbase.com'];
    expect(cb).toHaveLength(2);
    const target = encodeURIComponent(`${PARK}/api/poi?language=en&park=x`);
    expect(cb[0].url).toBe(`https://api.crawlbase.com/?url=${target}&token=crawl-key`);
    expect(cb[1]).toEqual(cb[0]);

    // Scrapfly: a POST with its body and the park's header, the same each time.
    const sf = sent['api.scrapfly.io'];
    expect(sf).toHaveLength(2);
    const first = new URL(sf[0].url);
    expect(sf[0].method).toBe('GET');
    expect(first.origin + first.pathname).toBe('https://api.scrapfly.io/scrape');
    expect(first.searchParams.get('url')).toBe(`${PARK}/api/query`);
    expect(first.searchParams.get('method')).toBe('POST');
    expect(first.searchParams.get('body')).toBe('{"q":"rides"}');
    expect(first.searchParams.get('headers[x-api-key]')).toBe('park-key');
    expect(sf[1]).toEqual(sf[0]);
  }, 10000);
});
