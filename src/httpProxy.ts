// HTTP client built on Node's global fetch (undici).
// Undici handles the socket/parse work on its own thread pool, so the main
// event loop stays free for scheduling and timer callbacks. The previous
// node:http/https implementation did everything on the main thread, which
// starved setTimeout callbacks when 50+ destinations were pulling data at once.
import {Agent, ProxyAgent, Socks5ProxyAgent, type Dispatcher} from 'undici';

/**
 * Make an HTTP request via fetch() with optional proxy / mutual-TLS support.
 *
 * @param options Request options
 * @returns Standard fetch Response
 */
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

  const init: RequestInit & {dispatcher?: Dispatcher} = {
    method,
    headers: hdrs,
    body: fetchBody,
    signal: AbortSignal.timeout(timeoutMs),
    // Attractions.io uses 303 to signal new ZIP data — callers need the raw
    // status + Location header, not the redirected body.
    redirect: 'manual',
  };
  if (dispatcher) {
    init.dispatcher = dispatcher;
  }

  try {
    return await fetch(url, init);
  } catch (err: any) {
    // Surface timeouts with the same message shape we used before so callers
    // (and log greps) don't need to change.
    if (err?.name === 'TimeoutError' || err?.code === 'UND_ERR_ABORTED' || err?.name === 'AbortError') {
      throw new Error(`HTTP request timed out after ${timeoutMs}ms: ${method} ${url}`);
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
