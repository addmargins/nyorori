import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 30000,
    globalSetup: ["test/e2e/global-setup.ts"],
  },
});
