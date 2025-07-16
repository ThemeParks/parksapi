#!/usr/bin/env node

/**
 * Entity Map Generator
 * 
 * This script reads entity data from testout_Entities.json and generates
 * an interactive HTML map viewer to visualize all entity locations.
 * 
 * Usage:
 *   node generate-entity-map.js [input-file] [output-file]
 * 
 * Examples:
 *   node generate-entity-map.js
 *   node generate-entity-map.js testout_Entities.json
 *   node generate-entity-map.js testout_Entities.json my-map.html
 */

import {promises as fs} from 'fs';
import path from 'path';

const __dirname = path.dirname(process.argv[1]);

// Default file paths
const DEFAULT_INPUT_FILE = 'testout_Entities.json';
const DEFAULT_OUTPUT_FILE = 'entity-map-viewer.html';

// Get command line arguments
const inputFile = process.argv[2] || DEFAULT_INPUT_FILE;
const outputFile = process.argv[3] || DEFAULT_OUTPUT_FILE;

const logSuccess = (...msg) => {
  console.log(`\x1b[32m✓\x1b[0m`, ...msg);
};

const logError = (...msg) => {
  console.log(`\x1b[31m✗\x1b[0m`, ...msg);
};

const logInfo = (...msg) => {
  console.log(`\x1b[34mℹ\x1b[0m`, ...msg);
};

async function readEntityData(filePath) {
  try {
    const absolutePath = path.resolve(__dirname, filePath);
    const data = await fs.readFile(absolutePath, 'utf8');
    const entities = JSON.parse(data);

    if (!Array.isArray(entities)) {
      throw new Error('Entity data must be an array');
    }

    return entities;
  } catch (error) {
    throw new Error(`Failed to read entity data from ${filePath}: ${error.message}`);
  }
}

function validateEntityData(entities) {
  const validEntities = [];
  const invalidEntities = [];

  entities.forEach((entity, index) => {
    if (!entity._id) {
      invalidEntities.push({index, entity, reason: 'Missing _id'});
      return;
    }

    if (!entity.name) {
      invalidEntities.push({index, entity, reason: 'Missing name'});
      return;
    }

    if (!entity.entityType) {
      invalidEntities.push({index, entity, reason: 'Missing entityType'});
      return;
    }

    if (!entity.location || typeof entity.location.latitude !== 'number' || typeof entity.location.longitude !== 'number') {
      invalidEntities.push({index, entity, reason: 'Invalid or missing location coordinates'});
      return;
    }

    validEntities.push(entity);
  });

  return {validEntities, invalidEntities};
}

