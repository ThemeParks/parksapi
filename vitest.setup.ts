// Vitest setup file for cache testing
// This file runs before the test suite

// Set up test-specific environment variables
process.env.CACHE_DB_PATH = ':memory:';
