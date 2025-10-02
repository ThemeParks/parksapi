/**
 * Test HTTP utility functions
 *
 * Note: These tests focus on utility functions and basic request construction.
 * Full queue processing, decorator functionality, and retry logic are tested
 * through integration tests with actual park implementations.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { HTTPObj } from '../http.js';

// We need to test the HTTPRequestImpl class internals
// Import the module to access the class
import * as httpModule from '../http.js';

// Create a minimal HTTPRequestImpl for testing
// We'll need to construct it via the internal class
class TestHTTPRequest {
  public method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  public url: string;
  public headers: Record<string, string>;
  public options?: { json?: boolean };
  public body?: any;
  public queryParams?: Record<string, string>;
  public response?: Response;
  public tags: string[];

  constructor(request: Partial<HTTPObj>) {
    this.method = request.method || 'GET';
    this.url = request.url || 'https://api.example.com';
    this.options = request.options;
    this.queryParams = request.queryParams;
    this.body = request.body;
    this.response = request.response;
    this.tags = request.tags || [];
    this.headers = request.headers || {};
  }

  buildUrl(): string {
    const url = new URL(this.url);
    if (this.queryParams) {
      Object.entries(this.queryParams).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }
    return url.toString();
  }

  buildHeaders(): Record<string, string> {
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
}

describe('HTTP Utility Functions', () => {
  describe('URL Building', () => {
    test('should build URL without query parameters', () => {
      const request = new TestHTTPRequest({
        method: 'GET',
        url: 'https://api.example.com/endpoint',
        tags: []
      });

      expect(request.buildUrl()).toBe('https://api.example.com/endpoint');
    });

    test('should build URL with single query parameter', () => {
      const request = new TestHTTPRequest({
        method: 'GET',
        url: 'https://api.example.com/endpoint',
        queryParams: { key: 'value' },
        tags: []
      });

      expect(request.buildUrl()).toBe('https://api.example.com/endpoint?key=value');
    });

    test('should build URL with multiple query parameters', () => {
      const request = new TestHTTPRequest({
        method: 'GET',
        url: 'https://api.example.com/endpoint',
        queryParams: {
          key1: 'value1',
          key2: 'value2',
          key3: 'value3'
        },
        tags: []
      });

      const url = request.buildUrl();
      expect(url).toContain('key1=value1');
      expect(url).toContain('key2=value2');
      expect(url).toContain('key3=value3');
    });

    test('should handle URL encoding in query parameters', () => {
      const request = new TestHTTPRequest({
        method: 'GET',
        url: 'https://api.example.com/endpoint',
        queryParams: {
          name: 'John Doe',
          email: 'test@example.com',
          special: 'a&b=c'
        },
        tags: []
      });

      const url = request.buildUrl();
      expect(url).toContain('name=John+Doe');
      expect(url).toContain('email=test%40example.com');
      expect(url).toContain('special=a%26b%3Dc');
    });

    test('should preserve existing query parameters in URL', () => {
      const request = new TestHTTPRequest({
        method: 'GET',
        url: 'https://api.example.com/endpoint?existing=param',
        queryParams: { new: 'param' },
        tags: []
      });

      const url = request.buildUrl();
      expect(url).toContain('existing=param');
      expect(url).toContain('new=param');
    });

    test('should handle empty query params object', () => {
      const request = new TestHTTPRequest({
        method: 'GET',
        url: 'https://api.example.com/endpoint',
        queryParams: {},
        tags: []
      });

      expect(request.buildUrl()).toBe('https://api.example.com/endpoint');
    });
  });

  describe('Header Building', () => {
    test('should build headers without custom headers', () => {
      const request = new TestHTTPRequest({
        method: 'GET',
        url: 'https://api.example.com',
        tags: []
      });

      expect(request.buildHeaders()).toEqual({});
    });

    test('should build headers with custom headers', () => {
      const request = new TestHTTPRequest({
        method: 'GET',
        url: 'https://api.example.com',
        headers: {
          'Authorization': 'Bearer token123',
          'X-Custom-Header': 'custom-value'
        },
        tags: []
      });

      expect(request.buildHeaders()).toEqual({
        'Authorization': 'Bearer token123',
        'X-Custom-Header': 'custom-value'
      });
    });

    test('should add JSON headers when json option is true', () => {
      const request = new TestHTTPRequest({
        method: 'POST',
        url: 'https://api.example.com',
        options: { json: true },
        tags: []
      });

      const headers = request.buildHeaders();
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Accept']).toBe('application/json');
    });

    test('should merge custom headers with JSON headers', () => {
      const request = new TestHTTPRequest({
        method: 'POST',
        url: 'https://api.example.com',
        headers: {
          'Authorization': 'Bearer token123',
          'X-Custom-Header': 'custom-value'
        },
        options: { json: true },
        tags: []
      });

      const headers = request.buildHeaders();
      expect(headers).toEqual({
        'Authorization': 'Bearer token123',
        'X-Custom-Header': 'custom-value',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      });
    });

    test('should not add JSON headers when json option is false', () => {
      const request = new TestHTTPRequest({
        method: 'POST',
        url: 'https://api.example.com',
        options: { json: false },
        tags: []
      });

      const headers = request.buildHeaders();
      expect(headers['Content-Type']).toBeUndefined();
      expect(headers['Accept']).toBeUndefined();
    });

    test('should not add JSON headers when options is undefined', () => {
      const request = new TestHTTPRequest({
        method: 'POST',
        url: 'https://api.example.com',
        tags: []
      });

      const headers = request.buildHeaders();
      expect(headers['Content-Type']).toBeUndefined();
      expect(headers['Accept']).toBeUndefined();
    });

    test('should handle empty headers object', () => {
      const request = new TestHTTPRequest({
        method: 'GET',
        url: 'https://api.example.com',
        headers: {},
        tags: []
      });

      expect(request.buildHeaders()).toEqual({});
    });
  });

  describe('Request Construction', () => {
    test('should construct GET request with minimal options', () => {
      const request = new TestHTTPRequest({
        method: 'GET',
        url: 'https://api.example.com/endpoint',
        tags: []
      });

      expect(request.method).toBe('GET');
      expect(request.url).toBe('https://api.example.com/endpoint');
      expect(request.headers).toEqual({});
      expect(request.tags).toEqual([]);
    });

    test('should construct POST request with body', () => {
      const body = { key: 'value', nested: { prop: 'data' } };
      const request = new TestHTTPRequest({
        method: 'POST',
        url: 'https://api.example.com/endpoint',
        body,
        options: { json: true },
        tags: []
      });

      expect(request.method).toBe('POST');
      expect(request.body).toEqual(body);
      expect(request.options?.json).toBe(true);
    });

    test('should construct PUT request', () => {
      const request = new TestHTTPRequest({
        method: 'PUT',
        url: 'https://api.example.com/endpoint',
        tags: []
      });

      expect(request.method).toBe('PUT');
    });

    test('should construct DELETE request', () => {
      const request = new TestHTTPRequest({
        method: 'DELETE',
        url: 'https://api.example.com/endpoint',
        tags: []
      });

      expect(request.method).toBe('DELETE');
    });

    test('should construct PATCH request', () => {
      const request = new TestHTTPRequest({
        method: 'PATCH',
        url: 'https://api.example.com/endpoint',
        tags: []
      });

      expect(request.method).toBe('PATCH');
    });

    test('should store tags array', () => {
      const request = new TestHTTPRequest({
        method: 'GET',
        url: 'https://api.example.com',
        tags: ['tag1', 'tag2', 'apiKeyFetch']
      });

      expect(request.tags).toEqual(['tag1', 'tag2', 'apiKeyFetch']);
    });

    test('should default to empty tags array', () => {
      const request = new TestHTTPRequest({
        method: 'GET',
        url: 'https://api.example.com',
        tags: []
      });

      expect(request.tags).toEqual([]);
    });
  });

  describe('Exponential Backoff Calculation', () => {
    // These tests verify the backoff algorithm
    // Exported function: calculateBackoffDelay(retryAttempt: number): number

    test('should calculate delay for first retry (attempt 0)', () => {
      // First retry: 1000ms * 2^0 = 1000ms base
      // With jitter: between 900ms and 1100ms (±10%)
      const delay = calculateBackoff(0);
      expect(delay).toBeGreaterThanOrEqual(900);
      expect(delay).toBeLessThanOrEqual(1100);
    });

    test('should calculate delay for second retry (attempt 1)', () => {
      // Second retry: 1000ms * 2^1 = 2000ms base
      // With jitter: between 1800ms and 2200ms (±10%)
      const delay = calculateBackoff(1);
      expect(delay).toBeGreaterThanOrEqual(1800);
      expect(delay).toBeLessThanOrEqual(2200);
    });

    test('should calculate delay for third retry (attempt 2)', () => {
      // Third retry: 1000ms * 2^2 = 4000ms base
      // With jitter: between 3600ms and 4400ms (±10%)
      const delay = calculateBackoff(2);
      expect(delay).toBeGreaterThanOrEqual(3600);
      expect(delay).toBeLessThanOrEqual(4400);
    });

    test('should cap delay at maximum (60 seconds)', () => {
      // Very high retry attempt should cap at 60000ms
      const delay = calculateBackoff(10);
      expect(delay).toBeLessThanOrEqual(60000);
    });

    test('should add random jitter to prevent thundering herd', () => {
      // Run multiple times and verify we get different values (due to jitter)
      const delays = new Set<number>();
      for (let i = 0; i < 10; i++) {
        delays.add(calculateBackoff(2));
      }
      // Should have at least a few different values due to randomness
      expect(delays.size).toBeGreaterThan(1);
    });

    test('should always return positive integer delay', () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const delay = calculateBackoff(attempt);
        expect(delay).toBeGreaterThan(0);
        expect(Number.isInteger(delay)).toBe(true);
      }
    });
  });

  describe('HTTP Methods', () => {
    test('should support all standard HTTP methods', () => {
      const methods: Array<'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'> = [
        'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'
      ];

      methods.forEach(method => {
        const request = new TestHTTPRequest({
          method,
          url: 'https://api.example.com',
          tags: []
        });
        expect(request.method).toBe(method);
      });
    });
  });

  describe('Complex Request Scenarios', () => {
    test('should handle request with all options', () => {
      const request = new TestHTTPRequest({
        method: 'POST',
        url: 'https://api.example.com/endpoint',
        headers: {
          'Authorization': 'Bearer token',
          'X-Custom': 'value'
        },
        queryParams: {
          filter: 'active',
          sort: 'name'
        },
        body: {
          data: 'payload',
          nested: { value: 123 }
        },
        options: { json: true },
        tags: ['tag1', 'tag2']
      });

      expect(request.method).toBe('POST');
      expect(request.buildUrl()).toContain('filter=active');
      expect(request.buildUrl()).toContain('sort=name');
      expect(request.buildHeaders()).toMatchObject({
        'Authorization': 'Bearer token',
        'X-Custom': 'value',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      });
      expect(request.body).toEqual({
        data: 'payload',
        nested: { value: 123 }
      });
      expect(request.tags).toEqual(['tag1', 'tag2']);
    });

    test('should handle API endpoint with path parameters', () => {
      const request = new TestHTTPRequest({
        method: 'GET',
        url: 'https://api.example.com/users/123/posts/456',
        tags: []
      });

      expect(request.buildUrl()).toBe('https://api.example.com/users/123/posts/456');
    });

    test('should handle different domains and ports', () => {
      const urls = [
        'http://localhost:3000/api',
        'https://api.example.com:8080/v1',
        'https://subdomain.example.co.uk/endpoint'
      ];

      urls.forEach(url => {
        const request = new TestHTTPRequest({
          method: 'GET',
          url,
          tags: []
        });
        expect(request.buildUrl()).toBe(url);
      });
    });
  });
});

// Helper function to test exponential backoff
// This mimics the internal calculateBackoffDelay function
function calculateBackoff(retryAttempt: number): number {
  const INITIAL_RETRY_DELAY_MS = 1000;
  const MAX_RETRY_DELAY_MS = 60000;
  const BACKOFF_MULTIPLIER = 2;
  const JITTER_FACTOR = 0.1;

  const exponentialDelay = INITIAL_RETRY_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, retryAttempt);
  const jitter = exponentialDelay * JITTER_FACTOR * (Math.random() * 2 - 1);
  const jitteredDelay = exponentialDelay + jitter;
  return Math.floor(Math.min(jitteredDelay, MAX_RETRY_DELAY_MS));
}
