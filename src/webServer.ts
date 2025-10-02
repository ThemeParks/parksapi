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
    },
    documentation: 'See WEB_ADMIN.md for full documentation',
  });
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
 * API: Execute a main destination method
 */
app.post('/api/destinations/:id/execute/:method', async (req, res) => {
  try {
    const {id, method} = req.params;
    const destination = await getDestinationById(id);

    if (!destination) {
      return res.status(404).json({error: 'Destination not found'});
    }

    // Validate method name
    const allowedMethods = ['getEntities', 'getLiveData', 'getSchedules'];
    if (!allowedMethods.includes(method)) {
      return res.status(400).json({error: 'Invalid method name'});
    }

    // Create instance and execute method
    const instance = new destination.DestinationClass();
    const result = await (instance as any)[method]();

    res.json({
      success: true,
      method,
      data: result,
      count: Array.isArray(result) ? result.length : undefined,
    });
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
