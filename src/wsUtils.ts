/**
 * WebSocket async iterator utility
 *
 * Wraps a WebSocket-like object into an async iterator, yielding each
 * message event and returning when the connection closes or errors.
 *
 * Usage:
 *   for await (const msg of wsMessages(ws)) {
 *     const data = JSON.parse(msg.data);
 *   }
 *   // Connection closed — loop ends
 *
 * Cleanup: listeners are removed in the finally block, which runs
 * on both natural close and on break/return from the consumer.
 */

type WebSocketLike = {
  readyState: number;
  addEventListener?: (event: string, handler: (...args: any[]) => void) => void;
  removeEventListener?: (event: string, handler: (...args: any[]) => void) => void;
  on?: (event: string, handler: (...args: any[]) => void) => void;
  off?: (event: string, handler: (...args: any[]) => void) => void;
};

type MessageEvent = { data: any };

/**
 * Wrap a WebSocket-like object as an async iterable of message events.
 *
 * Supports both browser-style WebSocket (addEventListener/removeEventListener)
 * and Node.js EventEmitter-style (on/off). Returns when the socket closes
 * or emits an error.
 */
export async function* wsMessages(ws: WebSocketLike): AsyncGenerator<MessageEvent> {
  // If already closed, return immediately
  if (ws.readyState === 3 /* CLOSED */ || ws.readyState === 2 /* CLOSING */) {
    return;
  }

  // Determine add/remove listener methods
  const addListener = ws.addEventListener?.bind(ws) ?? ws.on?.bind(ws);
  const removeListener = ws.removeEventListener?.bind(ws) ?? ws.off?.bind(ws);

  if (!addListener || !removeListener) {
    throw new Error('WebSocket must support addEventListener/removeEventListener or on/off');
  }

  // Create a queue of pending messages and a resolver for the next one
  const queue: MessageEvent[] = [];
  let resolve: ((value: MessageEvent | null) => void) | null = null;
  let done = false;

  const onMessage = (event: MessageEvent) => {
    if (resolve) {
      const r = resolve;
      resolve = null;
      r(event);
    } else {
      queue.push(event);
    }
  };

  const onClose = () => {
    done = true;
    if (resolve) {
      const r = resolve;
      resolve = null;
      r(null);
    }
  };

  const onError = () => {
    done = true;
    if (resolve) {
      const r = resolve;
      resolve = null;
      r(null);
    }
  };

  addListener('message', onMessage);
  addListener('close', onClose);
  addListener('error', onError);

  try {
    while (true) {
      // Drain buffered messages first
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }

      // If closed while draining, stop
      if (done) return;

      // Wait for next message or close
      const msg = await new Promise<MessageEvent | null>((r) => {
        resolve = r;
      });

      if (msg === null) return; // closed or errored
      yield msg;
    }
  } finally {
    removeListener('message', onMessage);
    removeListener('close', onClose);
    removeListener('error', onError);
  }
}
