// HTTP library with decorator support for HTTP methods
//  Methods decorated with @http must return an HTTPRequest object
//  The HTTP library will then execute the request and return an HTTPResponse object

import {CacheLib} from "./cache.js";
import {broadcast} from "./injector.js";
import {tracing} from "./tracing.js";
import Ajv, {type DefinedError} from "ajv";
// Note: basic proxy URL is now set per-request via proxyUrl property (injected by Destination._injectProxy)
import {makeHttpRequest} from "./httpProxy.js";
const ajv = new Ajv.default();

// OpenAPI-like parameter definition
export type HTTPParameter = {
  name: string;
  type: string;
  description: string;
  required?: boolean; // Optional: mark as required/optional
  example?: any;      // Optional: example value
};

// Parameter definition for decorator options (same structure but more explicit)
export type HTTPParameterDefinition = HTTPParameter;

// represents an HTTP method that has been decorated with @http
export type HTTPRequester = {
  // class name
  instance: string;
  // method name
  methodName: string;
  // method arguments with OpenAPI-like schema
  args: HTTPParameter[];
  // number of parameters the original function accepts (0 = can call without args)
  paramCount: number;
  // default arguments for health check testing (supports template variables)
  healthCheckArgs?: any[];
};
const httpRequesters: HTTPRequester[] = [];

// In-flight deduplication map for @http decorated methods.
// Key: "<instanceId>:<methodName>:<serialisedArgs>"
// While a promise is pending, concurrent calls with the same key return the same promise.
const httpInflightMap = new Map<string, Promise<HTTPObj>>();

// WeakMap to assign stable numeric IDs to instances (for dedup key building)
const httpInstanceIds = new WeakMap<object, number>();
let httpInstanceIdCounter = 0;

function getHttpInstanceId(instance: object): number {
  let id = httpInstanceIds.get(instance);
  if (id === undefined) {
    id = ++httpInstanceIdCounter;
    httpInstanceIds.set(instance, id);
  }
  return id;
}

/**
 * Clear the in-flight deduplication map.
 * WARNING: Only use in tests.
 */
export function clearHttpInflightMap(): void {
  httpInflightMap.clear();
}

// Options for HTTP requests
export type HTTPOptions = {
  json?: boolean; // shortcut to set Content-Type: application/json and stringify body
  /** Client SSL certificate (PEM string) for mutual TLS */
  cert?: string;
  /** Client SSL private key (PEM string) for mutual TLS */
  key?: string;
};

// Full HTTP object with response methods (for runtime use)
export interface HTTPObj {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  url: string;
  headers?: Record<string, string>;
  options?: HTTPOptions;
  queryParams?: Record<string, string>;
  body?: any;
  tags: string[];

  response?: Response;

  // functions to get response data
  json(): Promise<any>;
  text(): Promise<string>;
  blob(): Promise<Blob>;
  arrayBuffer(): Promise<ArrayBuffer>;
  status: number;
  ok: boolean;
  clone(): HTTPObj;

  // callback functions
  onJson: ((data: any) => void) | null;
  onText: ((data: string) => void) | null;
  onBlob: ((data: Blob) => void) | null;
  onArrayBuffer: ((data: ArrayBuffer) => void) | null;
}

// entry of HTTP requests, store class instance, method name, and request object
export type HTTPRequestEntry = {
  instance: any;
  methodName: string;
  args: any[];
  request: HTTPRequestImpl;
  // optional timestamp to indicate when this request can be executed
  //  will remain in the queue until that time
  earliestExecute?: number;
  // cache time in seconds (optional)
  cacheTtlSeconds?: number;
  // validator function for response (optional)
  validateResponse?: any;
  // class name for trace events
  className?: string;
};

// Internal type for queue entries, includes retryAttempt for internal use only
type InternalHTTPRequestEntry = HTTPRequestEntry & {
  // track which retry attempt this is (0 = first retry, 1 = second, etc.)
  retryAttempt?: number;
  // capture trace context when request is queued
  traceContext?: any;
};

// Per-destination HTTP queue. Each destination gets its own so that a slow or
// failing park doesn't block requests for any other park. The global helpers
// below (waitForHttpQueue / getQueueLength / processHttpQueue / stopHttpQueue)
// aggregate across all registered queues.
export class HttpQueue {
  public readonly requests: InternalHTTPRequestEntry[] = [];
  private nextRequestEarliestMs = 0;
  private readonly rateLimitMs: number;

