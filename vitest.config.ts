import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run only the TypeScript sources under tests/. Compiled output in dist/
    // must never be picked up as a second copy of the suite.
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
