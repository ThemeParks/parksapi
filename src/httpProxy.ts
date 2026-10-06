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

// A `pageToken` matches too, at the cost of a page cursor in a log line.
const CREDENTIAL_PARAM = /(key|token|secret|password|signature|auth)$|^sig$/;

/**
 * Redact the credentials a request URL carries before it appears in a log
 * line or an error message: the proxy secrets of `redactProxyUrlSecrets()`,
 * then every query parameter whose name ends in `key`, `token`, `secret`,
 * `password`, `signature` or `auth`, or is `sig`, whatever its case. Each
 * matching value becomes `***`. A `url` parameter that holds another URL,
 * such as a scraping proxy's target, is redacted the same way. A URL without
 * such parameters, or a string that is not a URL, is returned unchanged.
 */
export function redactUrlSecrets(rawUrl: string): string {
  const proxyRedacted = redactProxyUrlSecrets(rawUrl);
  let url: URL;
  try {
    url = new URL(proxyRedacted);
  } catch {
    return proxyRedacted;
  }
  let changed = false;
  for (const [name, value] of [...url.searchParams.entries()]) {
    const lower = name.toLowerCase();
    if (CREDENTIAL_PARAM.test(lower)) {
      url.searchParams.set(name, '***');
      changed = true;
    } else if (lower === 'url') {
      const inner = redactUrlSecrets(value);
      if (inner !== value) {
        url.searchParams.set(name, inner);
        changed = true;
      }
    }
  }
  return changed ? url.toString() : proxyRedacted;
}

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * The request timeout, in milliseconds.
 *
 * `HTTP_TIMEOUT_MS` sets it for the whole process; a consumer that polls
 * every minute wants a hung park API to cost seconds, not the default 30s
 * per attempt. Only a positive whole number counts, anything else falls back
 * to the default so a typo in `.env` cannot switch timeouts off or make every
 * request fail at once. A `timeoutMs` passed to `makeHttpRequest` still wins.
 */
export function httpTimeoutMs(): number {
  const raw = process.env.HTTP_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
  const timeout = Number(raw);
  return Number.isInteger(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;
}

/** A request body as it goes out: text or bytes */
export type HttpRequestBody = string | Uint8Array | ArrayBuffer;

/**
 * The body as it goes out: a string, `Uint8Array` or `ArrayBuffer` as is, an
 * object as JSON, anything else as its string form, and nothing for `null`
 * or `undefined`.
 */
export function encodeHttpBody(body: unknown): HttpRequestBody | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) return body;
  if (typeof body === 'object') return JSON.stringify(body);
  return String(body);
}

export type HttpRequestOptions = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** Text or bytes go out as is, an object as JSON. A transport receives the body encoded */
  body?: any;
  proxyUrl?: string;
  /** Client SSL certificate (PEM format) for mutual TLS */
  cert?: string;
  /** Client SSL private key (PEM format) for mutual TLS */
  key?: string;
  /** Request timeout in milliseconds (default: `HTTP_TIMEOUT_MS`, else 30s) */
  timeoutMs?: number;
};

/**
 * Who makes a request. Every field is optional, since a direct call of
 * `makeHttpRequest()` may pass none of them.
 */
export type HttpCaller = {
  /** Class of the decorated method, e.g. `Efteling` */
  className?: string;
  /** The decorated method, e.g. `fetchCalendar` */
  methodName?: string;
  /**
   * Arguments the decorated method was called with, e.g. `[2026, 10]`. A
   * sign-in method is called with its credentials (an email address and a
   * password, a refresh token), so redact them before storing anything.
   */
  args?: unknown[];
  /**
   * A number that tells the instances of one class apart, e.g. `3`. It is
   * assigned when an instance first makes a request or, while a method
   * cache observer is set, first has a call answered from the method cache.
   * It is unique within the process across all classes, but can differ in
   * the next run, so do not key a recording on it.
   */
  instanceId?: number;
  /** 0 for the first attempt, 1 for the first retry, and so on */
  retryCount?: number;
};

// Stable numeric ids for the instances that make requests, for
// `HttpCaller.instanceId` and the in-flight deduplication key of `@http`.
const httpInstanceIds = new WeakMap<object, number>();
let httpInstanceIdCounter = 0;

export function getHttpInstanceId(instance: object): number {
  let id = httpInstanceIds.get(instance);
  if (id === undefined) {
    id = ++httpInstanceIdCounter;
    httpInstanceIds.set(instance, id);
  }
  return id;
}