  constructor(rateLimitMs = 250) {
    this.rateLimitMs = rateLimitMs;
  }

  push(entry: InternalHTTPRequestEntry): void {
    this.requests.push(entry);
    this.requests.sort((a, b) => (a.earliestExecute || 0) - (b.earliestExecute || 0));
    activeQueues.add(this);
  }

  size(): number {
    return this.requests.length;
  }

  /**
   * Process queued requests until the queue is empty or blocked by an
   * earliest-execute / rate-limit gate. Concurrent invocations are safe:
   * Node's single-threaded event loop makes the atomic check-and-set on
   * `nextRequestEarliestMs` and the `requests.shift()` race-free. We can't
   * simply guard against re-entry — HTTP request injectors frequently make
   * nested requests that need to be processed by another invocation while
   * the outer one is awaiting the injector.
   */
  async processOne(): Promise<void> {
    while (this.requests.length > 0 && !globalStopped) {
      const now = Date.now();
      const firstEntry = this.requests[0];
      if (firstEntry.earliestExecute && firstEntry.earliestExecute > now) break;

      if (this.nextRequestEarliestMs > now) break;

      // Reserve rate-limit slot and pull the request off the head of the queue.
      this.nextRequestEarliestMs = now + this.rateLimitMs;
      const entry = this.requests.shift()!;
      await fireRequest(entry, (e) => this.push(e));
    }
    if (this.requests.length === 0) activeQueues.delete(this);
  }
}

// Registry of queues with pending work. The global pump iterates this set.
const activeQueues = new Set<HttpQueue>();

// Global stop flag, set by stopHttpQueue(). Per-queue loops check this each
// iteration and exit cleanly — this is how tests shut down all HTTP activity.
let globalStopped = false;

// Default queue for any legacy caller that invokes an @http-decorated method
// on something that isn't a Destination. Every Destination instance gets its
// own dedicated queue; this one is a safety net only.
const defaultHttpQueue = new HttpQueue();

/**
 * Global cap on the number of HTTP requests in the actual network-I/O phase
 * at any one time. Per-destination queues isolate failures, but with 50+
 * queues each firing concurrently the event loop saturates and timers
 * (including task timeouts) miss their deadlines by many seconds.
 *
 * We only hold a permit across the makeRequest() call itself — NOT across
 * request/response injection handlers, which frequently make nested HTTP
 * calls. Holding the permit across injectors would priority-invert: every
 * permit-holder waits on a nested request that can't acquire a permit.
 * Simple counter + waiting queue (not a mutex) for the same reason the
 * old rate limiter was a timestamp rather than a lock.
 */
class HttpConcurrencyLimiter {
  private readonly max: number;
  private inflight = 0;
  private waiting: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  async acquire(): Promise<void> {
    if (this.inflight < this.max) {
      this.inflight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      // Hand the permit off directly — inflight stays unchanged.
      next();
    } else {
      this.inflight--;
    }
  }

  get inFlight(): number {
    return this.inflight;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }
}

const HTTP_MAX_CONCURRENT = Math.max(
  1,
  parseInt(process.env.HTTP_MAX_CONCURRENT || '20', 10) || 20,
);
const globalHttpLimiter = new HttpConcurrencyLimiter(HTTP_MAX_CONCURRENT);

// Internal class to handle HTTPRequest with private promise handlers
class HTTPRequestImpl implements HTTPObj {
  public method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  public url: string;
  public headers: Record<string, string>;
  public options?: HTTPOptions;
  public body?: any;
  public queryParams?: Record<string, string>;
  public response?: Response;
  public retries: number;
  public cacheKey?: string;
  public cacheTtlSeconds?: number;
  public tags: string[];
  public className?: string; // Class name for cache key uniqueness
  public proxyUrl?: string; // Per-request proxy URL (set by Destination._injectProxy)

  // Private promise handlers
  private _resolve?: (value: HTTPObj) => void;
  private _reject?: (reason?: any) => void;

  // Buffered body bytes — set once on first read so that multiple callers sharing
  // the same HTTPRequestImpl (via @http in-flight dedup) can all call .json()/.text()/.blob()/.arrayBuffer()
  private _bufferPromise?: Promise<ArrayBuffer>;

