/**
 * Example: Using the HTTP Tracing System
 *
 * This example demonstrates how to use the tracing system to track
 * all HTTP requests made during a Destination method call.
 */

import { tracing } from '../tracing';

// Example 1: Basic tracing with result and events
async function example1(destination: any) {
  const result = await tracing.trace(() => destination.getLiveData());

  console.log(`Trace ID: ${result.traceId}`);
  console.log(`Duration: ${result.duration}ms`);
  console.log(`Total HTTP requests: ${result.events.length}`);

  // Print all HTTP events
  result.events.forEach(event => {
    if (event.eventType === 'http.request.complete') {
      console.log(
        `${event.method} ${event.url} - ${event.status} ` +
        `(${event.duration}ms) ${event.cacheHit ? '[CACHED]' : ''}`
      );
    }
  });

  return result.result; // The actual LiveData[]
}

// Example 2: Real-time monitoring with event listeners
function example2(destination: any) {
  // Set up listeners for real-time monitoring
  tracing.onHttpStart(event => {
    console.log(`→ Starting: ${event.method} ${event.url}`);
  });

  tracing.onHttpComplete(event => {
    console.log(
      `✓ Completed: ${event.method} ${event.url} ` +
      `(${event.status}) in ${event.duration}ms`
    );
  });

  tracing.onHttpError(event => {
    console.error(
      `✗ Failed: ${event.method} ${event.url} - ${event.error?.message}`
    );
  });

  // Execute traced operation
  return tracing.trace(() => destination.getLiveData());
}

// Example 3: Filter and analyze specific requests
async function example3(destination: any) {
  const result = await tracing.trace(() => destination.getLiveData());

  // Find slowest requests
  const completeEvents = result.events.filter(
    e => e.eventType === 'http.request.complete'
  );

  const slowest = completeEvents
    .sort((a, b) => (b.duration || 0) - (a.duration || 0))
    .slice(0, 3);

  console.log('Slowest requests:');
  slowest.forEach(event => {
    console.log(`  ${event.url}: ${event.duration}ms`);
  });

  // Count cache hits vs misses
  const cacheHits = completeEvents.filter(e => e.cacheHit).length;
  const cacheMisses = completeEvents.filter(e => !e.cacheHit).length;

  console.log(`\nCache performance:`);
  console.log(`  Hits: ${cacheHits}`);
  console.log(`  Misses: ${cacheMisses}`);
  console.log(`  Hit rate: ${((cacheHits / completeEvents.length) * 100).toFixed(1)}%`);

  return result;
}

// Example 4: Error detection and retry tracking
async function example4(destination: any) {
  const result = await tracing.trace(() => destination.getLiveData());

  // Find requests that failed
  const errors = result.events.filter(e => e.eventType === 'http.request.error');

  if (errors.length > 0) {
    console.error(`\nFound ${errors.length} failed requests:`);
    errors.forEach(event => {
      console.error(
        `  ${event.url}: ${event.error?.message} ` +
        `(retry ${event.retryCount})`
      );
    });
  }

  // Find requests that required retries
  const retried = result.events.filter(
    e => e.eventType === 'http.request.start' && (e.retryCount || 0) > 0
  );

  if (retried.length > 0) {
    console.warn(`\n${retried.length} requests required retries`);
  }

  return result;
}

// Example 5: Performance monitoring and alerting
async function example5(destination: any) {
  const SLOW_THRESHOLD = 1000; // ms

  const result = await tracing.trace(() => destination.getLiveData());

  // Check for slow requests
  const slowRequests = result.events.filter(
    e => e.eventType === 'http.request.complete' &&
         (e.duration || 0) > SLOW_THRESHOLD
  );

  if (slowRequests.length > 0) {
    console.warn(`⚠️  Warning: ${slowRequests.length} slow requests detected`);
    slowRequests.forEach(event => {
      console.warn(`  ${event.url}: ${event.duration}ms`);
    });
  }

  // Check overall duration
  if (result.duration > 5000) {
    console.warn(`⚠️  Warning: Total operation took ${result.duration}ms`);
  }

  return result;
}

// Example 6: Using with different Destination methods
async function example6(destination: any) {
  // Trace getEntities()
  const entitiesTrace = await tracing.trace(() => destination.getEntities());
  console.log(`getEntities: ${entitiesTrace.events.length} HTTP requests`);

  // Trace getLiveData()
  const liveDataTrace = await tracing.trace(() => destination.getLiveData());
  console.log(`getLiveData: ${liveDataTrace.events.length} HTTP requests`);

  // Trace getSchedules()
  const schedulesTrace = await tracing.trace(() => destination.getSchedules());
  console.log(`getSchedules: ${schedulesTrace.events.length} HTTP requests`);

  return {
    entities: entitiesTrace.result,
    liveData: liveDataTrace.result,
    schedules: schedulesTrace.result,
  };
}

// Example 7: Debugging with full event dump
async function example7(destination: any) {
  const result = await tracing.trace(() => destination.getLiveData());

  // Dump all events with full details
  console.log('\nFull trace dump:');
  console.log(JSON.stringify(result, null, 2));

  return result;
}

