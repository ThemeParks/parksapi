// Jest setup file for cache testing
// This file runs before each test suite

// Set up test-specific environment variables
process.env.CACHE_DB_PATH = ':memory:';

// Global test cleanup
beforeEach(() => {
  // Any global setup before each test
});

afterEach(() => {
  // Any global cleanup after each test
});
