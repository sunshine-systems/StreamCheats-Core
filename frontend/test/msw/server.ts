// Shared MSW node server. One instance per Vitest worker — handlers
// reset between tests in `test/setup.ts`.

import { setupServer } from "msw/node";

import { defaultHandlers } from "./handlers";

export const server = setupServer(...defaultHandlers);
