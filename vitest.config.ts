import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'src/**/__tests__/**/*.test.ts',
      'src/**/*.test.ts'
    ],
    exclude: [
      'node_modules',
      'lib',
      'dist'
    ],
    coverage: {
      include: [
        'src/**/*.ts'
      ],
      exclude: [
        'src/**/*.d.ts',
        'src/test.ts',
        'src/parks/**'
      ]
    },
    setupFiles: ['./vitest.setup.ts'],
  },
});
