# ParksAPI Web Admin UI

Interactive web interface for testing and exploring the ParksAPI framework.

## Features

- **Destination Discovery**: Browse all registered destinations with filtering
- **Main Methods**: Execute core destination methods (getEntities, getLiveData, getSchedules)
- **HTTP Methods**: Test individual @http decorated methods with customizable parameters
- **Filterable Results**: View results as interactive cards with search/filter capabilities
- **JSON Viewer**: Switch between card view and raw JSON for detailed inspection

## Development

Start the development server with hot reload:

```bash
npm run dev
```

The Vite dev server will run on http://localhost:3000 and proxy API requests to http://localhost:8080.

## Building

Build the production bundle:

```bash
npm run build
```

Output will be in `dist/` directory.

## Architecture

- **React 19** with TypeScript
- **Vite** for development and bundling
- **CSS Modules** for component styling
- **Express API** backend (proxied in dev mode)
