import { defineConfig } from 'vitest/config';

// Pure-logic tests only (codecs, caches, parsers, worker sanitizers) — no DOM,
// no network. Anything needing a browser stays in the manual verification pass
// (docs/architecture.md → Testing and verification).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'worker/**/*.test.js', 'scripts/**/*.test.mjs'],
  },
});
