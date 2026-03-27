// src/harness/jsRunner.mjs
//
// Standalone ESM script — spawned as a child process against the JS codebase.
// Usage: node --env-file=.env src/harness/jsRunner.mjs <JsClassName> [outputFile]
//
// Writes JSON to outputFile (if provided) or stdout.
// Errors go to stderr. Non-zero exit on failure.

import { pathToFileURL } from 'url';
import * as path from 'path';
import * as fs from 'fs';

const className = process.argv[2];
const outputFile = process.argv[3]; // Optional: write to file instead of stdout

if (!className) {
  console.error('Usage: node jsRunner.mjs <JsClassName> [outputFile]');
  process.exit(1);
}

// Redirect stdout to stderr during import/execution so library logging
// (dotenv, HTTP debug messages) doesn't corrupt our JSON output.
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);

try {
  // Dynamic import of the JS codebase entry point.
  // ESM import() resolves relative to import.meta.url, NOT process.cwd().
  // We must construct an absolute file:// URL from cwd to reach lib/index.js.
  const entryPath = pathToFileURL(path.resolve(process.cwd(), 'lib/index.js')).href;
  const mod = await import(entryPath);
  const destinations = mod.default?.destinations ?? mod.destinations;

  if (!destinations) {
    console.error('Could not find destinations export in lib/index.js');
    process.exit(1);
  }

  const DestClass = destinations[className];
  if (!DestClass) {
    console.error(`Class "${className}" not found in destinations. Available: ${Object.keys(destinations).join(', ')}`);
    process.exit(1);
  }

  const instance = new DestClass();

  // Fetch all three data types
  const entities = await instance.getAllEntities();
  const liveData = await instance.getEntityLiveData();
  const schedules = await instance.getEntitySchedules();

  const output = JSON.stringify({ entities, liveData, schedules });

  if (outputFile) {
    // Write to file — avoids stdout buffer limits for large outputs
    fs.writeFileSync(outputFile, output);
  } else {
    // Restore stdout and write clean JSON
    process.stdout.write = originalStdoutWrite;
    process.stdout.write(output);
  }

  process.exit(0);
} catch (error) {
  console.error(`jsRunner error for ${className}:`, error.message || error);
  process.exit(1);
}