  private _onJson: ((data: any) => void) | null = null;
  private _onText: ((data: string) => void) | null = null;
  private _onBlob: ((data: Blob) => void) | null = null;
  private _onArrayBuffer: ((data: ArrayBuffer) => void) | null = null;

  constructor(request: HTTPObj) {
    this.method = request.method;
    this.url = request.url;
    this.options = request.options;
    this.queryParams = request.queryParams;
    this.body = request.body;
    this.response = request.response;
    this.tags = request.tags || [];
    this.headers = request.headers || {};

    this._onJson = request.onJson || null;
    this._onText = request.onText || null;
    this._onBlob = request.onBlob || null;
    this._onArrayBuffer = request.onArrayBuffer || null;

    // Generate initial cache key by hashing method, URL, headers, and body
    this.cacheKey = this.generateCacheKey();

    this.retries = 0; // default retries to 0
  }

  /** Callbacks */
  get onJson(): ((data: any) => void) | null {
    return this._onJson;
  }
  set onJson(handler: ((data: any) => void) | null) {
    this._onJson = handler;
  }

  get onText(): ((data: string) => void) | null {
    return this._onText;
  }
  set onText(handler: ((data: string) => void) | null) {
    this._onText = handler;
  }

  get onBlob(): ((data: Blob) => void) | null {
    return this._onBlob;
  }
  set onBlob(handler: ((data: Blob) => void) | null) {
    this._onBlob = handler;
  }

  get onArrayBuffer(): ((data: ArrayBuffer) => void) | null {
    return this._onArrayBuffer;
  }
  set onArrayBuffer(handler: ((data: ArrayBuffer) => void) | null) {
    this._onArrayBuffer = handler;
  }

  /**
   * Build the full URL with query parameters
   * @returns {string} Full URL with query parameters
   */
  public buildUrl(): string {
    const url = new URL(this.url);
    if (this.queryParams) {
      Object.entries(this.queryParams).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }
    return url.toString();
  }

