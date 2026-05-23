// Global Vitest setup — wires MSW into every test file, plus a small
// amount of polyfilling for the bits jsdom doesn't ship.
//
// Each test gets:
//   * a fresh MSW server (`server.resetHandlers()` between tests),
//   * a configured `NEXT_PUBLIC_STREAMCHEATS_HTTP_PORT` so the API
//     clients' `resolveBase()` returns a deterministic URL the MSW
//     handlers are registered against,
//   * `window.streamcheats = undefined` (the Electron bridge is never
//     present in jsdom — the browser-fallback path is what we test).

import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";

import { server } from "./msw/server";

// Pin the dev port the API clients resolve to. The MSW handlers in
// `test/msw/handlers.ts` register against `http://127.0.0.1:9999/...`.
process.env.NEXT_PUBLIC_STREAMCHEATS_HTTP_PORT = "9999";

// Strip the Electron bridge — jsdom never has one and we want the
// browser-fallback resolution path under test.
beforeEach(() => {
  // Intentional reset — the optional `streamcheats` field on Window
  // can legally be deleted (the type is `?:`), so no ts-ignore needed.
  delete (window as { streamcheats?: unknown }).streamcheats;
});

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => {
  server.close();
});
