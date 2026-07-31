import { defineConfig } from "vitest/config";

// Unit tests only. The Playwright e2e suite under tests/e2e is driven by
// `npm test` and must not be picked up here.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