  /**
   * Get the headers for the request, including any default headers
   * @returns {Record<string, string>} Headers object
   */
  public buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.headers) {
      Object.entries(this.headers).forEach(([key, value]) => {
        headers[key] = value;
      });
    }
    if (this.options?.json) {
      headers['Content-Type'] = 'application/json';
      headers['Accept'] = 'application/json';
    }
    return headers;
  }

  /**
   * Generate a cache key for the request, based on class name, method, URL, headers, and body
   * @returns {string} Cache key for the request, based on class name, method, URL, headers, and body
   */
  public generateCacheKey(): string {
    const url = this.buildUrl();
    const headers = this.buildHeaders();
    const bodyString = this.body ? JSON.stringify(this.body) : '';
    const classPrefix = this.className ? `${this.className}:` : '';
    // Plaintext key — includes class name to prevent conflicts between destinations.
    // Not hashed: SQLite TEXT PRIMARY KEY indexes handle long keys fine, and keeping
    // the raw key makes cache inspection/debugging trivial.
    return `${classPrefix}${this.method}:${url}:${JSON.stringify(headers)}:${bodyString}`;
  }

  // Internal method to set promise handlers
  public setPromiseHandlers(resolve: (value: HTTPObj) => void, reject: (reason?: any) => void): void {
    this._resolve = resolve;
    this._reject = reject;
  }

  // Internal method to resolve the promise
  public resolvePromise(response: HTTPObj): void {
    this._resolve?.(response);
  }

  // Internal method to reject the promise
  public rejectPromise(reason?: any): void {
    this._reject?.(reason);
  }

  // Internal method to actually make this HTTP request
  //  Popuplates the response property on success
  async makeRequest(traceContext?: any, className?: string, methodName?: string): Promise<void> {
    const startTime = Date.now();

    // first, check the cache
    if (this.cacheKey && CacheLib.has(this.cacheKey)) {
      const cachedValue = CacheLib.get(this.cacheKey);
      if (cachedValue) {
        try {
          this.response = new Response(cachedValue);

          // Try to parse body for trace (but don't fail if we can't)
          let responseBody: any = undefined;
          try {
            responseBody = JSON.parse(cachedValue);
          } catch {
            responseBody = cachedValue.substring(0, 1000); // First 1000 chars if not JSON
          }

          // Emit trace event for cache hit (use provided context if available).
          // We don't store the original status code in the cache, so the trace
          // reports whatever new Response() gave us (always 200 today). Only
          // 2xx responses are cached, so this is the right ballpark.
          tracing.emitHttpEvent({
            eventType: 'http.request.complete',
            url: this.url,
            method: this.method,
            status: this.response.status,
            duration: Date.now() - startTime,
            cacheHit: true,
            headers: this.buildHeaders(),
            body: responseBody,
            className,
            methodName,
          }, traceContext);

          return; // return early with cached response
        } catch (error) {
          console.warn("Failed to parse cached response, proceeding with HTTP request.", error);
        }
      }
    }

    // Use node:http/https for all requests (with optional proxy support)
    const urlToFetch = this.buildUrl();
    let requestBody: any = undefined;

    if (this.body) {
      requestBody = this.options?.json ? JSON.stringify(this.body) : this.body;
    }

    const response = await makeHttpRequest({
      method: this.method,
      url: urlToFetch,
      headers: this.buildHeaders(),
      body: requestBody,
      proxyUrl: this.proxyUrl, // Per-request proxy URL (set by Destination._injectProxy)
      cert: this.options?.cert,
      key: this.options?.key,
    });

    this.response = response;

    // cache the response if response is OK and cacheKey is set
    if (this.cacheKey && response.ok && this.cacheTtlSeconds && this.cacheTtlSeconds > 0) {
      const responseClone = response.clone();
      const responseText = await responseClone.text();
      CacheLib.set(this.cacheKey, responseText, this.cacheTtlSeconds);
    }

    // if response is OK, check if we have any callbacks to call
    try {
      if (response.ok) {
        if (this._onJson) {
          const jsonData = await response.clone().json();
          this._onJson(jsonData);
        }
        if (this._onText) {
          const textData = await response.clone().text();
          this._onText(textData);
        }
        if (this._onBlob) {
          const blobData = await response.clone().blob();
          this._onBlob(blobData);
        }
        if (this._onArrayBuffer) {
          const arrayBufferData = await response.clone().arrayBuffer();
          this._onArrayBuffer(arrayBufferData);
        }
      }
    } catch (error) {
      console.warn("Error processing response callbacks:", error);
    }

    // throw error if response not ok
    if (!response.ok) {
      let bodySnippet = '';
      try {
        const text = await response.clone().text();
        bodySnippet = text.substring(0, 200);
      } catch { /* ignore */ }
      throw new Error(
        `HTTP request not OK: ${response.status} ${response.statusText}\n` +
        `  URL: ${this.method} ${urlToFetch}\n` +
        (bodySnippet ? `  Body: ${bodySnippet}\n` : '')
      );
    }

    // Capture response body for trace event
    let responseBody: any = undefined;
    try {
      const clonedResponse = response.clone();
      const contentType = response.headers.get('content-type');

      if (contentType?.includes('application/json')) {
        responseBody = await clonedResponse.json();
      } else {
        const text = await clonedResponse.text();
        // Truncate large text responses to 1000 chars
        responseBody = text.length > 1000 ? text.substring(0, 1000) + '...' : text;
      }
    } catch (error) {
      // If we can't parse the body, just skip it (don't fail the request)
      console.warn("Failed to capture response body for trace:", error);
    }

    // Emit trace event for successful request (use provided context if available)
    tracing.emitHttpEvent({
      eventType: 'http.request.complete',
      url: this.url,
      method: this.method,
      status: response.status,
      duration: Date.now() - startTime,
      cacheHit: false,
      headers: this.buildHeaders(),
      body: responseBody,
      className,
      methodName,
    }, traceContext);
  }

  // Lazily buffer raw bytes so multiple callers sharing this HTTPRequestImpl
  // (via @http in-flight dedup) can all call .json()/.text()/.blob()/.arrayBuffer()
  private getBuffer(): Promise<ArrayBuffer> {
    if (!this._bufferPromise) {
      this._bufferPromise = this.response!.arrayBuffer();
    }
    return this._bufferPromise;
  }

  // Passthrough common response methods
  async json(): Promise<any> {
    if (!this.response) {
      throw new Error("No response available.");
    }
    return JSON.parse(new TextDecoder().decode(await this.getBuffer()));
  }

  async text(): Promise<string> {
    if (!this.response) {
      throw new Error("No response available.");
    }
    return new TextDecoder().decode(await this.getBuffer());
  }

  async blob(): Promise<Blob> {
    if (!this.response) {
      throw new Error("No response available.");
    }
    return new Blob([await this.getBuffer()]);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    if (!this.response) {
      throw new Error("No response available.");
    }
    return this.getBuffer();
  }

  get status(): number {
    if (!this.response) {
      throw new Error("No response available.");
    }
    return this.response.status;
  }

  get ok(): boolean {
    if (!this.response) {
      throw new Error("No response available.");
    }
    return this.response.ok;
  }

  clone(): HTTPObj {
    const cloned = new HTTPRequestImpl(this);
    cloned.response = this.response ? this.response.clone() : undefined;
    return cloned;
  }
}

