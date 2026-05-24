// Default MSW request handlers — one per endpoint the renderer
// consumes. Tests override individual handlers via `server.use(...)`
// for state-machine transitions or error-path cases.
//
// Base URL matches `NEXT_PUBLIC_STREAMCHEATS_HTTP_PORT` set in
// `test/setup.ts` so the API clients' `resolveBase()` returns the
// same origin MSW intercepts.

import { http, HttpResponse } from "msw";

import {
  experimentalRegistry,
  experimentalStatusDisabled,
  firmwareReleasesPayload,
  firmwareStatusIdle,
  healthOk,
  updaterStatusIdle,
} from "./fixtures";

export const BASE = "http://127.0.0.1:9999";

export const defaultHandlers = [
  // Firmware
  http.get(`${BASE}/api/firmware/status`, () =>
    HttpResponse.json(firmwareStatusIdle)
  ),
  http.get(`${BASE}/api/firmware/releases`, () =>
    HttpResponse.json(firmwareReleasesPayload)
  ),
  http.post(`${BASE}/api/firmware/check`, () =>
    HttpResponse.json({ state: firmwareStatusIdle.state })
  ),
  http.post(`${BASE}/api/firmware/download`, () =>
    HttpResponse.json({ ok: true }, { status: 202 })
  ),
  http.post(`${BASE}/api/firmware/flash`, () =>
    HttpResponse.json({ ok: true }, { status: 202 })
  ),
  http.post(`${BASE}/api/firmware/flash_local`, () =>
    HttpResponse.json({ ok: true }, { status: 202 })
  ),
  // Updates restructure: cancel handler. Default accepts (202) so the
  // happy-path UI tests don't have to opt in. Tests that exercise the
  // "nothing was flashing" case override with server.use().
  http.post(`${BASE}/api/firmware/cancel_flash`, () =>
    HttpResponse.json({ ok: true }, { status: 202 })
  ),
  // Experimental
  http.get(`${BASE}/api/experimental/registry`, () =>
    HttpResponse.json(experimentalRegistry)
  ),
  http.get(`${BASE}/api/experimental/status`, () =>
    HttpResponse.json(experimentalStatusDisabled)
  ),
  http.post(`${BASE}/api/experimental/set_active`, () =>
    HttpResponse.json({ ok: true, status: experimentalStatusDisabled })
  ),
  http.post(`${BASE}/api/experimental/enable`, () =>
    HttpResponse.json({
      ok: true,
      status: { ...experimentalStatusDisabled, enabled: true, running: true },
    })
  ),
  http.post(`${BASE}/api/experimental/disable`, () =>
    HttpResponse.json({ ok: true, status: experimentalStatusDisabled })
  ),

  // Updater (software)
  http.get(`${BASE}/api/updates/status`, () =>
    HttpResponse.json(updaterStatusIdle)
  ),
  http.post(`${BASE}/api/updates/check`, () =>
    HttpResponse.json({ state: updaterStatusIdle.state })
  ),
  http.post(`${BASE}/api/updates/download`, () =>
    HttpResponse.json({ ok: true }, { status: 202 })
  ),
  http.post(`${BASE}/api/updates/install`, () =>
    HttpResponse.json({ ok: true, installer_path: "C:\\tmp\\setup.exe" })
  ),
  http.post(`${BASE}/api/settings/experimental_builds`, async ({ request }) => {
    const body = (await request.json()) as { enabled: boolean };
    return HttpResponse.json({ ok: true, enabled: body.enabled });
  }),

  // Health
  http.get(`${BASE}/health`, () => HttpResponse.json(healthOk)),
];
