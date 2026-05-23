// Vitest config for the frontend contract test suite (SC-12).
//
// We run in jsdom so the React hooks under test can mount with
// @testing-library/react. MSW intercepts `fetch` at the network layer
// so the API clients under `lib/api/*` are exercised exactly the way
// the renderer exercises them at runtime.
//
// Tests live next to the code they cover (`*.test.ts` / `*.test.tsx`)
// plus a top-level `test/` directory for cross-cutting suites
// (MSW handler composition, contract drift, AppShell smoke render).

import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: [
      "lib/**/*.test.{ts,tsx}",
      "components/**/*.test.{ts,tsx}",
      "test/**/*.test.{ts,tsx}",
    ],
    css: false,
    // Each test file gets its own MSW server reset in test/setup.ts;
    // running in a single thread keeps that lifecycle deterministic
    // while we still get parallelism across files.
    pool: "forks",
  },
});
