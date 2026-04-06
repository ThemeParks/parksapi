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

  test('ends cleanly on error event', async () => {
    const ws = new FakeWebSocket();
    const results: string[] = [];

    setTimeout(() => ws.emit('message', { data: 'before-error' }), 10);
    setTimeout(() => ws.emit('error', new Error('connection lost')), 20);

    for await (const msg of wsMessages(ws as any)) {
      results.push(msg.data);
    }

    expect(results).toEqual(['before-error']);
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
