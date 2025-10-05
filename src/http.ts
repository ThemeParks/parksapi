// HTTP library with decorator support for HTTP methods
//  Methods decorated with @http must return an HTTPRequest object
//  The HTTP library will then execute the request and return an HTTPResponse object

import {createHash} from "crypto";
import {CacheLib} from "./cache";
import {broadcast} from "./injector";
import {tracing} from "./tracing";
import Ajv, {DefinedError} from "ajv";
const ajv = new Ajv();

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
};
const httpRequesters: HTTPRequester[] = [];


// Options for HTTP requests
export type HTTPOptions = {
  json?: boolean; // shortcut to set Content-Type: application/json and stringify body
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
const httpRequestQueue: InternalHTTPRequestEntry[] = [];

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

  // Private promise handlers
  private _resolve?: (value: HTTPObj) => void;
  private _reject?: (reason?: any) => void;

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
    // hash result - include class name to prevent conflicts between different destination classes
    const inStr = `${classPrefix}${this.method}:${url}:${JSON.stringify(headers)}:${bodyString}`;
    return inStr; //createHash('sha256').update(inStr).digest('hex');
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
          console.log("Using cached response for", this.method, this.url);
          this.response = new Response(cachedValue);

          // Try to parse body for trace (but don't fail if we can't)
          let responseBody: any = undefined;
          try {
            responseBody = JSON.parse(cachedValue);
          } catch {
            responseBody = cachedValue.substring(0, 1000); // First 1000 chars if not JSON
          }

          // Emit trace event for cache hit (use provided context if available)
          tracing.emitHttpEvent({
            eventType: 'http.request.complete',
            url: this.url,
            method: this.method,
            status: 200,
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

    // use fetch to make the HTTP request
    const fetchOptions: RequestInit = {
      method: this.method,
      headers: this.buildHeaders(),
    };

    // handle body, if set
    if (this.body) {
      fetchOptions.body = this.options?.json ? JSON.stringify(this.body) : this.body;
    }

    // actually perform the fetch
    const urlToFetch = this.buildUrl();
    const response = await fetch(urlToFetch, fetchOptions);
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
      throw new Error(`HTTP request not OK: ${response.status} ${response.statusText}`);
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

  // Passthrough common response methods
  async json(): Promise<any> {
    if (!this.response) {
      throw new Error("No response available.");
    }
    return this.response.json();
  }

  async text(): Promise<string> {
    if (!this.response) {
      throw new Error("No response available.");
    }
    return this.response.text();
  }

  async blob(): Promise<Blob> {
    if (!this.response) {
      throw new Error("No response available.");
    }
    return this.response.blob();
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    if (!this.response) {
      throw new Error("No response available.");
    }
    return this.response.arrayBuffer();
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
        args: options?.parameters ? [...options.parameters] : []
      };

      httpRequesters.push(requester);
    }

    const originalMethod = descriptor.value;
    descriptor.value = async function (...args: any[]): Promise<HTTPObj> {
      const result = await originalMethod.apply(this, args);
      if (
        typeof result === 'object' &&
        result !== null &&
        'method' in result &&
        'url' in result
      ) {
        // Create internal implementation with private handlers
        const internalRequest = new HTTPRequestImpl(result);

        // Set class name for cache key uniqueness (prevents conflicts between different classes)
        internalRequest.className = this.constructor.name;
        // Regenerate cache key now that className is set
        internalRequest.cacheKey = internalRequest.generateCacheKey();

        // Apply decorator options
        if (options?.retries !== undefined) {
          internalRequest.retries = options.retries;
        }

        // Optionally override cache key
        if (options?.cacheKey !== undefined) {
          // Include class name in manual cache key override too
          //internalRequest.cacheKey = createHash('sha256').update(`${this.constructor.name}:${options.cacheKey}`).digest('hex');
          internalRequest.cacheKey = `${this.constructor.name}:${options.cacheKey}`;
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
        let realClassName = (this as any).__className__ || // Check if we stored it
                           Reflect.get(Reflect.get(this, 'constructor'), 'name') || // Direct reflection
                           Object.getPrototypeOf(Object.getPrototypeOf(this)).constructor.name; // Skip one level

        httpRequestQueue.push({
          instance: this,
          methodName: propertyKey,
          args: args,
          request: internalRequest,
          earliestExecute: executeTime > 0 ? executeTime : undefined,
          validateResponse: formatValidate || undefined,
          traceContext: tracing.getContext(), // Capture current trace context
          className: realClassName,
        });

        // sort queue by earliestExecute time
        httpRequestQueue.sort((a, b) => {
          const aTime = a.earliestExecute || 0;
          const bTime = b.earliestExecute || 0;
          return aTime - bTime;
        });

        // Broadcast HTTP event for logging/debugging
        console.log(`HTTP Request queued: ${result.method} ${result.url} (method: ${propertyKey})`);

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
// Process queued HTTP requests (stub implementation)
export async function processHttpQueue() {
  while (httpRequestQueue.length > 0) {
    // peek at the first request in the queue
    const now = Date.now();
    const firstEntry = httpRequestQueue[0];
    if (firstEntry.earliestExecute && firstEntry.earliestExecute > now) {
      // not yet time to execute this request
      // wait a bit before checking again
      await new Promise((resolve) => setTimeout(resolve, emptyQueueDelayMs));
      continue;
    }

    // get the next request in the queue
    const entry = httpRequestQueue.shift();
    if (entry) {
      console.log(`Processing HTTP request: ${entry.request.method} ${entry.request.url}`);

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

        // make the actual HTTP request (pass trace context, className, methodName)
        await entry.request.makeRequest(entry.traceContext, entry.className, entry.methodName);

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

        // resolve the original promise
        entry.request.resolvePromise(entry.request);
        console.log(`HTTP request completed: ${entry.request.method} ${entry.request.url}`);

        // broadcast response event (restore trace context)
        //  Note: opportunity here for the injection to throw an error to force a retry if needed
        await tracing.runWithContext(entry.traceContext, async () => {
          await broadcastInjectionEvent(entry, 'httpResponse');
        });
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

        // allow retries if configured, but push to the back of the queue
        if (entry.request.retries && entry.request.retries > 0) {
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
          httpRequestQueue.push(entry); // re-queue the request
        } else {
          console.error(`HTTP request failed, no retries left: ${entry.request.method} ${entry.request.url}`, error);
          entry.request.rejectPromise(error);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, nextRequestDelayMs)); // Simple rate limiting
    } else {
      // queue is empty, wait a bit before checking again
      await new Promise((resolve) => setTimeout(resolve, emptyQueueDelayMs));
    }
  }
}

/**
 * Get the current length of the HTTP request queue.
 * @returns Number of HTTP requests currently in the queue
 */
export function getQueueLength(): number {
  return httpRequestQueue.length;
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
 * Stop the HTTP queue processor.
 * This is useful for testing or graceful shutdown.
 * WARNING: After calling this, no HTTP requests will be processed until the process restarts.
 */
export function stopHttpQueue(): void {
  if (queueInterval) {
    clearInterval(queueInterval);
    queueInterval = null;
    console.log('HTTP queue processor stopped');
  }
}

// HTTP decorator for class methods
export {httpDecoratorFactory as http};
