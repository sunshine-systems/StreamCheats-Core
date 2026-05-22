# streamcheats-core

Rust daemon + API backend, with a Next.js on Electron frontend. The frontend code lands here later (cloned in once another agent finishes its work in that repo).

## Linear scope

All Linear MCP operations in this repo target **only** the `StreamCheats` team (issue prefix `SC`).

- When listing, querying, creating, or updating issues/projects, always filter to the `StreamCheats` team.
- Do not read, create, or modify issues in any other team or workspace, even if the MCP server has access.
- If a user request is ambiguous about team, assume `StreamCheats` and confirm only if the request seems to point elsewhere.
- Never run workspace-wide mutations (e.g. creating teams, changing workspace settings).
