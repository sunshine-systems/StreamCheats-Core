# Frontend ↔ Daemon Contract — manual review checklist

The Rust daemon is the source of truth for every JSON response shape
the renderer consumes. The zod schemas under `frontend/lib/api/schemas/`
mirror those shapes; `test/contract.test.ts` parses representative
payloads to lock the mapping in.

When you touch any of the files in column **Daemon** below, also update
the corresponding file in column **Frontend** in the same PR, and run
`pnpm -C frontend test` to confirm the contract tests still pass.

| Surface           | Daemon                                                | Frontend schema                         |
| ----------------- | ----------------------------------------------------- | --------------------------------------- |
| Firmware status   | `backend/src/firmware/mod.rs` (`State` enum)          | `lib/api/schemas/firmware.ts`           |
| Firmware routes   | `backend/src/http/routes/firmware.rs`                 | `lib/api/schemas/firmware.ts`           |
| Updater status    | `backend/src/updater/mod.rs` (`State` enum)           | `lib/api/schemas/updater.ts`            |
| Updater routes    | `backend/src/http/routes/updates.rs`                  | `lib/api/schemas/updater.ts`            |
| Experimental      | `backend/src/experimental/mod.rs` (`Status` struct)   | `lib/api/schemas/experimental.ts`       |
| Experimental APIs | `backend/src/experimental/registry.rs` (`REGISTRY`)   | `lib/api/schemas/experimental.ts`       |
| Health            | `backend/src/http/routes/health.rs`                   | `lib/api/schemas/health.ts`             |
| Log stream        | `backend/src/services/log_stream/event.rs`            | `lib/api/schemas/logs.ts`               |

## Checklist before merging a daemon-side change

1. Did you rename, add, or remove a field in any of the Daemon files?
2. If yes, mirror the change in the matching Frontend schema.
3. If the change is a new `State::*` variant, add a case to the
   discriminated union AND add a parse-acceptance case to
   `test/contract.test.ts`.
4. Run `pnpm -C frontend test`. The contract suite should pass.
5. Run `pnpm -C frontend build`. The compile should succeed (the
   inferred `z.infer<…>` types flow through to the typed clients).

## Why no auto-generated schema dump?

A `schemars`-based dump would lock the contract even harder, but the
daemon doesn't currently depend on `schemars` and pulling it in for
this purpose alone is overkill for a single-developer project at this
stage. The manual checklist above plus the MSW-driven contract tests
catch every drift that has bitten us so far. Revisit if the contract
test suite starts missing real drift in practice.
