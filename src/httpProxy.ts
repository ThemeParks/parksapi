// HTTP client built on undici's own fetch (NOT Node's global `fetch`).
//
// Undici handles the socket/parse work on its own thread pool, so the main
// event loop stays free for scheduling and timer callbacks. The previous
// node:http/https implementation did everything on the main thread, which
// starved setTimeout callbacks when 50+ destinations were pulling data at once.
//
// We must import `fetch` from `undici` rather than using Node's global
// `fetch` because Node bundles its own (older) undici. When we pass an
// `Agent` constructed from the npm-installed undici to the global fetch,
// the version mismatch surfaces as
//   "invalid onRequestStart method"
// at request time — undici's `Dispatcher` interceptor contract evolved
// between the bundled and installed versions. Pairing both halves through
// the npm-installed module keeps the contract consistent regardless of
// which Node release is in use.
import {
  Agent,
  ProxyAgent,
  Socks5ProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from 'undici';

/**
 * Make an HTTP request via fetch() with optional proxy / mutual-TLS support.
 *
 * @param options Request options
 * @returns Standard fetch Response
 */
/**
 * Redact secret query params from a proxy URL before it appears in logs or
 * error messages. Proxy services (Scrapfly/CrawlBase) carry the API key — and,
 * for Scrapfly, forwarded auth headers and request bodies — in the URL's query
 * string, which would otherwise leak into error/retry logs on failure. Only the
 * known proxy hosts and their sensitive params are touched; all other URLs are
 * returned unchanged.
 */
export function redactProxyUrlSecrets(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (u.hostname === 'api.scrapfly.io') {
      for (const name of [...u.searchParams.keys()]) {
        const lower = name.toLowerCase();
        if (lower === 'key' || lower === 'body' || lower.startsWith('headers[')) {
          u.searchParams.set(name, '***');
        }
      }
      return u.toString();
    }
    if (u.hostname === 'api.crawlbase.com' && u.searchParams.has('token')) {
      u.searchParams.set('token', '***');
      return u.toString();
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

export async function makeHttpRequest(options: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: any;
  proxyUrl?: string;
  /** Client SSL certificate (PEM format) for mutual TLS */
  cert?: string;
  /** Client SSL private key (PEM format) for mutual TLS */
  key?: string;
  /** Request timeout in milliseconds (default 30s) */
  timeoutMs?: number;
}): Promise<Response> {
  const {method, url, headers, body, proxyUrl, cert, key, timeoutMs = 30000} = options;

  const hdrs: Record<string, string> = {...(headers || {})};

  // Default User-Agent — parks that need app-specific UAs override via @inject
  if (!hdrs['user-agent'] && !hdrs['User-Agent']) {
    hdrs['user-agent'] = process.env.DEFAULT_USER_AGENT || 'parksapi/2.0';
  }

  // Ask for compressed responses — fetch decompresses transparently.
  if (!hdrs['accept-encoding'] && !hdrs['Accept-Encoding']) {
    hdrs['accept-encoding'] = 'gzip, deflate, br';
  }

  let fetchBody: BodyInit | undefined;
  if (body !== undefined && body !== null) {
    if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) {
      fetchBody = body as BodyInit;
    } else if (typeof body === 'object') {
      fetchBody = JSON.stringify(body);
    } else {
      fetchBody = String(body);
    }
  }

  const dispatcher = buildDispatcher(proxyUrl, cert, key);

  // Type the init object against undici's own RequestInit so the
  // dispatcher field is recognised and there's no global-vs-undici
  // BodyInit incompatibility at the call site below.
  const init: UndiciRequestInit & {dispatcher?: Dispatcher} = {
    method,
    headers: hdrs,
    body: fetchBody as UndiciRequestInit['body'],
    signal: AbortSignal.timeout(timeoutMs),
    // Attractions.io uses 303 to signal new ZIP data — callers need the raw
    // status + Location header, not the redirected body.
    redirect: 'manual',
  };
  if (dispatcher) {
    init.dispatcher = dispatcher;
  }

  try {
    // undici's `Response` type is structurally compatible with the
    // global `Response`; cast through `unknown` to satisfy TS without
    // disabling type-checking on the call itself.
    return await undiciFetch(url, init) as unknown as Response;
  } catch (err: any) {
    // Surface timeouts with the same message shape we used before so callers
    // (and log greps) don't need to change.
    if (err?.name === 'TimeoutError' || err?.code === 'UND_ERR_ABORTED' || err?.name === 'AbortError') {
      throw new Error(`HTTP request timed out after ${timeoutMs}ms: ${method} ${redactProxyUrlSecrets(url)}`);
    }
    throw err;
  }
}

function buildDispatcher(
  proxyUrl: string | undefined,
  cert: string | undefined,
  key: string | undefined,
): Dispatcher | undefined {
  if (proxyUrl) {
    if (proxyUrl.startsWith('socks')) {
      return new Socks5ProxyAgent(proxyUrl);
    }
    return new ProxyAgent(proxyUrl);
  }
  if (cert || key) {
    return new Agent({connect: {cert, key}});
  }
  return undefined;
}
