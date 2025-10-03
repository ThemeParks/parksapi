/**
 * Web Admin UI Server
 * Provides HTTP endpoints for testing the ParksAPI framework
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import {fileURLToPath} from 'url';
import {getAllDestinations, getDestinationById} from './destinationRegistry.js';
import {getHttpRequestersForClass, getHttpRequesterForClassMethod} from './http.js';
import {Destination} from './destination.js';
import {tracing} from './tracing.js';
import type {HttpTraceEvent} from './tracing.js';
import {CacheLib} from './cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8888;

// Middleware
app.use(cors());
app.use(express.json());

/**
 * API: Root endpoint - list available routes
 */
app.get('/api', (req, res) => {
  res.json({
    name: 'ParksAPI Web Admin',
    version: '2.0.0',
    endpoints: {
      'GET /api/destinations': 'List all registered destinations',
      'GET /api/destinations/:id': 'Get destination details',
      'POST /api/destinations/:id/execute/:method': 'Execute main method (getEntities, getLiveData, getSchedules)',
      'POST /api/destinations/:id/http/:method': 'Execute HTTP method with parameters',
      'GET /api/trace/:traceId/events': 'Stream trace events via SSE',
      'GET /api/trace/:traceId': 'Get completed trace information',
      'GET /api/cache': 'List all cache entries with metadata',
      'DELETE /api/cache': 'Clear all cache entries',
      'DELETE /api/cache/:key': 'Delete specific cache entry',
      'POST /api/cache/cleanup': 'Remove expired cache entries',
    },
    documentation: 'See WEB_ADMIN.md for full documentation',
  });
});

/**
 * API: Stream trace events via Server-Sent Events (SSE)
 */
app.get('/api/trace/:traceId/events', (req, res) => {
  const { traceId } = req.params;

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', traceId })}\n\n`);

  // Create event listener for this trace
  const eventListener = (event: HttpTraceEvent) => {
    // Only send events for this trace ID
    if (event.traceId === traceId) {
      res.write(`data: ${JSON.stringify({ type: 'event', event })}\n\n`);
    }
  };

  // Listen to all HTTP events
  tracing.onHttp(eventListener);

  // Also send the trace when it completes
  const checkCompletion = setInterval(() => {
    const trace = tracing.getTrace(traceId);
    if (trace) {
      res.write(`data: ${JSON.stringify({ type: 'complete', trace })}\n\n`);
      cleanup();
    }
  }, 100);

  // Cleanup on client disconnect
  const cleanup = () => {
    clearInterval(checkCompletion);
    tracing.removeListener('http', eventListener);
    res.end();
  };

  req.on('close', cleanup);
});

/**
 * API: Get completed trace information
 */
app.get('/api/trace/:traceId', (req, res) => {
  const { traceId } = req.params;
  const trace = tracing.getTrace(traceId);

  if (!trace) {
    return res.status(404).json({ error: 'Trace not found' });
  }

  res.json(trace);
});

/**
 * API: Get all registered destinations
 */
app.get('/api/destinations', async (req, res) => {
  try {
    const destinations = await getAllDestinations();

    // Return minimal info for listing
    const destinationList = destinations.map(d => ({
      id: d.id,
      name: d.name,
      category: d.category,
    }));

    res.json(destinationList);
  } catch (error) {
    console.error('Error fetching destinations:', error);
    res.status(500).json({error: 'Failed to fetch destinations'});
  }
});

/**
 * API: Get destination details including available methods
 */
app.get('/api/destinations/:id', async (req, res) => {
  try {
    const {id} = req.params;
    const destination = await getDestinationById(id);

    if (!destination) {
      return res.status(404).json({error: 'Destination not found'});
    }

    // Get HTTP methods for this destination class (including parent class methods)
    const httpMethods = getHttpRequestersForClass(destination.DestinationClass)
      .map(r => ({
        name: r.methodName,
        parameters: r.args,
      }));

    res.json({
      id: destination.id,
      name: destination.name,
      category: destination.category,
      mainMethods: [
        {name: 'getEntities', description: 'Get all entities (parks, attractions, etc.)'},
        {name: 'getLiveData', description: 'Get live data (wait times, statuses)'},
        {name: 'getSchedules', description: 'Get schedules (operating hours, show times)'},
      ],
      httpMethods,
    });
  } catch (error) {
    console.error('Error fetching destination details:', error);
    res.status(500).json({error: 'Failed to fetch destination details'});
  }
});

/**
 * API: Execute a main destination method with tracing
 */