// Example 8: Using trace ID for later analysis
async function example8(destination: any) {
  // Execute traced operation
  const result = await tracing.trace(() => destination.getLiveData());

  console.log(`Trace completed with ID: ${result.traceId}`);

  // Later, retrieve the trace by ID
  const trace = tracing.getTrace(result.traceId);
  if (trace) {
    console.log(`\nTrace ${trace.traceId}:`);
    console.log(`  Started: ${new Date(trace.startTime).toISOString()}`);
    console.log(`  Ended: ${new Date(trace.endTime).toISOString()}`);
    console.log(`  Duration: ${trace.duration}ms`);
    console.log(`  HTTP Requests: ${trace.events.length}`);
  }

  // Get just the events
  const events = tracing.getTraceEvents(result.traceId);
  console.log(`\nFound ${events.length} events for trace ${result.traceId}`);

  return result;
}

// Example 9: Analyzing multiple traces
async function example9(destination: any) {
  // Execute multiple operations
  await tracing.trace(() => destination.getEntities(), { operation: 'getEntities' });
  await tracing.trace(() => destination.getLiveData(), { operation: 'getLiveData' });
  await tracing.trace(() => destination.getSchedules(), { operation: 'getSchedules' });

  // Analyze all traces
  const allTraces = tracing.getAllTraces();
  console.log(`\nTotal traces in history: ${allTraces.length}`);

  // Find slowest operation
  const slowest = allTraces.reduce((prev, current) =>
    current.duration > prev.duration ? current : prev
  );
  console.log(`Slowest operation: ${slowest.metadata?.operation} (${slowest.duration}ms)`);

  // Calculate average duration
  const avgDuration = allTraces.reduce((sum, t) => sum + t.duration, 0) / allTraces.length;
  console.log(`Average duration: ${avgDuration.toFixed(2)}ms`);
}

// Example 10: Time-based trace analysis
async function example10(destination: any) {
  const sessionStart = Date.now();

  // Simulate multiple operations over time
  await tracing.trace(() => destination.getLiveData());
  await new Promise(resolve => setTimeout(resolve, 100));
  await tracing.trace(() => destination.getLiveData());
  await new Promise(resolve => setTimeout(resolve, 100));
  await tracing.trace(() => destination.getLiveData());

  const sessionEnd = Date.now();

  // Analyze traces from this session
  const sessionTraces = tracing.getTracesByTimeRange(sessionStart, sessionEnd);
  console.log(`\nTraces from this session: ${sessionTraces.length}`);

  // Calculate total HTTP requests in session
  const totalRequests = sessionTraces.reduce((sum, t) => sum + t.events.length, 0);
  console.log(`Total HTTP requests: ${totalRequests}`);
}

// Example 11: Metadata-based filtering and reporting
async function example11(destination: any) {
  // Tag operations with metadata
  await tracing.trace(
    () => destination.getLiveData(),
    { user: 'alice', feature: 'dashboard' }
  );

  await tracing.trace(
    () => destination.getEntities(),
    { user: 'bob', feature: 'admin' }
  );

  await tracing.trace(
    () => destination.getLiveData(),
    { user: 'alice', feature: 'mobile-app' }
  );

  // Find all operations by user
  const aliceTraces = tracing.getTracesByMetadata({ user: 'alice' });
  console.log(`\nAlice's operations: ${aliceTraces.length}`);

  // Find dashboard-specific operations
  const dashboardTraces = tracing.getTracesByMetadata({ feature: 'dashboard' });
  console.log(`Dashboard operations: ${dashboardTraces.length}`);

  // Generate per-user performance report
  const users = new Set(tracing.getAllTraces().map(t => t.metadata?.user).filter(Boolean));
  users.forEach(user => {
    const userTraces = tracing.getTracesByMetadata({ user });
    const avgDuration = userTraces.reduce((sum, t) => sum + t.duration, 0) / userTraces.length;
    console.log(`${user}: ${userTraces.length} ops, avg ${avgDuration.toFixed(2)}ms`);
  });
}

// Example 12: Managing trace history
async function example12(destination: any) {
  // Set a smaller history size for memory-constrained environments
  tracing.setMaxHistorySize(100);

  console.log(`Max history size: 100`);
  console.log(`Current history size: ${tracing.getHistorySize()}`);

  // Execute operations
  for (let i = 0; i < 5; i++) {
    await tracing.trace(() => destination.getLiveData(), { iteration: i });
  }

  console.log(`After 5 operations: ${tracing.getHistorySize()}`);

  // Clear history when done
  tracing.clearHistory();
  console.log(`After clearing: ${tracing.getHistorySize()}`);

  // Reset to default
  tracing.setMaxHistorySize(1000);
}

// Example 13: Correlating traces with external IDs
async function example13(destination: any, requestId: string) {
  // Include external correlation ID in metadata
  const result = await tracing.trace(
    () => destination.getLiveData(),
    { requestId, source: 'api-endpoint' }
  );

  console.log(`Request ${requestId} completed with trace ID: ${result.traceId}`);

  // Later, find trace by request ID
  const traces = tracing.getTracesByMetadata({ requestId });
  if (traces.length > 0) {
    const trace = traces[0];
    console.log(`Found trace for request ${requestId}:`);
    console.log(`  Trace ID: ${trace.traceId}`);
    console.log(`  Duration: ${trace.duration}ms`);
    console.log(`  Events: ${trace.events.length}`);
  }
}

export {
  example1,
  example2,
  example3,
  example4,
  example5,
  example6,
  example7,
  example8,
  example9,
  example10,
  example11,
  example12,
  example13,
};