/**
 * A function between the `@http` queue and the network. It receives the
 * request as it is about to go out (after the injectors, with the default
 * `user-agent` and `accept-encoding` filled in and the body encoded as it
 * is sent), who makes it, and `send`, which performs the real request. It
 * may call `send` (as is, or with a changed request) or return a `Response`
 * of its own without touching the network. Whatever `send` throws (a
 * timeout, a connection error) passes through unless the transport catches
 * it.
 *
 * Of the errors a transport lets through, only one that `send` rejected with
 * is retried, as a failed connection is, and only when the transport rethrows
 * it as is. Any other error the transport throws is its own, whether before
 * `send` (a replay without a recording) or after it (a recorder whose disk is
 * full), and fails the request at once without a retry, so a park that has
 * already answered is not asked again. A missing or already read Response
 * fails the same way. The caller receives an `HttpTransportError`, and a
 * request whose injector lets one through from a nested request fails
 * without a retry as well.
 *
 * Rules for a transport:
 * - Read a body only from `response.clone()`. The `Response` it returns
 *   must be unread, because parksapi reads it afterwards.
 * - The request carries secrets: auth headers, proxy keys and forwarded
 *   headers in the URL, `proxyUrl`, an mTLS `key`, the credentials in the
 *   body of a sign-in, whose response carries a token. `caller.args` can
 *   carry credentials too. Redact a copy before storing anything.
 *   `redactUrlSecrets(request.url)` masks what the URL carries of them:
 *   the proxy keys, the forwarded headers and the credential query
 *   parameters.
 * - What it returns is cached like a network response when the method
 *   caches.
 * - The timeout applies inside `send` only. A request from the queue holds
 *   its slot in the concurrency limit while the transport runs, so the
 *   transport must end on its own, must not call an `@http` method itself,
 *   and should not take longer than the request it replaces.
 */
export type HttpTransport = (
  request: HttpRequestOptions,
  caller: HttpCaller,
  send: (request: HttpRequestOptions) => Promise<Response>,
) => Promise<Response>;

let httpTransport: HttpTransport | null = null;

/**
 * A failure of the transport, as opposed to an error `send` rejected with:
 * the transport threw, or it returned no Response or a read one. The
 * `@http` queue fails the request without a retry and rejects with an error
 * of this class, see `HttpTransport`. `cause` holds what the transport
 * threw, for a request of the queue one level down, in the error of the
 * failed attempt. A missing or read Response has no such cause.
 */
export class HttpTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HttpTransportError';
  }
}

/**
 * Route every request through `transport` on its way to the network, for a
 * consumer that records the parks' responses, replays a recording, or tests a
 * destination offline. A request served from the HTTP cache never gets here.
 * `null` restores the default.
 */
export function setHttpTransport(transport: HttpTransport | null): void {
  httpTransport = transport;
}

/**
 * Make an HTTP request: through the transport when one is set, otherwise
 * via fetch() with optional proxy / mutual-TLS support.
 *
 * @param options Request options
 * @param caller Who makes the request, handed to the transport
 * @returns Standard fetch Response
 */
export async function makeHttpRequest(options: HttpRequestOptions, caller: HttpCaller = {}): Promise<Response> {
  const request = {...options, headers: withDefaultHeaders(options.headers), body: encodeHttpBody(options.body)};
  if (!httpTransport) {
    return sendHttpRequest(request);
  }

  // Only an error that came out of `send` is the network's. Anything else
  // the transport throws is its own and must not be retried (see
  // `HttpTransport`), so the errors `send` rejected with are remembered.
  const sendErrors: unknown[] = [];
  const send = async (outgoing: HttpRequestOptions): Promise<Response> => {
    try {
      return await sendHttpRequest(outgoing);
    } catch (error) {
      sendErrors.push(error);
      throw error;
    }
  };

  let response: Response;
  try {
    response = await httpTransport(request, caller, send);
  } catch (error) {
    if (sendErrors.includes(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpTransportError(`HTTP transport failed: ${message}`, {cause: error});
  }
  if (!response) {
    throw new HttpTransportError(`HTTP transport returned no Response: ${request.method} ${redactUrlSecrets(request.url)}`);
  }
  if (response.bodyUsed) {
    throw new HttpTransportError(`HTTP transport returned a Response whose body was already read: ${request.method} ${redactUrlSecrets(request.url)}`);
  }
  return response;
}

export function withDefaultHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const hdrs: Record<string, string> = {...(headers || {})};

  // Default User-Agent — parks that need app-specific UAs override via @inject
  if (!hdrs['user-agent'] && !hdrs['User-Agent']) {
    hdrs['user-agent'] = process.env.DEFAULT_USER_AGENT || 'parksapi/2.0';
  }

  // Ask for compressed responses — fetch decompresses transparently.
  if (!hdrs['accept-encoding'] && !hdrs['Accept-Encoding']) {
    hdrs['accept-encoding'] = 'gzip, deflate, br';
  }

  return hdrs;
}

async function sendHttpRequest(options: HttpRequestOptions): Promise<Response> {
  const {method, url, headers, body, proxyUrl, cert, key, timeoutMs = httpTimeoutMs()} = options;

  const hdrs = withDefaultHeaders(headers);
  const fetchBody = encodeHttpBody(body) as BodyInit | undefined;

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
      throw new Error(`HTTP request timed out after ${timeoutMs}ms: ${method} ${redactUrlSecrets(url)}`);
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
