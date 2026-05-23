// Single import surface for everything under `lib/api/schemas/`.
// Re-exporting from one barrel keeps the contract test file
// (`test/contract.test.ts`) tidy and makes it easy to add schemas for
// future endpoints without touching each call site.

export * from "./firmware";
export * from "./experimental";
export * from "./updater";
export * from "./health";
export * from "./logs";