// Decorator factory for HTTP methods, these methods MUST return an HTTPRequest object
//  The HTTP library will then execute the request and return an HTTPResponse object
function httpDecoratorFactory(options?: {
  // Number of retries allowed for this request
  retries?: number,
  // Optionally override the cache key for this request
  cacheKey?: string,
  // Optional delay in milliseconds before this request can be executed
  delayMs?: number,
  // Cache TTL in seconds (default 60s)
  cacheSeconds?: number,
  // Manual parameter definitions (optional)
  parameters?: HTTPParameterDefinition[],
  // injection options
  injectForRequests?: any, // sift query. When met, this request will be run before the matching method
  // JSON schema to validate response against (optional)
  validateResponse?: any, // JSON schema to validate response against
  // Default arguments for health check testing. Supports template variables:
  // {year} = current year, {month} = current month (1-indexed),
  // {today} = YYYY-MM-DD, {date+N} = YYYY-MM-DD N days from now,
  // {yyyymm} = YYYYMM format for current month
  healthCheckArgs?: any[],
}) {
  // create our validate function if needed
  const formatValidate = options?.validateResponse ? ajv.compile(options.validateResponse) : null;

  return function httpDecorator(
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    // Add to httpRequesters list at decoration time
    // Check if this class/method combination already exists to avoid duplicates
    const existingEntry = httpRequesters.find(
      entry => entry.instance === target.constructor.name && entry.methodName === propertyKey
    );

    if (!existingEntry) {
      // Create the requester entry
      const requester: HTTPRequester = {
        instance: target.constructor.name,
        methodName: propertyKey,
        args: options?.parameters ? [...options.parameters] : [],
        paramCount: descriptor.value?.length ?? 0,
        healthCheckArgs: options?.healthCheckArgs,
      };

      httpRequesters.push(requester);
    }

    const originalMethod = descriptor.value;
    descriptor.value = function (...args: any[]): Promise<HTTPObj> {
      // --- In-flight deduplication ---
      // Build the dedup key synchronously before any async work, then register
      // the promise immediately so subsequent concurrent calls see it and coalesce.
      // This prevents race conditions where concurrent callers (e.g. multiple
      // buildEntityList / buildLiveData calls hitting the same auth token endpoint
      // simultaneously) each fire independent requests.
      const dedupKey = `${getHttpInstanceId(this)}:${propertyKey}:${args.length > 0 ? JSON.stringify(args) : ''}`;
      const existingInflight = httpInflightMap.get(dedupKey);
      if (existingInflight) {
        return existingInflight;
      }

      // Create the outer promise and register it synchronously before any await,
      // so concurrent calls see it immediately.
      const instance = this;
      const outerPromise = (async () => {
        const result = await originalMethod.apply(instance, args);
        if (
          typeof result === 'object' &&
          result !== null &&
          'method' in result &&
          'url' in result
        ) {
          // Create internal implementation with private handlers
          const internalRequest = new HTTPRequestImpl(result);

          // Set class name for cache key uniqueness (prevents conflicts between different classes)
          internalRequest.className = instance.constructor.name;
          // Regenerate cache key now that className is set
          internalRequest.cacheKey = internalRequest.generateCacheKey();

          // Apply decorator options
          if (options?.retries !== undefined) {
            internalRequest.retries = options.retries;
          }

          // Optionally override cache key (include class name to scope it per destination)
          if (options?.cacheKey !== undefined) {
            internalRequest.cacheKey = `${instance.constructor.name}:${options.cacheKey}`;
          }

          // set cache TTL if provided
          if (options?.cacheSeconds !== undefined) {
            internalRequest.cacheTtlSeconds = options.cacheSeconds;
          }

          // Optionally set earliest execute time based on delayMs
          let executeTime = 0;
          if (options?.delayMs !== undefined) {
            const now = Date.now();
            executeTime = now + options.delayMs;
          }

          // Queue HTTP request
          // Get real class name (bypass Proxy wrappers)
          // Try multiple methods to get the actual class name
          let realClassName = (instance as any).__className__ || // Check if we stored it
                             Reflect.get(Reflect.get(instance, 'constructor'), 'name') || // Direct reflection
                             Object.getPrototypeOf(Object.getPrototypeOf(instance)).constructor.name; // Skip one level

          // Route to the owning destination's queue so one park's failures
          // don't block other parks. Fall back to the shared default queue
          // for any consumer that isn't a Destination instance.
          const queue: HttpQueue = (instance as any).httpQueue instanceof HttpQueue
            ? (instance as any).httpQueue
            : defaultHttpQueue;

          queue.push({
            instance: instance,
            methodName: propertyKey,
            args: args,
            request: internalRequest,
            earliestExecute: executeTime > 0 ? executeTime : undefined,
            validateResponse: formatValidate || undefined,
            traceContext: tracing.getContext(), // Capture current trace context
            className: realClassName,
          });

          // Request is now queued for processing

          // Attach response promise to the request entry
          result.response = new Promise<HTTPObj>((resolve, reject) => {
            internalRequest.setPromiseHandlers(resolve, reject);
          });

          return result.response;
        } else {
          throw new Error(
            `${propertyKey} must return an HTTPRequest object with 'method' and 'url' properties.`
          );
        }
      })();

      httpInflightMap.set(dedupKey, outerPromise);

      // Clean up the dedup entry once the promise settles (resolve or reject)
      outerPromise.then(
        () => { httpInflightMap.delete(dedupKey); },
        () => { httpInflightMap.delete(dedupKey); },
      );

      return outerPromise;
    };
  };
}

