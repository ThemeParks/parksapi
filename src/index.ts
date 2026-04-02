/**
 * ParksAPI - TypeScript library for fetching real-time theme park data
 *
 * Main entry point for the library
 */

// Export everything from core modules
export * from './destination.js';
export * from './destinationRegistry.js';
export * from './tracing.js';
export * from './http.js';
export * from './injector.js';
export * from './cache.js';
export * from './datetime.js';
export * from './htmlUtils.js';
export * from './statusMap.js';
export * from './promiseReuse.js';

// Export default as named export for config decorator
export { default as config } from './config.js';

// Tag system
export {TagBuilder} from './tags/index.js';

// Virtual queue helpers
export {VQueueBuilder} from './virtualQueue/builder.js';

// Re-export everything from @themeparks/typelib
export * from '@themeparks/typelib';
