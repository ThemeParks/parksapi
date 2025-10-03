/**
 * Integration test demonstrating HTTP request tracing with Destination methods
 */

import { Destination } from '../destination';
import config from '../config';
import { http } from '../http';
import { tracing } from '../tracing';
import { LiveData, Entity } from '@themeparks/typelib';
import { stopHttpQueue } from '../http';

// Simple test destination with HTTP requests
@config
class TestDestination extends Destination {
  @config
  baseUrl: string = 'https://jsonplaceholder.typicode.com';

  @http({ cacheSeconds: 60 })
  async fetchUsers(): Promise<any> {
    return {
      method: 'GET' as const,
      url: `${this.baseUrl}/users`,
      tags: ['users'],
    };
  }

  @http({ cacheSeconds: 60 })
  async fetchPosts(): Promise<any> {
    return {
      method: 'GET' as const,
      url: `${this.baseUrl}/posts`,
      tags: ['posts'],
    };
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    // Make HTTP requests
    const usersResp = await this.fetchUsers();
    const postsResp = await this.fetchPosts();

    const users = await usersResp.json();
    const posts = await postsResp.json();

    // Return mock live data
    return users.slice(0, 3).map((user: any) => ({
      entityId: String(user.id),
      status: 'OPERATING' as const,
      lastUpdated: new Date().toISOString(),
    }));
  }

  protected async buildEntityList(): Promise<Entity[]> {
    return [];
  }
}

describe('Tracing Integration', () => {
  let destination: TestDestination;

  beforeAll(() => {
    destination = new TestDestination();
  });

  afterAll(() => {
    stopHttpQueue();
  });

  it('should trace HTTP requests during getLiveData call', async () => {
    const events: any[] = [];
    const listener = (event: any) => events.push(event);

    tracing.onHttp(listener);

    // Use tracing.trace to wrap the call
    const result = await tracing.trace(() => destination.getLiveData());

    // Should have made 2 HTTP requests
    expect(result.events.length).toBeGreaterThanOrEqual(2);

    // Should have both start and complete events
    const startEvents = result.events.filter(e => e.eventType === 'http.request.start');
    const completeEvents = result.events.filter(e => e.eventType === 'http.request.complete');

    expect(startEvents.length).toBeGreaterThanOrEqual(2);
    expect(completeEvents.length).toBeGreaterThanOrEqual(2);

    // Check URLs
    const urls = result.events.map(e => e.url);
    expect(urls.some(u => u.includes('/users'))).toBe(true);
    expect(urls.some(u => u.includes('/posts'))).toBe(true);

    // All events should have the same trace ID
    const traceIds = new Set(result.events.map(e => e.traceId));
    expect(traceIds.size).toBe(1);
    expect(traceIds.has(result.traceId)).toBe(true);

    tracing.removeListener('http', listener);
  }, 30000);

  it('should track request durations and status codes', async () => {
    const result = await tracing.trace(() => destination.getLiveData());

    const completeEvents = result.events.filter(
      e => e.eventType === 'http.request.complete'
    );

    completeEvents.forEach(event => {
      expect(event.duration).toBeGreaterThan(0);
      expect(event.status).toBe(200);
      expect(event.method).toBe('GET');
    });
  }, 30000);

  it('should indicate cache hits on subsequent calls', async () => {
    // First call - should make real requests
    await tracing.trace(() => destination.getLiveData());

    // Second call - should use cache
    const result = await tracing.trace(() => destination.getLiveData());

    const cacheHits = result.events.filter(
      e => e.eventType === 'http.request.complete' && e.cacheHit === true
    );

    // At least some requests should be cache hits
    expect(cacheHits.length).toBeGreaterThan(0);
  }, 30000);

  it('should work with event listeners for real-time monitoring', async () => {
    const requestLog: string[] = [];

    const startListener = (event: any) => {
      requestLog.push(`START: ${event.method} ${event.url}`);
    };

    const completeListener = (event: any) => {
      requestLog.push(
        `COMPLETE: ${event.method} ${event.url} (${event.status}) in ${event.duration}ms`
      );
    };

    tracing.onHttpStart(startListener);
    tracing.onHttpComplete(completeListener);

    await tracing.trace(() => destination.getLiveData());

    expect(requestLog.length).toBeGreaterThan(0);
    expect(requestLog.some(log => log.includes('START:'))).toBe(true);
    expect(requestLog.some(log => log.includes('COMPLETE:'))).toBe(true);

    tracing.removeListener('http.request.start', startListener);
    tracing.removeListener('http.request.complete', completeListener);
  }, 30000);

  it('should return trace summary with duration', async () => {
    const result = await tracing.trace(() => destination.getLiveData());

    expect(result.traceId).toBeDefined();
    expect(result.duration).toBeGreaterThan(0);
    expect(Array.isArray(result.result)).toBe(true);
    expect(Array.isArray(result.events)).toBe(true);
  }, 30000);
});