/**
 * Helper function to broadcast an injection event for a given HTTP request entry.
 * @param entry HTTPRequestEntry
 * @param eventName string Event name to broadcast as (e.g. 'httpRequest')
 */
const broadcastInjectionEvent = async (entry: HTTPRequestEntry, eventName: string) => {
  const urlObj: URL = new URL(entry.request.url);

  // Broadcast to injection system
  await broadcast(entry.instance, {
    // event name
    eventName: eventName,
    // include everything in entry request object (tags, method, etc.)
    method: entry.request.method,
    url: entry.request.url,
    body: entry.request.body,
    tags: entry.request.tags,
    // full URL components for filtering
    protocol: urlObj.protocol,
    host: urlObj.host,
    hostname: urlObj.hostname,
    pathname: urlObj.pathname,
    search: urlObj.search,
    hash: urlObj.hash,
  }, entry.request /* pass request object for potential meddling */);
};


// how long to wait before checking the queue again if it's empty
const emptyQueueDelayMs = 100; // ms
// how long to wait between processing requests
const nextRequestDelayMs = 250; // ms

// Retry configuration with exponential backoff
const INITIAL_RETRY_DELAY_MS = 1000;      // 1 second for first retry
const MAX_RETRY_DELAY_MS = 60000;         // Cap at 60 seconds
const BACKOFF_MULTIPLIER = 2;             // Double delay each retry
const JITTER_FACTOR = 0.1;                // Add ±10% random jitter

/**
 * Calculate exponential backoff delay with jitter
 * @param retryAttempt Current retry attempt number (0 = first retry, 1 = second, etc.)
 * @returns Delay in milliseconds
 */
function calculateBackoffDelay(retryAttempt: number): number {
  // Exponential: delay = initial * (multiplier ^ attempt)
  const exponentialDelay = INITIAL_RETRY_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, retryAttempt);

  // Add jitter: random value between -10% and +10% of delay
  const jitter = exponentialDelay * JITTER_FACTOR * (Math.random() * 2 - 1);
  const jitteredDelay = exponentialDelay + jitter;

  // Cap at max delay after jitter
  return Math.floor(Math.min(jitteredDelay, MAX_RETRY_DELAY_MS));
}
/**
 * Process a single queued request end-to-end: fire the HTTP call, run the
 * injection hooks, optionally validate, and either resolve the caller's
 * promise or push the entry back onto its queue for retry. Extracted from
 * HttpQueue.processOne so the loop body stays readable.
 */
