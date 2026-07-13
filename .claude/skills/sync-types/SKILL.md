---
name: sync-types
description: Regenerate or verify web/src/types.ts, which is generated from server/src/types.ts (the API contract's single source of truth). Use after changing server/src/types.ts or when asked to check type sync.
---

`server/src/types.ts` is the single source of truth for the API contract; `web/src/types.ts` is generated from it. Never hand-edit the web copy.

1. To verify: run `node scripts/sync-types.mjs --check` from the repo root. Exit 0 means in sync; exit 1 prints a line diff.
2. To reconcile: run `node scripts/sync-types.mjs` (rewrites `web/src/types.ts`), then re-run `--check` to confirm exit 0.
3. If the drift shows someone hand-edited `web/src/types.ts` with a change that should exist (e.g. a new field the UI needs), port that change into `server/src/types.ts` FIRST, then regenerate. Never change the wire shape itself while syncing — if the two sides imply different API behavior, stop and ask which is intended.
4. Run `npm run typecheck` in **both** packages (`server/`, `web/`) and report the results.
