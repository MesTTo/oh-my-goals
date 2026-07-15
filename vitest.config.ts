import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The default 5s is tight when the parser subprocess, the MeTTa WASM space,
    // and the 500-run property fuzzer all run in parallel; a heavy test can slow
    // past 5s under contention and flake. Give every test headroom.
    testTimeout: 20000,
  },
});