async function fireRequest(
  entry: InternalHTTPRequestEntry,
  requeue: (e: InternalHTTPRequestEntry) => void,
): Promise<void> {
  const requestStartTime = Date.now();

  // Emit trace start event (use captured context if available)
  tracing.emitHttpEvent({
    eventType: 'http.request.start',
    url: entry.request.url,
    method: entry.request.method,
    headers: entry.request.buildHeaders(),
    retryCount: entry.retryAttempt || 0,
    className: entry.className,
    methodName: entry.methodName,
  }, entry.traceContext);

  try {
    // Broadcast to injection system (restore trace context so nested requests inherit it)
    await tracing.runWithContext(entry.traceContext, async () => {
      await broadcastInjectionEvent(entry, 'httpRequest');
    });

    // Hold a global permit only for the network-I/O phase. Releasing before
    // response injection lets nested @http calls from those injectors acquire
    // their own permits without waiting for us to finish.
    await globalHttpLimiter.acquire();
    try {
      await entry.request.makeRequest(entry.traceContext, entry.className, entry.methodName);
    } finally {
      globalHttpLimiter.release();
    }

    // if we have a response validator, run it now
    if (entry.validateResponse && entry.request.response) {
      try {
        const data = await entry.request.clone().json();
        if (!entry.validateResponse(data)) {
          const errors = entry.validateResponse.errors as DefinedError[] | null;
          const errorStr = errors ? errors.map(err => `  ${err.instancePath} ${err.message}`).join('\n') : 'Unknown validation error';
          throw new Error(`Response from ${entry.methodName} does not match the expected format. Errors: \n${errorStr}`);
        }
      } catch (e) {
        throw new Error(`Response from ${entry.methodName} is not valid JSON or does not match the expected format: ${e}`);
      }
    }

    // Broadcast response event BEFORE resolving the caller's promise.
    // Response injectors can throw to trigger a retry — if we resolve first,
    // the caller has already moved on with the unmodified response, and any
    // thrown error from the injector is silently lost.
    await tracing.runWithContext(entry.traceContext, async () => {
      await broadcastInjectionEvent(entry, 'httpResponse');
    });

    // Resolve the original promise (now safe — injectors have all run)
    entry.request.resolvePromise(entry.request);
  } catch (error) {
    // Try to capture error response body if available
    let errorBody: any = undefined;
    if (entry.request.response) {
      try {
        const clonedResponse = entry.request.response.clone();
        const contentType = entry.request.response.headers.get('content-type');

        if (contentType?.includes('application/json')) {
          errorBody = await clonedResponse.json();
        } else {
          const text = await clonedResponse.text();
          errorBody = text.length > 1000 ? text.substring(0, 1000) + '...' : text;
        }
      } catch (bodyError) {
        // Failed to get body, just skip it
      }
    }

    // Emit trace error event (use captured context if available)
    tracing.emitHttpEvent({
      eventType: 'http.request.error',
      url: entry.request.url,
      method: entry.request.method,
      status: entry.request.response?.status,
      duration: Date.now() - requestStartTime,
      error: error instanceof Error ? error : new Error(String(error)),
      headers: entry.request.buildHeaders(),
      body: errorBody,
      retryCount: entry.retryAttempt || 0,
      className: entry.className,
      methodName: entry.methodName,
    }, entry.traceContext);

    // broadcast error event (restore trace context)
    await tracing.runWithContext(entry.traceContext, async () => {
      await broadcastInjectionEvent(entry, 'httpError');
    });

    // Determine if this error is retryable:
    //   - No response at all (network/connection error) → retryable
    //   - 429 Too Many Requests → retryable
    //   - 5xx server error → retryable
    //   - 4xx client error (other than 429) → NOT retryable (definitive failure)
    const responseStatus = entry.request.response?.status;
    const isRetryable = responseStatus === undefined ||
      responseStatus === 429 ||
      (responseStatus >= 500 && responseStatus < 600);

    // allow retries if configured and error is retryable, but push to the back of the queue
    if (isRetryable && entry.request.retries && entry.request.retries > 0) {
      entry.request.retries -= 1;

      // Track retry attempt (initialize if first retry)
      if (entry.retryAttempt === undefined) {
        entry.retryAttempt = 0;
      } else {
        entry.retryAttempt += 1;
      }

      const backoffDelay = calculateBackoffDelay(entry.retryAttempt);

      console.warn(
        `HTTP request failed, retrying in ${Math.round(backoffDelay / 1000)}s ` +
        `(attempt ${entry.retryAttempt + 1}, ${entry.request.retries} retries left): ` +
        `${entry.request.method} ${entry.request.url}`,
        error
      );

      entry.earliestExecute = Date.now() + backoffDelay;
      requeue(entry); // re-queue the request on its own queue
    } else {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (!isRetryable && entry.request.retries && entry.request.retries > 0) {
        // Had retries remaining but error is non-retryable (4xx)
        console.error(
          `HTTP request failed with non-retryable status ${responseStatus}, not retrying: ` +
          `${entry.request.method} ${entry.request.url} ${errMsg}`
        );
      } else {
        console.error(`HTTP request failed, no retries left: ${entry.request.method} ${entry.request.url} ${errMsg}`);
      }
      entry.request.rejectPromise(
        new Error(`${entry.request.method} ${entry.request.url}: ${errMsg}`)
      );
    }
  }
}