function generateMapHTML(entities, sourceFile) {
  const entityStats = entities.reduce((acc, entity) => {
    acc[entity.entityType] = (acc[entity.entityType] || 0) + 1;
    acc.total++;
    return acc;
  }, {total: 0});

  const destinations = [...new Set(entities.map(e => e._destinationId || e._id).filter(Boolean))];
  const parks = [...new Set(entities.map(e => e._parkId).filter(Boolean))];

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Parks API Entity Map Viewer</title>
    
    <!-- Leaflet CSS -->
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
          integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
          crossorigin=""/>
    
    <!-- Leaflet Markercluster CSS -->
    <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.4.1/dist/MarkerCluster.css" />
    <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.4.1/dist/MarkerCluster.Default.css" />
    
    <style>
        body {
            margin: 0;
            padding: 0;
            font-family: Arial, sans-serif;
            background-color: #f5f5f5;
        }
        
        .header {
            background-color: #2c3e50;
            color: white;
            padding: 15px 20px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        }
        
        .header h1 {
            margin: 0;
            font-size: 24px;
        }
        
        .header .subtitle {
            margin: 5px 0 0 0;
            font-size: 14px;
            opacity: 0.8;
        }
        
        .header .source-info {
            margin: 5px 0 0 0;
            font-size: 12px;
            opacity: 0.7;
            font-family: monospace;
        }
        
        .controls {
            background: white;
            padding: 15px 20px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
            display: flex;
            flex-wrap: wrap;
            gap: 20px;
            align-items: center;
        }
        
        .legend {
            display: flex;
            gap: 15px;
            flex-wrap: wrap;
        }
        
        .legend-item {
            display: flex;
            align-items: center;
            gap: 5px;
            font-size: 14px;
        }
        
        .legend-color {
            width: 16px;
            height: 16px;
            border-radius: 50%;
            border: 2px solid #333;
        }
        
        .stats {
            margin-left: auto;
            font-size: 14px;
            color: #666;
        }
        
        .search-container {
            display: flex;
            gap: 10px;
            align-items: center;
        }
        
        .search-input {
            padding: 8px 12px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 14px;
            width: 200px;
        }
        
        .filter-select {
            padding: 8px 12px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 14px;
        }
        
        .action-buttons {
            display: flex;
            gap: 10px;
        }
        
        .action-button {
            padding: 8px 12px;
            border: 1px solid #3498db;
            background: white;
            color: #3498db;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            text-decoration: none;
        }
        
        .action-button:hover {
            background: #3498db;
            color: white;
        }
        
        #map {
            height: calc(100vh - 160px);
            width: 100%;
        }
        
        .custom-popup {
            font-family: Arial, sans-serif;
        }
        
        .custom-popup h3 {
            margin: 0 0 10px 0;
            color: #2c3e50;
            font-size: 16px;
        }
        
        .custom-popup .entity-type {
            background: #3498db;
            color: white;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 12px;
            display: inline-block;
            margin-bottom: 8px;
        }
        
        .custom-popup .entity-type.ATTRACTION { background: #3498db; }
        .custom-popup .entity-type.RESTAURANT { background: #e74c3c; }
        .custom-popup .entity-type.SHOW { background: #27ae60; }
        .custom-popup .entity-type.PARK { background: #8e44ad; }
        .custom-popup .entity-type.DESTINATION { background: #8e44ad; }
        
        .custom-popup .details {
            font-size: 13px;
            line-height: 1.4;
        }
        
        .custom-popup .coordinates {
            font-family: monospace;
            background: #f8f9fa;
            padding: 4px 6px;
            border-radius: 3px;
            font-size: 11px;
            margin-top: 5px;
        }
        
        .info-panel {
            position: absolute;
            top: 10px;
            right: 10px;
            background: white;
            padding: 15px;
            border-radius: 5px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            max-width: 300px;
            font-size: 13px;
            z-index: 1000;
            display: none;
        }
        
        .info-panel h4 {
            margin: 0 0 10px 0;
            color: #2c3e50;
        }
        
        @media (max-width: 768px) {
            .controls {
                flex-direction: column;
                align-items: stretch;
            }
            
            .legend {
                justify-content: center;
            }
            
            .stats {
                margin-left: 0;
                text-align: center;
            }
            
            .search-container {
                justify-content: center;
            }
            
            .info-panel {
                position: relative;
                top: auto;
                right: auto;
                margin: 10px;
            }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Parks API Entity Map Viewer</h1>
        <div class="subtitle">Interactive visualization of theme park entities and their locations</div>
        <div class="source-info">Generated from: ${sourceFile} • ${new Date().toLocaleString()}</div>
    </div>
    
    <div class="controls">
        <div class="legend">
            <div class="legend-item">
                <div class="legend-color" style="background-color: #3498db;"></div>
                <span>Attractions (${entityStats.ATTRACTION || 0})</span>
            </div>
            <div class="legend-item">
                <div class="legend-color" style="background-color: #e74c3c;"></div>
                <span>Restaurants (${entityStats.RESTAURANT || 0})</span>
            </div>
            <div class="legend-item">
                <div class="legend-color" style="background-color: #27ae60;"></div>
                <span>Shows (${entityStats.SHOW || 0})</span>
            </div>
            <div class="legend-item">
                <div class="legend-color" style="background-color: #8e44ad;"></div>
                <span>Parks/Destinations (${(entityStats.PARK || 0) + (entityStats.DESTINATION || 0)})</span>
            </div>
        </div>
        
        <div class="search-container">
            <input type="text" id="searchInput" class="search-input" placeholder="Search entities...">
            <select id="filterSelect" class="filter-select">
                <option value="">All Types</option>
                <option value="ATTRACTION">Attractions</option>
                <option value="RESTAURANT">Restaurants</option>
                <option value="SHOW">Shows</option>
                <option value="PARK">Parks</option>
                <option value="DESTINATION">Destinations</option>
            </select>
        </div>
        
        <div class="action-buttons">
            <button class="action-button" onclick="fitMapToEntities()">Fit All</button>
            <button class="action-button" onclick="toggleInfo()">Info</button>
            <button class="action-button" onclick="exportCoordinates()">Export CSV</button>
        </div>
        
        <div class="stats" id="stats">
            Loading entities...
        </div>
    </div>
    
    <div id="map"></div>
    
    <div class="info-panel" id="infoPanel">
        <h4>Map Information</h4>
        <p><strong>Total Entities:</strong> ${entityStats.total}</p>
        <p><strong>Destinations:</strong> ${destinations.length}</p>
        <p><strong>Parks:</strong> ${parks.length}</p>
        <p><strong>Coordinate Range:</strong></p>
        <ul>
            <li>Lat: ${Math.min(...entities.map(e => e.location.latitude)).toFixed(6)} to ${Math.max(...entities.map(e => e.location.latitude)).toFixed(6)}</li>
            <li>Lng: ${Math.min(...entities.map(e => e.location.longitude)).toFixed(6)} to ${Math.max(...entities.map(e => e.location.longitude)).toFixed(6)}</li>
        </ul>
        <p><strong>Controls:</strong></p>
        <ul>
            <li>Click markers for details</li>
            <li>Use search to find specific entities</li>
            <li>Filter by entity type</li>
            <li>Switch between map layers</li>
        </ul>
    </div>
    
    <!-- Leaflet JavaScript -->
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
            integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
            crossorigin=""></script>
    
    <!-- Leaflet Markercluster JavaScript -->
    <script src="https://unpkg.com/leaflet.markercluster@1.4.1/dist/leaflet.markercluster.js"></script>
    
    <script>
        // Entity data
        const entityData = ${JSON.stringify(entities, null, 8)};

        // Initialize map
        let map;
        let markersLayer;
        let filteredData = [...entityData];
        
        // Color scheme for different entity types
        const colors = {
            'ATTRACTION': '#3498db',
            'RESTAURANT': '#e74c3c',
            'SHOW': '#27ae60',
            'PARK': '#8e44ad',
            'DESTINATION': '#8e44ad'
        };
        
        function initMap() {
            // Calculate center point from all entities
            const validEntities = entityData.filter(e => e.location && e.location.latitude && e.location.longitude);
            const avgLat = validEntities.reduce((sum, e) => sum + e.location.latitude, 0) / validEntities.length;
            const avgLng = validEntities.reduce((sum, e) => sum + e.location.longitude, 0) / validEntities.length;
            
            // Initialize map
            map = L.map('map').setView([avgLat, avgLng], 16);
            
            // Add tile layers
            const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors'
            });
            
            const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                attribution: '© Esri'
            });
            
            // Add default layer
            osmLayer.addTo(map);
            
            // Layer control
            const baseMaps = {
                "Street Map": osmLayer,
                "Satellite": satelliteLayer
            };
            L.control.layers(baseMaps).addTo(map);
            
            // Initialize markers
            markersLayer = L.markerClusterGroup({
                maxClusterRadius: 50,
                spiderfyOnMaxZoom: true,
                showCoverageOnHover: false
            });
            
            updateMap();
            updateStats();
        }
        
        function createMarker(entity) {
            if (!entity.location || !entity.location.latitude || !entity.location.longitude) {
                return null;
            }
            
            const color = colors[entity.entityType] || '#95a5a6';
            
            // Create custom icon
            const icon = L.divIcon({
                className: 'custom-marker',
                html: \`<div style="
                    background-color: \${color};
                    width: 20px;
                    height: 20px;
                    border-radius: 50%;
                    border: 3px solid white;
                    box-shadow: 0 2px 5px rgba(0,0,0,0.3);
                "></div>\`,
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            });
            
            const marker = L.marker([entity.location.latitude, entity.location.longitude], {
                icon: icon
            });
            
            // Create popup content
            const popupContent = \`
                <div class="custom-popup">
                    <h3>\${entity.name}</h3>
                    <div class="entity-type \${entity.entityType}">\${entity.entityType}</div>
                    <div class="details">
                        <strong>ID:</strong> \${entity._id}<br>
                        \${entity.attractionType ? \`<strong>Type:</strong> \${entity.attractionType}<br>\` : ''}
                        \${entity._parkId ? \`<strong>Park ID:</strong> \${entity._parkId}<br>\` : ''}
                        \${entity._destinationId ? \`<strong>Destination:</strong> \${entity._destinationId}<br>\` : ''}
                        \${entity._parentId ? \`<strong>Parent ID:</strong> \${entity._parentId}<br>\` : ''}
                    </div>
                    <div class="coordinates">
                        📍 \${entity.location.latitude.toFixed(6)}, \${entity.location.longitude.toFixed(6)}
                    </div>
                </div>
            \`;
            
            marker.bindPopup(popupContent);
            
            return marker;
        }
        
        function updateMap() {
            // Clear existing markers
            markersLayer.clearLayers();
            
            // Add filtered markers
            filteredData.forEach(entity => {
                const marker = createMarker(entity);
                if (marker) {
                    markersLayer.addLayer(marker);
                }
            });
            
            // Add marker layer to map
            map.addLayer(markersLayer);
        }
        
        function updateStats() {
            const stats = filteredData.reduce((acc, entity) => {
                acc[entity.entityType] = (acc[entity.entityType] || 0) + 1;
                acc.total++;
                return acc;
            }, { total: 0 });
            
            const statsText = \`\${stats.total} entities | \${stats.ATTRACTION || 0} attractions | \${stats.RESTAURANT || 0} restaurants | \${stats.SHOW || 0} shows | \${stats.PARK || 0} parks | \${stats.DESTINATION || 0} destinations\`;
            document.getElementById('stats').textContent = statsText;
        }
        
        function filterData() {
            const searchTerm = document.getElementById('searchInput').value.toLowerCase();
            const typeFilter = document.getElementById('filterSelect').value;
            
            filteredData = entityData.filter(entity => {
                const matchesSearch = !searchTerm || entity.name.toLowerCase().includes(searchTerm);
                const matchesType = !typeFilter || entity.entityType === typeFilter;
                return matchesSearch && matchesType;
            });
            
            updateMap();
            updateStats();
        }
        
        function fitMapToEntities() {
            if (filteredData.length === 0) return;
            
            const validEntities = filteredData.filter(e => e.location && e.location.latitude && e.location.longitude);
            if (validEntities.length === 0) return;
            
            const bounds = L.latLngBounds(validEntities.map(e => [e.location.latitude, e.location.longitude]));
            map.fitBounds(bounds, { padding: [20, 20] });
        }
        
        function toggleInfo() {
            const panel = document.getElementById('infoPanel');
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        }
        
        function exportCoordinates() {
            const csvHeader = 'Name,Type,ID,Latitude,Longitude,ParentID,ParkID,DestinationID\\n';
            const csvData = filteredData.map(entity => {
                return [
                    \`"\${entity.name}"\`,
                    entity.entityType,
                    entity._id,
                    entity.location ? entity.location.latitude : '',
                    entity.location ? entity.location.longitude : '',
                    entity._parentId || '',
                    entity._parkId || '',
                    entity._destinationId || ''
                ].join(',');
            }).join('\\n');
            
            const blob = new Blob([csvHeader + csvData], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'entity-coordinates.csv';
            a.click();
            URL.revokeObjectURL(url);
        }
        
        // Event listeners
        document.getElementById('searchInput').addEventListener('input', filterData);
        document.getElementById('filterSelect').addEventListener('change', filterData);
        
        // Initialize map when page loads
        document.addEventListener('DOMContentLoaded', initMap);
    </script>
</body>
</html>`;
}

async function generateMap() {
  try {
    logInfo(`Reading entity data from: ${inputFile}`);
    const entities = await readEntityData(inputFile);
    logSuccess(`Loaded ${entities.length} entities`);

    logInfo('Validating entity data...');
    const {validEntities, invalidEntities} = validateEntityData(entities);

    if (invalidEntities.length > 0) {
      logError(`Found ${invalidEntities.length} invalid entities:`);
      invalidEntities.forEach(({index, entity, reason}) => {
        console.log(`  [${index}] ${entity.name || entity._id || 'Unknown'}: ${reason}`);
      });
    }

    logSuccess(`${validEntities.length} valid entities found`);

    if (validEntities.length === 0) {
      throw new Error('No valid entities with coordinates found');
    }

    // Generate entity statistics
    const entityStats = validEntities.reduce((acc, entity) => {
      acc[entity.entityType] = (acc[entity.entityType] || 0) + 1;
      return acc;
    }, {});

    logInfo('Entity breakdown:');
    Object.entries(entityStats).forEach(([type, count]) => {
      console.log(`  ${type}: ${count}`);
    });

    logInfo('Generating HTML map...');
    const htmlContent = generateMapHTML(validEntities, inputFile);

    const outputPath = path.resolve(__dirname, outputFile);
    await fs.writeFile(outputPath, htmlContent, 'utf8');

    logSuccess(`Map generated successfully: ${outputFile}`);
    logInfo(`Open the file in your browser to view the interactive map`);

    // Calculate coordinate bounds
    const lats = validEntities.map(e => e.location.latitude);
    const lngs = validEntities.map(e => e.location.longitude);
    const bounds = {
      minLat: Math.min(...lats).toFixed(6),
      maxLat: Math.max(...lats).toFixed(6),
      minLng: Math.min(...lngs).toFixed(6),
      maxLng: Math.max(...lngs).toFixed(6)
    };

    logInfo(`Coordinate bounds: (${bounds.minLat}, ${bounds.minLng}) to (${bounds.maxLat}, ${bounds.maxLng})`);

  } catch (error) {
    logError(error.message);
    process.exit(1);
  }
}

// Run the script
//if (import.meta.url === `file://${process.argv[1]}`) {
console.log('🗺️  Parks API Entity Map Generator\n');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node generate-entity-map.js [input-file] [output-file]');
  console.log('');
  console.log('Arguments:');
  console.log('  input-file   JSON file containing entity data (default: testout_Entities.json)');
  console.log('  output-file  Output HTML file name (default: entity-map-viewer.html)');
  console.log('');
  console.log('Examples:');
  console.log('  node generate-entity-map.js');
  console.log('  node generate-entity-map.js my-entities.json');
  console.log('  node generate-entity-map.js my-entities.json my-map.html');
  process.exit(0);
}

generateMap();
//}
