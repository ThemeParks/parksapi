import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Decorator support has to be stated here, not inherited from tsconfig.json.
  //
  // Vite's transformer resolves each file against tsconfig.json to decide
  // whether to apply `experimentalDecorators` / `emitDecoratorMetadata`, and
  // that config excludes `**/__tests__` and `**/*.test.ts` (they must not
  // reach `dist/`). An excluded file gets neither option, so decorator syntax
  // is emitted verbatim and every test that declares a decorated class dies at
  // import with `SyntaxError: Invalid or unexpected token`.
  //
  // Older Vite ignored the exclusion and applied the options anyway, which is
  // why this was invisible until a Vite bump. Setting them explicitly makes
  // the suite independent of that behaviour in either direction. Keep these
  // two in step with the matching tsconfig.json compilerOptions.
  oxc: {
    decorator: {
      legacy: true,                 // = experimentalDecorators
      emitDecoratorMetadata: true,  // = emitDecoratorMetadata (needs legacy)
    },
  },
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