/**
 * Process every registered queue. Invoked by the global interval below. Each
 * queue's processOne has its own re-entrancy guard, so overlapping ticks are
 * harmless — a slow queue simply skips this tick.
 */
export async function processHttpQueue(): Promise<void> {
  // Snapshot — processOne() may remove items from activeQueues mid-iteration.
  const queues = [...activeQueues];
  await Promise.all(queues.map((q) => q.processOne().catch(() => {})));
}

/**
 * Get the total number of HTTP requests pending across all destination
 * queues. Used by the test harness to wait for quiescence.
 */
export function getQueueLength(): number {
  let total = 0;
  for (const q of activeQueues) total += q.size();
  return total;
}

/**
 * Get a list of all HTTP methods that have been decorated with @http.
 * This array is populated at decoration time, before any methods are executed.
 * @returns Array of HTTPRequester objects containing class constructor, method name, and placeholder args
 */
export function getHttpRequesters(): HTTPRequester[] {
  return httpRequesters;
}

/**
 * Helper to check if a class name is in the prototype chain
 */
function isInPrototypeChain(childClass: any, parentName: string): boolean {
  let current = childClass;
  while (current) {
    if (current.name === parentName) return true;
    current = Object.getPrototypeOf(current);
  }
  return false;
}

/**
 * Get all HTTP methods for a specific class, including methods from parent classes.
 * @param targetClass The class constructor to search for
 * @returns Array of HTTPRequester objects for the class and its parents
 */
export function getHttpRequestersForClass(targetClass: new (...args: any[]) => any): HTTPRequester[] {
  return httpRequesters.filter(r => isInPrototypeChain(targetClass, r.instance));
}

/**
 * Get a specific HTTP method for a class by name, including parent class methods.
 * @param targetClass The class constructor to search for
 * @param methodName The method name to find
 * @returns HTTPRequester object if found, undefined otherwise
 */
export function getHttpRequesterForClassMethod(
  targetClass: new (...args: any[]) => any,
  methodName: string
): HTTPRequester | undefined {
  return httpRequesters.find(
    r => isInPrototypeChain(targetClass, r.instance) && r.methodName === methodName
  );
}

// Start processing the HTTP queue in the background
let queueInterval: NodeJS.Timeout | null = setInterval(processHttpQueue, 100);

/**
 * Wait for the HTTP queue to be empty.
 * This is useful for testing to ensure all queued requests have completed.
 *
 * @param timeout Maximum time to wait in milliseconds (default: 30000)
 * @param checkInterval How often to check the queue in milliseconds (default: 100)
 * @returns Promise that resolves when queue is empty or rejects on timeout
 */
export function waitForHttpQueue(timeout: number = 30000, checkInterval: number = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const check = () => {
      const pending = getQueueLength();
      if (pending === 0) {
        resolve();
        return;
      }

      if (Date.now() - startTime > timeout) {
        reject(new Error(`Timeout waiting for HTTP queue to empty (${pending} requests remaining)`));
        return;
      }

      setTimeout(check, checkInterval);
    };

    check();
  });
}

/**
 * Stop the HTTP queue processor.
 * This is useful for testing or graceful shutdown.
 * WARNING: After calling this, no HTTP requests will be processed until the process restarts.
 */
export function stopHttpQueue(): void {
  globalStopped = true;
  if (queueInterval) {
    clearInterval(queueInterval);
    queueInterval = null;
    console.log('HTTP queue processor stopped');
  }
}

// HTTP decorator for class methods
export {httpDecoratorFactory as http};
