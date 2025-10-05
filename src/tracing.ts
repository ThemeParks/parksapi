import { AsyncLocalStorage } from 'async_hooks';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

/**
 * Trace context that persists across async boundaries
 */
export interface TraceContext {
  traceId: string;
  startTime: number;
  metadata?: Record<string, any>;
}

/**
 * HTTP request event data
 */
export interface HttpTraceEvent {
  traceId: string;
  eventType: 'http.request.start' | 'http.request.complete' | 'http.request.error';
  timestamp: number;
  url: string;
  method: string;
  status?: number;
  duration?: number;
  error?: Error;
  headers?: Record<string, string>;
  body?: any; // Response body (for complete/error events)
  cacheHit?: boolean;
  retryCount?: number;
  className?: string; // Class name of the decorated method
  methodName?: string; // Decorated method name
}

/**
 * Trace result containing the function result and collected events
 */
export interface TraceResult<T> {
  result: T;
  traceId: string;
  duration: number;
  events: HttpTraceEvent[];
}

/**
 * Stored trace information (without the result)
 */
export interface TraceInfo {
  traceId: string;
  startTime: number;
  endTime: number;
  duration: number;
  events: HttpTraceEvent[];
  metadata?: Record<string, any>;
}

/**
 * Tracing manager using AsyncLocalStorage for context propagation
 */
class TracingManager extends EventEmitter {
  private asyncLocalStorage = new AsyncLocalStorage<TraceContext>();
  private eventBuffers = new Map<string, HttpTraceEvent[]>();
  private traceHistory = new Map<string, TraceInfo>();
  private maxHistorySize = 1000; // Maximum number of traces to keep

  /**
   * Start a new trace context and execute the provided function
   */
  async trace<T>(fn: () => Promise<T>, metadata?: Record<string, any>): Promise<TraceResult<T>> {
    const traceId = randomUUID();
    const startTime = Date.now();
    const context: TraceContext = { traceId, startTime, metadata };

    // Buffer to collect events for this trace
    this.eventBuffers.set(traceId, []);

    try {
      const result = await this.asyncLocalStorage.run(context, fn);
      const endTime = Date.now();
      const duration = endTime - startTime;
      const events = this.eventBuffers.get(traceId) || [];

      // Store trace info in history
      this.storeTraceInfo({
        traceId,
        startTime,
        endTime,
        duration,
        events: [...events], // Clone events array
        metadata,
      });

      return { result, traceId, duration, events };
    } finally {
      // Cleanup buffer after trace completes
      setTimeout(() => this.eventBuffers.delete(traceId), 1000);
    }
  }

  /**
   * Get the current trace context (if any)
   */
  getContext(): TraceContext | undefined {
    return this.asyncLocalStorage.getStore();
  }

  /**
   * Check if currently in a trace context
   */
  isTracing(): boolean {
    return this.asyncLocalStorage.getStore() !== undefined;
  }

  /**
   * Run a function with a specific trace context
   * Useful for restoring context in async boundaries (like queue processors)
   */
  async runWithContext<T>(context: TraceContext | undefined, fn: () => Promise<T>): Promise<T> {
    if (!context) {
      // No context to restore, just run the function
      return fn();
    }
    return this.asyncLocalStorage.run(context, fn);
  }

  /**
   * Emit an HTTP trace event
   */
  emitHttpEvent(event: Omit<HttpTraceEvent, 'traceId' | 'timestamp'>, explicitContext?: TraceContext): void {
    const context = explicitContext || this.getContext();
    if (!context) return;

    const fullEvent: HttpTraceEvent = {
      ...event,
      traceId: context.traceId,
      timestamp: Date.now(),
    };

    // Add to buffer for this trace
    const buffer = this.eventBuffers.get(context.traceId);
    if (buffer) {
      buffer.push(fullEvent);
    }

    // Emit for real-time listeners
    this.emit('http', fullEvent);
    this.emit(fullEvent.eventType, fullEvent);
  }

  /**
   * Listen to HTTP events (all types)
   */
  onHttp(listener: (event: HttpTraceEvent) => void): this {
    return this.on('http', listener);
  }

