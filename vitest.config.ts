import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // PostgreSQL-backed integration tests share one test database and truncate
    // tables between tests. Test files must execute sequentially so one
    // integration file cannot wipe another file's fixtures mid-test.
    fileParallelism: false,

    // Coverage (M17.3). INFORMATIONAL ONLY — deliberately no `thresholds`.
    // No percentage can fail `npm run test:coverage` or CI. Coverage is a
    // visibility aid for the developer, not a gate; introducing a threshold is
    // a separate, deliberate decision, not a side effect of adding the report.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      // Measure first-party application code only.
      include: ['src/**/*.ts'],
      exclude: [
        // Tests themselves are never a coverage target (117 files under src/).
        '**/*.test.ts',
        // Generated / third-party / build output.
        'node_modules/**',
        'dist/**',
        // Type-only leaf: interfaces, module augmentation, zero runtime
        // statements. Including it would report meaningless numbers.
        'src/types/**',
      ],
    },
  },
});