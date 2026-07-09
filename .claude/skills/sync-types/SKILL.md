---
name: sync-types
description: Compare the hand-mirrored API contract types in server/src/types.ts and web/src/types.ts, report any drift, and reconcile them. Use after changing either file or when asked to check type sync.
---

`server/src/types.ts` and `web/src/types.ts` are hand-maintained duplicates of the API contract. Keep them semantically identical.

1. Read both files in full.
2. Compare declaration by declaration (interfaces, type aliases, unions, field names, field types, optionality). Ignore differences that are intentionally one-sided:
   - JSDoc comments may be richer on the server copy — that's fine.
   - Server-only types that never cross the wire (e.g. `ApiError` if the web never consumes it) — flag them, but ask before copying them over.
3. Report drift as a short list: declaration name, what differs, which side is newer/correct. Determine "correct" from usage — check `server/src/routes/` for what the API actually returns and `web/src/api.ts` / components for what the UI consumes.
4. Apply the reconciliation: update the stale side to match. Never change the wire shape itself while syncing — if the two sides imply different API behavior, stop and ask which is intended.
5. Run `npm run typecheck` in **both** packages and report the results.