app.post('/api/destinations/:id/execute/:method', async (req, res) => {
  try {
    const {id, method} = req.params;
    const {async = false} = req.body; // Allow async execution
    const destination = await getDestinationById(id);

    if (!destination) {
      return res.status(404).json({error: 'Destination not found'});
    }

    // Validate method name
    const allowedMethods = ['getEntities', 'getLiveData', 'getSchedules'];
    if (!allowedMethods.includes(method)) {
      return res.status(400).json({error: 'Invalid method name'});
    }

    // Create instance
    const instance = new destination.DestinationClass();

    if (async) {
      // Generate trace ID and return immediately
      const { randomUUID } = await import('crypto');
      const traceId = randomUUID();

      // Return trace ID immediately
      res.json({
        success: true,
        method,
        traceId,
        status: 'started',
        message: 'Execution started. Connect to /api/trace/:traceId/events for live updates',
      });

      // Execute in background with the pre-generated trace ID
      // Note: We manually create the trace context
      const startTime = Date.now();
      const context = { traceId, startTime, metadata: { destination: id, method } };

      // Store empty buffer for this trace
      (tracing as any).eventBuffers.set(traceId, []);

      try {
        const result = await (tracing as any).asyncLocalStorage.run(context, async () => {
          return await (instance as any)[method]();
        });

        const endTime = Date.now();
        const duration = endTime - startTime;
        const events = (tracing as any).eventBuffers.get(traceId) || [];

        // Store in history
        (tracing as any).storeTraceInfo({
          traceId,
          startTime,
          endTime,
          duration,
          events: [...events],
          metadata: { destination: id, method, result },
        });

        // Cleanup buffer
        setTimeout(() => (tracing as any).eventBuffers.delete(traceId), 1000);
      } catch (error) {
        console.error('Background execution error:', error);
      }
    } else {
      // Synchronous execution with tracing
      const traceResult = await tracing.trace(
        () => (instance as any)[method](),
        {
          destination: id,
          method: method,
          timestamp: new Date().toISOString(),
        }
      );

      res.json({
        success: true,
        method,
        traceId: traceResult.traceId,
        duration: traceResult.duration,
        httpRequests: traceResult.events.length,
        data: traceResult.result,
        count: Array.isArray(traceResult.result) ? traceResult.result.length : undefined,
      });
    }
  } catch (error) {
    console.error('Error executing method:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * API: Execute an HTTP method
 */
app.post('/api/destinations/:id/http/:method', async (req, res) => {
  try {
    const {id, method: methodName} = req.params;
    const {parameters = {}} = req.body;

    const destination = await getDestinationById(id);

    if (!destination) {
      return res.status(404).json({error: 'Destination not found'});
    }

    // Check if method exists (including parent class methods)
    const httpMethod = getHttpRequesterForClassMethod(destination.DestinationClass, methodName);

    if (!httpMethod) {
      return res.status(404).json({error: 'HTTP method not found'});
    }

    // Create instance and call method
    const instance = new destination.DestinationClass();

    // Build arguments array from parameters object
    const args = httpMethod.args.map(arg => parameters[arg.name]);

    // Execute the HTTP method (it returns an HTTPObj promise)
    const httpResponse = await (instance as any)[methodName](...args);

    // Extract response data
    const responseData = {
      status: httpResponse.status,
      ok: httpResponse.ok,
      url: httpResponse.url || (await httpResponse.clone().text()).substring(0, 100),
    };

    // Try to parse as JSON, fallback to text
    let data;
    try {
      data = await httpResponse.json();
    } catch {
      data = await httpResponse.text();
    }

    res.json({
      success: true,
      method: methodName,
      response: responseData,
      data,
    });
  } catch (error) {
    console.error('Error executing HTTP method:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * API: Get all cache entries
 */
app.get('/api/cache', (req, res) => {
  try {
    const entries = CacheLib.getAllEntries();
    const stats = {
      totalEntries: entries.length,
      totalSize: entries.reduce((acc, entry) => acc + entry.size, 0),
      expiredCount: entries.filter(e => e.isExpired).length,
    };

    res.json({
      success: true,
      stats,
      entries: entries.map(entry => ({
        key: entry.key,
        valuePreview: typeof entry.value === 'string'
          ? entry.value.substring(0, 100) + (entry.value.length > 100 ? '...' : '')
          : JSON.stringify(entry.value).substring(0, 100) + '...',
        expiresAt: entry.expiresAt,
        lastAccess: entry.lastAccess,
        size: entry.size,
        isExpired: entry.isExpired,
        ttl: Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000)), // seconds remaining
      })),
    });
  } catch (error) {
    console.error('Error fetching cache entries:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * API: Get specific cache entry with full value
 */
app.get('/api/cache/:key', (req, res) => {
  try {
    const { key } = req.params;
    const entries = CacheLib.getAllEntries();
    const entry = entries.find(e => e.key === key);

    if (!entry) {
      return res.status(404).json({
        success: false,
        error: 'Cache entry not found',
      });
    }

    res.json({
      success: true,
      entry: {
        key: entry.key,
        value: entry.value,
        expiresAt: entry.expiresAt,
        lastAccess: entry.lastAccess,
        size: entry.size,
        isExpired: entry.isExpired,
        ttl: Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000)),
      },
    });
  } catch (error) {
    console.error('Error fetching cache entry:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * API: Clear all cache entries
 */
app.delete('/api/cache', (req, res) => {
  try {
    CacheLib.clear();
    res.json({
      success: true,
      message: 'Cache cleared successfully',
    });
  } catch (error) {
    console.error('Error clearing cache:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * API: Delete specific cache entry
 */
app.delete('/api/cache/:key', (req, res) => {
  try {
    const { key } = req.params;
    CacheLib.delete(key);
    res.json({
      success: true,
      message: `Cache entry '${key}' deleted successfully`,
    });
  } catch (error) {
    console.error('Error deleting cache entry:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * API: Remove expired cache entries
 */
app.post('/api/cache/cleanup', (req, res) => {
  try {
    const removed = CacheLib.cleanupExpired();
    res.json({
      success: true,
      message: `Removed ${removed} expired cache entries`,
      removed,
    });
  } catch (error) {
    console.error('Error cleaning up cache:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Serve static files from the React app in production
if (process.env.NODE_ENV === 'production') {
  const buildPath = path.join(__dirname, '../web-ui/dist');
  app.use(express.static(buildPath));

  // Catch-all route for SPA - must be after API routes
  // Use middleware instead of route to avoid Express 5 path-to-regexp issues
  app.use((req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'));
  });
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 ParksAPI Web Admin running on http://localhost:${PORT}`);
  console.log(`   - API: http://localhost:${PORT}/api`);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`   - UI: Run 'npm run web:dev' for development mode`);
  }
});
