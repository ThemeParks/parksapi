# ParksAPI Web Admin UI

Interactive web interface for testing and exploring the ParksAPI framework.

## Quick Start

### Development Mode (Recommended for Testing)

Start the API server without building:

```bash
npm run web:dev
```

Then in a separate terminal, start the React dev server:

```bash
cd web-ui
npm run dev
```

Access the UI at: **http://localhost:3000**

### Production Mode

Build and run everything:

```bash
npm run web
```

Access the UI at: **http://localhost:8080** (or `PORT` environment variable)

## Features

### 1. **Destination Browser**
- View all registered destinations from the destination registry
- Filter by name, ID, or category
- Click any destination to explore its methods

### 2. **Main Methods Execution**
Execute the core destination methods:
- **getEntities**: Fetch all entities (parks, attractions, shows, etc.)
- **getLiveData**: Get real-time wait times and statuses
- **getSchedules**: View operating hours and show times

Results are displayed as interactive, filterable cards.

### 3. **HTTP Methods Testing**
- View all `@http` decorated methods for a destination
- See parameter definitions (type, description, required/optional)
- Customize parameters using auto-generated forms
- Execute HTTP requests and view responses
- View both raw responses and formatted data

### 4. **Results Viewer**
- **Card View**: Smart detection of data type (entities, live data, schedules)
  - Entity cards show name, type, ID, location, tags
  - Live data cards show status, wait times by queue type
  - Schedule cards show dates, opening/closing times
- **JSON View**: Raw JSON output with syntax highlighting
- **Filter**: Search across all fields (name, ID, wait time, status, etc.)
- **Count Display**: See total results and filtered count

## API Endpoints

The Express server provides these endpoints:

### `GET /api/destinations`
List all registered destinations.

**Response:**
```json
[
  {
    "id": "universalorlando",
    "name": "Universal Orlando",
    "category": "Universal"
  }
]
```

### `GET /api/destinations/:id`
Get destination details including available methods.

**Response:**
```json
{
  "id": "universalorlando",
  "name": "Universal Orlando",
  "category": "Universal",
  "mainMethods": [
    {
      "name": "getEntities",
      "description": "Get all entities..."
    }
  ],
  "httpMethods": [
    {
      "name": "fetchVenues",
      "parameters": [
        {
          "name": "city",
          "type": "string",
          "description": "City code",
          "required": true,
          "example": "orlando"
        }
      ]
    }
  ]
}
```

### `POST /api/destinations/:id/execute/:method`
Execute a main destination method (getEntities, getLiveData, getSchedules).

**Response:**
```json
{
  "success": true,
  "method": "getEntities",
  "data": [...],
  "count": 42
}
```

### `POST /api/destinations/:id/http/:method`
Execute an HTTP method with custom parameters.

**Request:**
```json
{
  "parameters": {
    "city": "orlando",
    "venueId": "12345"
  }
}
```

**Response:**
```json
{
  "success": true,
  "method": "fetchVenues",
  "response": {
    "status": 200,
    "ok": true,
    "url": "https://api.example.com/venues"
  },
  "data": {...}
}
```

## Technology Stack

### Backend
- **Express.js**: API server
- **TypeScript**: Type-safe server code
- **tsx**: Direct TypeScript execution

### Frontend
- **React 19**: UI framework
- **TypeScript**: Type-safe client code
- **Vite**: Development server and bundler
- **Native CSS**: Component styling

## Configuration

### Environment Variables
- `PORT`: Server port (default: 8080)
- `NODE_ENV`: Set to `production` for optimized builds

All other environment variables (API credentials, etc.) are loaded from `.env` file via the `@config` decorator system.

## npm Scripts

| Command | Description |
|---------|-------------|
| `npm run web` | Build and run in production mode |
| `npm run web:dev` | Run server in development mode (no build) |
| `npm run web:build` | Build React UI for production |

From `web-ui/` directory:
| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server (port 3000) |
| `npm run build` | Build production bundle |

## File Structure

```
/src/webServer.ts          - Express API server
/web-ui/
  /src/
    /components/
      DestinationList.tsx   - Browse destinations
      DestinationViewer.tsx - View destination details
      ActionSelector.tsx    - Choose method type
      HttpMethodForm.tsx    - Parameter form for HTTP methods
      ResultsViewer.tsx     - Filterable card/JSON viewer
    App.tsx                 - Main application
    types.ts                - TypeScript definitions
  index.html                - HTML entry point
  vite.config.ts            - Vite configuration
```

## Tips

### Testing New Parks
1. Create your park implementation with `@destinationController` decorator
2. Restart `npm run web:dev`
3. The destination automatically appears in the UI
4. Test each method individually before writing integration tests

### Debugging HTTP Methods
1. Select your destination
2. Switch to "HTTP Methods" tab
3. Choose a method from dropdown
4. Fill in parameters (examples pre-populated)
5. Click "Execute HTTP Request"
6. View response status, headers, and data
7. Toggle between Card/JSON views

### Filtering Results
- Type into filter box to search across ALL fields
- Examples: "OPERATING", "attraction", "20 min", "Universal"
- Filter persists when switching between Card/JSON views
- Case-insensitive search

## Troubleshooting

**UI won't load:**
- Make sure API server is running (`npm run web:dev`)
- Check that React dev server is on port 3000
- Verify no CORS errors in browser console

**Destination not appearing:**
- Ensure `@destinationController` decorator is applied
- Check file is in `src/parks/` directory
- Restart the server to reload destination registry

**HTTP method parameters not showing:**
- Verify `@http` decorator includes `parameters: [...]` option
- Parameter definitions must be HTTPParameterDefinition[] type

**No data in results:**
- Check browser network tab for API errors
- Verify `.env` file has required credentials
- Look for errors in server console output