  /**
   * Listen to specific HTTP event types
   */
  onHttpStart(listener: (event: HttpTraceEvent) => void): this {
    return this.on('http.request.start', listener);
  }

  onHttpComplete(listener: (event: HttpTraceEvent) => void): this {
    return this.on('http.request.complete', listener);
  }

  onHttpError(listener: (event: HttpTraceEvent) => void): this {
    return this.on('http.request.error', listener);
  }

  /**
   * Remove all listeners and clean up
   */
  cleanup(): void {
    this.removeAllListeners();
    this.eventBuffers.clear();
    this.traceHistory.clear();
  }

  /**
   * Store trace information in history with LRU eviction
   */
  private storeTraceInfo(traceInfo: TraceInfo): void {
    // If at capacity, remove oldest trace
    if (this.traceHistory.size >= this.maxHistorySize) {
      const firstKey = this.traceHistory.keys().next().value;
      if (firstKey) {
        this.traceHistory.delete(firstKey);
      }
    }

    this.traceHistory.set(traceInfo.traceId, traceInfo);
  }

  /**
   * Get trace information by trace ID
   * @param traceId The trace ID to look up
   * @returns TraceInfo if found, undefined otherwise
   */
  getTrace(traceId: string): TraceInfo | undefined {
    return this.traceHistory.get(traceId);
  }

  /**
   * Get all events for a specific trace
   * @param traceId The trace ID to look up
   * @returns Array of HTTP events, or empty array if not found
   */
  getTraceEvents(traceId: string): HttpTraceEvent[] {
    const trace = this.traceHistory.get(traceId);
    return trace ? trace.events : [];
  }

  /**
   * Get all stored trace IDs
   * @returns Array of all trace IDs in history
   */
  getAllTraceIds(): string[] {
    return Array.from(this.traceHistory.keys());
  }

  /**
   * Get all stored traces
   * @returns Array of all TraceInfo objects
   */
  getAllTraces(): TraceInfo[] {
    return Array.from(this.traceHistory.values());
  }

  /**
   * Get traces within a time range
   * @param startTime Start timestamp (inclusive)
   * @param endTime End timestamp (inclusive)
   * @returns Array of traces within the time range
   */
  getTracesByTimeRange(startTime: number, endTime: number): TraceInfo[] {
    return Array.from(this.traceHistory.values()).filter(
      trace => trace.startTime >= startTime && trace.endTime <= endTime
    );
  }

  /**
   * Get traces with specific metadata
   * @param metadata Metadata key-value pairs to match
   * @returns Array of traces with matching metadata
   */
  getTracesByMetadata(metadata: Record<string, any>): TraceInfo[] {
    return Array.from(this.traceHistory.values()).filter(trace => {
      if (!trace.metadata) return false;
      return Object.entries(metadata).every(
        ([key, value]) => trace.metadata?.[key] === value
      );
    });
  }

  /**
   * Clear trace history
   */
  clearHistory(): void {
    this.traceHistory.clear();
  }

  /**
   * Set maximum history size
   * @param size Maximum number of traces to keep in history
   */
  setMaxHistorySize(size: number): void {
    this.maxHistorySize = size;

    // Trim history if current size exceeds new max
    while (this.traceHistory.size > this.maxHistorySize) {
      const firstKey = this.traceHistory.keys().next().value;
      if (firstKey) {
        this.traceHistory.delete(firstKey);
      }
    }
  }

  /**
   * Get current history size
   */
  getHistorySize(): number {
    return this.traceHistory.size;
  }
}

// Singleton instance
export const tracing = new TracingManager();

/**
 * Decorator to automatically trace Destination method calls
 */
export function trace(metadata?: Record<string, any>) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      // If already tracing, don't create nested trace
      if (tracing.isTracing()) {
        return originalMethod.apply(this, args);
      }

      // Start new trace
      const result = await tracing.trace(
        () => originalMethod.apply(this, args),
        { method: propertyKey, ...metadata }
      );

      return result.result;
    };

    return descriptor;
  };
}
