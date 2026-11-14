import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    testTimeout: 20_000,
    // The CLI tests run the built executable, so build before testing.
    globalSetup: ["tests/global-setup.ts"],
  },
});
