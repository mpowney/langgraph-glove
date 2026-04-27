import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // E2E tests can be slow — allow 30 s per individual assertion/call
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Run serially so each suite gets a stable connection to the tool server
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Don't fail on unhandled promise rejections from the stub server teardown
    dangerouslyIgnoreUnhandledErrors: false,
    reporters: ["verbose"],
  },
});
