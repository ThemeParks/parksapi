import { describe, test, expect, vi } from 'vitest';
import { wsMessages } from '../wsUtils.js';
import { EventEmitter } from 'events';

/**
 * Fake WebSocket that extends EventEmitter for testing.
 * Real WebSocket uses 'message', 'close', 'error' events.
 */
class FakeWebSocket extends EventEmitter {
  readyState = 1; // OPEN
  close() {
    this.readyState = 3; // CLOSED
    this.emit('close');
  }
}

describe('wsMessages', () => {
  test('yields messages until close', async () => {
    const ws = new FakeWebSocket();
    const results: string[] = [];

    // Schedule messages then close
    setTimeout(() => ws.emit('message', { data: 'hello' }), 10);
    setTimeout(() => ws.emit('message', { data: 'world' }), 20);
    setTimeout(() => ws.close(), 30);

    for await (const msg of wsMessages(ws as any)) {
      results.push(msg.data);
    }

    expect(results).toEqual(['hello', 'world']);
  });

  test('returns immediately if socket is already closed', async () => {
    const ws = new FakeWebSocket();
    ws.readyState = 3; // CLOSED
    const results: any[] = [];

    for await (const msg of wsMessages(ws as any)) {
      results.push(msg);
    }

    expect(results).toHaveLength(0);
  });

  test('throws on error event after yielding pre-error messages', async () => {
    const ws = new FakeWebSocket();
    const results: string[] = [];
    let caught: Error | null = null;

    setTimeout(() => ws.emit('message', { data: 'before-error' }), 10);
    setTimeout(() => ws.emit('error', new Error('connection lost')), 20);

    try {
      for await (const msg of wsMessages(ws as any)) {
        results.push(msg.data);
      }
    } catch (e) {
      caught = e as Error;
    }

    // Pre-error messages are still delivered
    expect(results).toEqual(['before-error']);
    // The error is then thrown so the consumer can distinguish it from a clean close
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toBe('connection lost');
  });

  test('wraps non-Error error events into an Error', async () => {
    const ws = new FakeWebSocket();
    let caught: Error | null = null;

    setTimeout(() => ws.emit('error', { message: 'browser-style error event' }), 10);

    try {
      for await (const _msg of wsMessages(ws as any)) {
        // never yielded
      }
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toContain('browser-style error event');
  });

  test('cleans up listeners on break', async () => {
    const ws = new FakeWebSocket();

    // Send many messages
    let count = 0;
    const interval = setInterval(() => {
      ws.emit('message', { data: `msg-${count++}` });
    }, 5);

    const results: string[] = [];
    for await (const msg of wsMessages(ws as any)) {
      results.push(msg.data);
      if (results.length === 3) break;
    }

    clearInterval(interval);
    expect(results).toHaveLength(3);
    // Listeners should be cleaned up — no 'message' listeners remain
    expect(ws.listenerCount('message')).toBe(0);
    expect(ws.listenerCount('close')).toBe(0);
    expect(ws.listenerCount('error')).toBe(0);
  });
});
