/**
 * What a log line or an error message shows of a request URL.
 *
 * `redactUrlSecrets()` masks the proxy secrets `redactProxyUrlSecrets()`
 * knows (Scrapfly's `key`, forwarded headers and body, CrawlBase's `token`)
 * and every query parameter named like a credential, in the proxy's own query
 * and in the target URL the proxy takes as `url`. The retry and failure lines
 * of `fireRequest()`, the error a failed request rejects with and the error
 * for a transport that returned a read body run through it. The retry and
 * failure lines are exercised against a destination whose requests
 * `_injectProxy` rewrites for CrawlBase, the error for a read body against
 * the same destination without a proxy, where the transport's own error ends
 * the request without a retry. A transport answers both, so neither the proxy
 * nor the network is involved.
 */
import {redactUrlSecrets, setHttpTransport} from '../httpProxy.js';
import {Destination} from '../destination.js';
import {http, HTTPObj, stopHttpQueue} from '../http.js';

describe('redactUrlSecrets', () => {
  it('masks the Scrapfly key, forwarded headers and body, and the credentials of the target', () => {
    const target = 'https://park.example/api/attractions/?key=park-key&locale=en';
    const result = redactUrlSecrets(
      `https://api.scrapfly.io/scrape?url=${encodeURIComponent(target)}&key=scrapfly-key` +
      '&headers[x-api-key]=header-key&body=payload&render_js=true',
    );

    const url = new URL(result);
    expect(url.searchParams.get('key')).toBe('***');
    expect(url.searchParams.get('headers[x-api-key]')).toBe('***');
    expect(url.searchParams.get('body')).toBe('***');
    expect(url.searchParams.get('render_js')).toBe('true');
    expect(url.searchParams.get('url')).toBe('https://park.example/api/attractions/?key=***&locale=en');
    expect(result).not.toContain('park-key');
    expect(result).not.toContain('scrapfly-key');
    expect(result).not.toContain('header-key');
  });

  it('masks the CrawlBase token and the credentials of the target', () => {
    const target = 'https://park.example/wait-times?apikey=park-key';
    const result = redactUrlSecrets(`https://api.crawlbase.com/?url=${encodeURIComponent(target)}&token=crawl-token`);

    const url = new URL(result);
    expect(url.searchParams.get('token')).toBe('***');
    expect(url.searchParams.get('url')).toBe('https://park.example/wait-times?apikey=***');
    expect(result).not.toContain('park-key');
    expect(result).not.toContain('crawl-token');
  });

  it('masks the credential parameters of a park URL, whatever their case', () => {
    const result = redactUrlSecrets(
      'https://park.example/api?key=a&sc_apikey=b&access_token=c&client_secret=d' +
      '&apiKey=e&signature=f&sig=g&auth=h&password=i&locale=en&page=2',
    );

    const params = Object.fromEntries(new URL(result).searchParams);
    expect(params).toEqual({
      key: '***',
      sc_apikey: '***',
      access_token: '***',
      client_secret: '***',
      apiKey: '***',
      signature: '***',
      sig: '***',
      auth: '***',
      password: '***',
      locale: 'en',
      page: '2',
    });
  });

  it('returns a URL without credentials unchanged', () => {
    const plain = 'https://park.example/api/v2/poi-group?status[]=live&page=2';
    expect(redactUrlSecrets(plain)).toBe(plain);
    expect(redactUrlSecrets('https://park.example/wait-times')).toBe('https://park.example/wait-times');
  });

  it('returns a string that is not a URL unchanged', () => {
    expect(redactUrlSecrets('not a url')).toBe('not a url');
  });
});

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('the retry and failure log lines', () => {
  class ProxiedDestination extends Destination {
    constructor(private readonly baseURL: string) {
      super();
    }

    @http({cacheSeconds: 0, retries: 1})
    async fetchFailing(): Promise<HTTPObj> {
      return {method: 'GET', url: `${this.baseURL}/status/500?key=park-secret`, tags: ['failing']} as HTTPObj;
    }

    @http({cacheSeconds: 0, retries: 1})
    async fetchOnce(): Promise<HTTPObj> {
      return {method: 'GET', url: `${this.baseURL}/posts?key=park-secret`, tags: ['posts']} as HTTPObj;
    }
  }

  afterAll(() => {
    stopHttpQueue();
  });

  afterEach(() => {
    setHttpTransport(null);
  });

  it('mask the proxy key and the park key of a request rewritten for CrawlBase', async () => {
    const sent: string[] = [];
    setHttpTransport(async (request) => {
      sent.push(request.url);
      return new Response('{}', {status: 500, headers: {'content-type': 'application/json'}});
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const destination = new ProxiedDestination('http://127.0.0.1:9');
      destination.proxyConfig = {crawlbase: {apikey: 'crawlbase-secret'}};

      let rejection = '';
      await destination.fetchFailing().catch((e: Error) => { rejection = e.message; });

      // Both attempts reached the transport with the keys in clear, so there was something to mask.
      expect(sent).toHaveLength(2);
      expect(sent[0]).toBe('https://api.crawlbase.com/?url=http%3A%2F%2F127.0.0.1%3A9%2Fstatus%2F500%3Fkey%3Dpark-secret&token=crawlbase-secret');

      expect(warn).toHaveBeenCalledTimes(1);
      const [retryLine, retryError] = warn.mock.calls[0];
      expect(retryLine).toMatch(/^HTTP request failed, retrying in \d+s \(attempt 1, 0 retries left\): GET https:\/\/api\.crawlbase\.com\/\?url=http%3A%2F%2F127\.0\.0\.1%3A9%2Fstatus%2F500%3Fkey%3D\*\*\*&token=\*\*\*$/);
      expect(String(retryError)).toContain('URL: GET https://api.crawlbase.com/?url=http%3A%2F%2F127.0.0.1%3A9%2Fstatus%2F500%3Fkey%3D***&token=***');

      // The retry starts from the request the caller built, so it is wrapped
      // for CrawlBase once, like the first attempt, and its lines read the same.
      expect(sent[1]).toBe(sent[0]);
      const masked = 'https://api.crawlbase.com/?url=http%3A%2F%2F127.0.0.1%3A9%2Fstatus%2F500%3Fkey%3D***&token=***';
      expect(error).toHaveBeenCalledTimes(1);
      const [failureLine] = error.mock.calls[0];
      expect(failureLine).toMatch(new RegExp(`^HTTP request failed, no retries left: GET ${escapeRegExp(masked)} HTTP request not OK: 500`));
      expect(rejection).toMatch(new RegExp(`^GET ${escapeRegExp(masked)}: HTTP request not OK: 500`));

      for (const text of [retryLine, String(retryError), failureLine, rejection]) {
        expect(text).not.toContain('crawlbase-secret');
        expect(text).not.toContain('park-secret');
      }
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  }, 10000);

  it('mask the park key in the error for a transport that returned a read body', async () => {
    let calls = 0;
    setHttpTransport(async () => {
      calls++;
      const response = new Response('{}', {status: 200, headers: {'content-type': 'application/json'}});
      await response.text();
      return response;
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const destination = new ProxiedDestination('http://127.0.0.1:9');

      await expect(destination.fetchOnce()).rejects.toThrow(
        /^GET http:\/\/127\.0\.0\.1:9\/posts\?key=\*\*\*: HTTP transport returned a Response whose body was already read: GET http:\/\/127\.0\.0\.1:9\/posts\?key=\*\*\*$/,
      );
      expect(calls).toBe(1);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0][0]).toMatch(/^HTTP request failed, not retrying: GET http:\/\/127\.0\.0\.1:9\/posts\?key=\*\*\* HTTP transport returned/);
      expect(error.mock.calls[0][0]).not.toContain('park-secret');
    } finally {
      error.mockRestore();
    }
  });
});
