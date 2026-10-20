import { defineConfig } from "vitest/config";

// Each test file runs in its own process, watched by test/memory-guard.ts.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], pool: "forks", setupFiles: ["test/memory-guard.ts"] },
});
