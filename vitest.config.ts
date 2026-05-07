import { defineConfig } from 'vitest/config';

// Coverage thresholds are NOT enforced here. Vitest only emits the
// coverage report (text + html for humans, json-summary for CI). The
// per-file floors live in `coverage-thresholds.json` at the repo root
// and are checked in CI by `scripts/check-coverage.mjs`. Run
// `npm run check-coverage` locally after `npm run test:coverage` to
// verify the same gate before pushing. This split keeps `vitest`
// fast/quiet during development and makes coverage failures show up
// as a discrete CI step that's easy to read in PR checks.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary', 'json'],
      include: ['src/**/*.ts'],
      exclude: ['dist/**', '**/*.test.ts'],
    },
  },
});
