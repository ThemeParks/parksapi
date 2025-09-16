// HTTP library with decorator support for HTTP methods
//  Methods decorated with @http must return an HTTPRequest object
//  The HTTP library will then execute the request and return an HTTPResponse object

import {createHash} from "crypto";
import {CacheLib} from "./cache";

export type HTTPOptions = {
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  body?: any;
  json?: boolean; // shortcut to set Content-Type: application/json and stringify body
};

export interface HTTPObj {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  url: string;
  options?: HTTPOptions;
  body?: any;
  response?: Response;

  // functions to get response data
  json(): Promise<any>;
  text(): Promise<string>;
  blob(): Promise<Blob>;
  arrayBuffer(): Promise<ArrayBuffer>;
  status: number;
  ok: boolean;
};

// entry of HTTP requests, store class instance, method name, and request object
type HTTPRequestEntry = {
  instance: any;
  methodName: string;
  args: any[];
  request: HTTPRequestImpl;
  // optional timestamp to indicate when this request can be executed
  //  will remain in the queue until that time
  earliestExecute?: number;
  // cache time in seconds (optional)
  cacheTtlSeconds?: number;
};
const httpRequestQueue: HTTPRequestEntry[] = [];

// Internal class to handle HTTPRequest with private promise handlers
class HTTPRequestImpl implements HTTPObj {
  public method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  public url: string;
  public options?: HTTPOptions;
  public body?: any;
  public response?: Response;
  public retries?: number;
  public cacheKey?: string;
  public cacheTtlSeconds?: number;

  // Private promise handlers
  private _resolve?: (value: HTTPObj) => void;
  private _reject?: (reason?: any) => void;

  constructor(request: HTTPObj) {
    this.method = request.method;
    this.url = request.url;
    this.options = request.options;
    this.body = request.body;
    this.response = request.response;

    // Generate initial cache key by hashing method, URL, headers, and body
    this.cacheKey = this.generateCacheKey();

    this.retries = 0; // default retries to 0
  }

  /**
   * Build the full URL with query parameters
   * @returns {string} Full URL with query parameters
   */
  public buildUrl(): string {
    const url = new URL(this.url);
    if (this.options?.queryParams) {
      Object.entries(this.options.queryParams).forEach(([key, value]) => {
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
    if (this.options?.headers) {
      Object.entries(this.options.headers).forEach(([key, value]) => {
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
   * Generate a cache key for the request, based on method, URL, headers, and body
   * @returns {string} Cache key for the request, based on method, URL, headers, and body
   */
  private generateCacheKey(): string {
    const url = this.buildUrl();
    const headers = this.buildHeaders();
    const bodyString = this.body ? JSON.stringify(this.body) : '';
    // hash result
    const inStr = `${this.method}:${url}:${JSON.stringify(headers)}:${bodyString}`;
    return createHash('sha256').update(inStr).digest('hex');
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
  async makeRequest(): Promise<void> {
    // first, check the cache
    if (this.cacheKey && CacheLib.has(this.cacheKey)) {
      const cachedValue = CacheLib.get(this.cacheKey);
      if (cachedValue) {
        try {
          console.log("Using cached response for", this.method, this.url);
          this.response = new Response(cachedValue);
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
    const response = await fetch(this.buildUrl(), fetchOptions);
    this.response = response;

    // cache the response if response is OK and cacheKey is set
    if (this.cacheKey && response.ok && this.cacheTtlSeconds && this.cacheTtlSeconds > 0) {
      const responseClone = response.clone();
      const responseText = await responseClone.text();
      CacheLib.set(this.cacheKey, responseText, this.cacheTtlSeconds);
    }

    // throw error if response not ok
    if (!response.ok) {
      throw new Error(`HTTP request not OK: ${response.status} ${response.statusText}`);
    }
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
}) {
  return function httpDecorator(
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
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

        // Apply decorator options
        if (options?.retries !== undefined) {
          internalRequest.retries = options.retries;
        }

        // Optionally override cache key
        if (options?.cacheKey !== undefined) {
          internalRequest.cacheKey = createHash('sha256').update(options.cacheKey).digest('hex');
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
        httpRequestQueue.push({
          instance: this,
          methodName: propertyKey,
          args: args,
          request: internalRequest,
          earliestExecute: executeTime > 0 ? executeTime : undefined,
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

// how long to wait before checking the queue again if it's empty
const emptyQueueDelayMs = 100; // ms
// how long to wait between processing requests
const nextRequestDelayMs = 250; // ms

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

      try {
        await entry.request.makeRequest();
        entry.request.resolvePromise(entry.request);
        console.log(`HTTP request completed: ${entry.request.method} ${entry.request.url}`);
      } catch (error) {
        // allow retries if configured, but push to the back of the queue
        if (entry.request.retries && entry.request.retries > 0) {
          entry.request.retries -= 1;
          console.warn(`HTTP request failed, retrying (${entry.request.retries} retries left): ${entry.request.method} ${entry.request.url}`, error);

          // wait 10 seconds before retrying
          // TODO - implement exponential backoff
          entry.earliestExecute = Date.now() + 10000;

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

// Start processing the HTTP queue in the background
setInterval(processHttpQueue, 100);

// HTTP decorator for class methods
export {httpDecoratorFactory as http};
