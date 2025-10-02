/**
 * Destination Registry - Decorator-based automatic destination registration
 * Destinations register themselves using the @destinationController decorator
 * Automatically discovers and loads all destination implementations
 */

import {Destination} from './destination.js';
import * as fs from 'fs';
import * as path from 'path';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Convert class name to kebab-case ID
 * UniversalOrlando -> universalorlando
 */
function classNameToId(className: string): string {
  return className
    .replace(/([A-Z])/g, (match) => match.toLowerCase())
    .replace(/\s+/g, '');
}

/**
 * Convert class name to display name
 * UniversalOrlando -> Universal Orlando
 */
function classNameToDisplayName(className: string): string {
  return className
    .replace(/([A-Z])/g, ' $1')
    .trim();
}

export type DestinationRegistryEntry = {
  /** Unique identifier for the destination (derived from class name) */
  id: string;
  /** Display name (derived from class name) */
  name: string;
  /** Destination class constructor */
  DestinationClass: new () => Destination;
  /** Category or categories for grouping */
  category: string | string[];
};

/**
 * Central registry of all destinations (populated by @destinationController decorator)
 */
const DESTINATION_REGISTRY: DestinationRegistryEntry[] = [];

/**
 * Track if destinations have been loaded
 */
let destinationsLoaded = false;

/**
 * Recursively find all TypeScript/JavaScript files in a directory
 */
function findDestinationFiles(dir: string, fileExtension: string = '.js'): string[] {
  const files: string[] = [];

  try {
    const entries = fs.readdirSync(dir, {withFileTypes: true});

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip node_modules, __tests__, and hidden directories
        if (!entry.name.startsWith('.') &&
            !entry.name.startsWith('_') &&
            entry.name !== 'node_modules') {
          files.push(...findDestinationFiles(fullPath, fileExtension));
        }
      } else if (entry.isFile()) {
        // Include TypeScript or JavaScript files (depending on if we're built)
        if (entry.name.endsWith(fileExtension) &&
            !entry.name.endsWith('.d.ts') &&
            !entry.name.endsWith('.test.ts') &&
            !entry.name.endsWith('.test.js')) {
          files.push(fullPath);
        }
      }
    }
  } catch (error) {
    // Silently ignore if directory doesn't exist
  }

  return files;
}

/**
 * Load all destination implementations
 * Imports all TypeScript/JavaScript files from the parks directory
 * This triggers the @destinationController decorators to register destinations
 */
async function loadAllDestinations(): Promise<void> {
  if (destinationsLoaded) return;

  // Determine if we're running from src (TS) or dist (JS)
  const currentDir = __dirname;
  const isBuilt = currentDir.includes('dist');
  const fileExtension = isBuilt ? '.js' : '.ts';

  // Find the parks directory relative to this file
  const parksDir = path.join(__dirname, 'parks');

  if (!fs.existsSync(parksDir)) {
    return;
  }

  // Find all destination files
  const destinationFiles = findDestinationFiles(parksDir, fileExtension);

  // Import all files to trigger decorators
  const importPromises = destinationFiles.map(async (file) => {
    try {
      // Convert absolute path to relative import path
      const relativePath = path.relative(__dirname, file);
      const importPath = './' + relativePath.replace(/\\/g, '/').replace(/\.(ts|js)$/, '.js');

      await import(importPath);
    } catch (error) {
      // Silently ignore import errors
    }
  });

  await Promise.all(importPromises);
  destinationsLoaded = true;
}

/**
 * Ensure destinations are loaded before accessing registry
 */
async function ensureDestinationsLoaded(): Promise<void> {
  if (!destinationsLoaded) {
    await loadAllDestinations();
  }
}

/**
 * Destination controller decorator options
 */
export type DestinationControllerOptions = {
  /** Category or categories for grouping (e.g., 'Universal' or ['Universal', 'Florida']) */
  category: string | string[];
};

/**
 * Destination controller decorator - Automatically registers a destination class
 * ID and name are derived from the class name
 *
 * @example
 * ```typescript
 * @destinationController({ category: 'Universal' })
 * export class UniversalOrlando extends Destination {
 *   // ID: 'universalorlando'
 *   // Name: 'Universal Orlando'
 * }
 *
 * @destinationController({ category: ['Six Flags', 'California'] })
 * export class SixFlagsMagicMountain extends Destination {
 *   // ID: 'sixflagsmagicmountain'
 *   // Name: 'Six Flags Magic Mountain'
 * }
 * ```
 */
export function destinationController(options: DestinationControllerOptions) {
  return function <T extends new (...args: any[]) => Destination>(target: T) {
    const className = target.name;
    const id = classNameToId(className);
    const name = classNameToDisplayName(className);

    // Register the destination in the global registry
    DESTINATION_REGISTRY.push({
      id,
      name,
      DestinationClass: target as new () => Destination,
      category: options.category,
    });

    // Return the class unchanged
    return target;
  };
}

/**
 * Get all registered destinations
 * Automatically loads destinations on first call
 */
export async function getAllDestinations(): Promise<DestinationRegistryEntry[]> {
  await ensureDestinationsLoaded();
  return [...DESTINATION_REGISTRY]; // Return copy to prevent mutation
}

/**
 * Get destination by ID
 * Automatically loads destinations on first call
 */
export async function getDestinationById(id: string): Promise<DestinationRegistryEntry | undefined> {
  await ensureDestinationsLoaded();
  return DESTINATION_REGISTRY.find(d => d.id === id);
}

/**
 * Get destinations by category (matches if destination has category or contains category in array)
 * Automatically loads destinations on first call
 */
export async function getDestinationsByCategory(category: string): Promise<DestinationRegistryEntry[]> {
  await ensureDestinationsLoaded();
  return DESTINATION_REGISTRY.filter(d => {
    if (Array.isArray(d.category)) {
      return d.category.includes(category);
    }
    return d.category === category;
  });
}

/**
 * Get all unique categories
 * Automatically loads destinations on first call
 */
export async function getAllCategories(): Promise<string[]> {
  await ensureDestinationsLoaded();
  const categories = new Set<string>();
  DESTINATION_REGISTRY.forEach(destination => {
    if (Array.isArray(destination.category)) {
      destination.category.forEach(cat => categories.add(cat));
    } else {
      categories.add(destination.category);
    }
  });
  return Array.from(categories).sort();
}

/**
 * List all available destination IDs
 * Automatically loads destinations on first call
 */
export async function listDestinationIds(): Promise<string[]> {
  await ensureDestinationsLoaded();
  return DESTINATION_REGISTRY.map(d => d.id);
}

/**
 * Get registry size (for debugging)
 * Automatically loads destinations on first call
 */
export async function getRegistrySize(): Promise<number> {
  await ensureDestinationsLoaded();
  return DESTINATION_REGISTRY.length;
}
