# Shared API Contract Types — Design

**Date:** 2026-07-12
**Status:** Approved
**Roadmap line:** Polish — "shared types package"

## Problem

`server/src/types.ts` and `web/src/types.ts` are hand-mirrored copies of the
API contract. Every change must be made twice, guarded only by a comment and
a CLAUDE.md gotcha. The copies have already drifted: `ApiError` exists in the
server copy but not the web copy, and the web copy has dropped several doc
comments.

## Constraints

- The repo is deliberately two independent npm packages — no workspaces, no
  npm at the root (CLAUDE.md). A root `package-lock.json` would also
  re-expose the npm-10 lockfile gotcha.
- Docker build contexts are `./server` and `./web` (docker-compose.yml and
  ci.yml). Files outside those directories are invisible to image builds, so
  a physically shared package would force repo-root build contexts across
  both Dockerfiles, compose, and CI.

## Decision

Keep two files on disk, but make one of them generated. Approaches
considered and rejected: npm workspaces + `packages/shared` (root lockfile,
repo-root Docker contexts, NodeNext-vs-bundler resolution in one package)
and a `file:../shared` dependency (same Docker-context break, flakier
lockfiles, without even the ergonomics of workspaces).

### Source of truth

`server/src/types.ts` stays where it is and becomes the only hand-edited
copy. Its header comment changes from "keep the mirror in sync" to "the web
copy is generated — run `node scripts/sync-types.mjs` after editing".

### Generator: `scripts/sync-types.mjs`

Plain Node script at the repo root. Zero dependencies — no package.json, no
lockfile; runs on any Node 22 (dev machines, stock CI runners).

- **Write mode** (`node scripts/sync-types.mjs`): emits `web/src/types.ts`
  as a generated header —

  ```
  GENERATED FROM server/src/types.ts — DO NOT EDIT.
  Edit the server copy, then run: node scripts/sync-types.mjs
  ```

  — followed by the server file's content verbatim, minus the
  server-specific header comment block.
- **Check mode** (`node scripts/sync-types.mjs --check`): regenerates in
  memory, compares against `web/src/types.ts` on disk, exits 1 with a
  readable diff when stale. Writes nothing.

The generated file is ordinary TypeScript: no `eslint-disable`, still
covered by web's type-checked lint rules and `tsc`.

### CI enforcement

New `contract` job in `.github/workflows/ci.yml`: checkout, then
`node scripts/sync-types.mjs --check`. No `setup-node` or `npm ci` — the
runner's preinstalled Node suffices for a dependency-free script. Runs in
parallel with the `server` and `web` jobs; a stale mirror fails the PR with
the diff in the job log. Not added to the `images` job's `needs` — image
builds don't consume the mirror beyond what `web`'s build already checks.

### Effect on existing drift

First generation adds `ApiError` to the web copy (nothing in `web/`
references that name today, so no conflict) and restores the dropped doc
comments. Any future intentional server-only type would need a different
home than `types.ts` — acceptable; none exist today besides `ApiError`,
which is legitimately part of the contract.

### Documentation updates (same change)

- **CLAUDE.md:** replace the hand-mirroring gotcha with: edit
  `server/src/types.ts`, run `node scripts/sync-types.mjs`, CI enforces.
- **`.claude/skills/sync-types`:** update the skill to run the script
  (write mode to reconcile, check mode to verify) instead of manual
  comparison.
- **README:** update the API-contract bullet (no longer "on the roadmap");
  tick the shared-types item on the Polish roadmap line; bump the stale
  "Status: Phase 3" banner to reflect Phase 3.5 completion.

## Testing

- CI check mode is the standing regression test.
- Local verification for this change: dirty `web/src/types.ts`, confirm
  `--check` exits 1 with a diff; run write mode, confirm `--check` exits 0
  and web `typecheck`, `lint`, and `test` all pass; same for server.

## Out of scope

No new npm package, no workspaces, no Docker/compose/lockfile changes, no
OpenAPI generation. The two packages stay independent — that independence is
why this approach was chosen.
