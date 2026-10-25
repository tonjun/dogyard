import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Commander wiring is exercised by the e2e suite in spawned processes, which v8 coverage can't see.
      exclude: ["src/cli/index.ts", "src/cli/commands/**", "src/index.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { branches: 85 },
    },
  },
});
