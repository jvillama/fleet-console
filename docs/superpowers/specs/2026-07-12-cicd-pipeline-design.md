# CI/CD Pipeline (Phase 3.5) — Design

> Status: approved 2026-07-12
> Prereq: deployment workflow (PR #5) — the deploy API this pipeline's
> dispatch job calls, and the tag-rolling story the published images enable.
> Completes the roadmap's "CI/CD via GitHub Actions" half of the original
> Phase 3 line.

## Goal

Every merge to main lints, tests, builds, and publishes versioned container
images for both packages to GHCR; pull requests prove the images still build
without publishing anything. A manually-dispatched deploy job can roll a
reachable fleet-console instance to a chosen tag through the console's own
deploy API. The local dev loop is untouched.

## Decisions (settled during brainstorming)

- **Deploy target: decoupled.** The stack runs on hosts GitHub cannot
  reach, so continuous *delivery* stops at the registry: CI publishes
  images; deployment is pulling a new tag — via fleet-console's own deploy
  UI, `docker compose pull`, or the manual dispatch job the day a reachable
  URL exists. No self-hosted runner.
- **Registry and tags:** `ghcr.io/jvillama/fleet-console-server` and
  `ghcr.io/jvillama/fleet-console-web`, each pushed with two tags per main
  merge: `sha-<7char>` (the literal tag string the deploy UI rolls between)
  and `latest`. Auth is the workflow's built-in
  `GITHUB_TOKEN` with job-level `packages: write` — no PAT.
- **Compose keeps `build:`, gains `image:`.** `docker compose up --build`
  still works offline exactly as today (now tagging local builds with the
  registry names); a registry-consuming deployment becomes
  `docker compose pull && docker compose up -d`.
- **Lint is in scope:** ESLint 9 flat config with typescript-eslint's
  type-checked recommended rules in both packages; `eslint-plugin-react-hooks`
  additionally on web. New `npm run lint` scripts and a lint step in CI.
- **PR builds, main pushes:** the image job always builds both Dockerfiles;
  `push:` is true only for push events on main. Tests and lint gate the
  push via `needs`.
- **Workflow layout (Approach A):** the existing `ci.yml` gains the lint
  steps and one new `images` matrix job; the manual deploy lives in its own
  `deploy.yml` so an accidental dispatch can never touch CI.
- **Missing deploy secrets fail loudly:** a dispatched deploy with
  unconfigured secrets exits 1 with an explicit `::error` naming them — a
  green no-op would misreport a deploy that never happened.

## Lint

### Dependencies (dev, per package)

- Both: `eslint`, `typescript-eslint` (ESLint 9, flat config)
- Web additionally: `eslint-plugin-react-hooks`

Lockfile rule applies (CLAUDE.md): after the installs, regenerate each
package's lock with `npx -y npm@10.9.8 install` and validate with
`npx -y npm@10.9.8 ci`.

### Config shape

`server/eslint.config.js`:

```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/"] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
);
```

`web/eslint.config.js`: same skeleton plus
`eslint-plugin-react-hooks`' recommended flat config applied to
`**/*.{ts,tsx}`.

Scripts (both packages): `"lint": "eslint ."`.

### Remediation policy

Existing code will trip type-checked rules. Policy:

- Mechanical findings (unused imports/vars, missing `await`/`void`,
  redundant type assertions): fix them.
- Deliberate patterns the rules dislike (fire-and-forget
  `void runPipeline(...)`, intentional empty catches in restore paths):
  keep the code, add a targeted `// eslint-disable-next-line <rule> -- reason`
  at that line. Never weaken a rule globally to silence one site.
- Both suites (server 165, web 60) and both typechecks must remain green —
  lint remediation must not change behavior.

## CI workflow — `.github/workflows/ci.yml`

1. **Existing `server` and `web` jobs:** insert `- run: npm run lint`
   between the typecheck and test steps.
2. **New `images` job:**

```yaml
  images:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    needs: [server, web]
    permissions:
      contents: read
      packages: write
    strategy:
      matrix:
        package: [server, web]
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        if: github.event_name == 'push'
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ghcr.io/${{ github.repository }}-${{ matrix.package }}
          tags: |
            type=sha,format=short
            type=raw,value=latest,enable={{is_default_branch}}
      - uses: docker/build-push-action@v6
        with:
          context: ./${{ matrix.package }}
          push: ${{ github.event_name == 'push' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha,scope=${{ matrix.package }}
          cache-to: type=gha,scope=${{ matrix.package }},mode=max
```

Notes: `type=sha,format=short` yields `sha-<7char>` tags; the deploy UI and
dispatch job use those tag strings verbatim. The top-level workflow
`permissions: contents: read` stays; only the `images` job gets
`packages: write`. On PR events the login step is skipped and
`push: false` makes the build a pure smoke test.

## Compose — `docker-compose.yml`

```yaml
  server:
    image: ghcr.io/jvillama/fleet-console-server:latest
    build: ./server
    ...
  web:
    image: ghcr.io/jvillama/fleet-console-web:latest
    build: ./web
    ...
```

With both keys, `up --build` builds locally and applies the registry name
to the local image; `compose pull` fetches the published one. Demo services
unchanged.

## Deploy job — `.github/workflows/deploy.yml`

```yaml
name: Deploy
on:
  workflow_dispatch:
    inputs:
      container:
        description: Container name to deploy
        required: true
        default: fleet-console-server-1
      tag:
        description: Image tag to deploy (e.g. sha-1a2b3c4 or latest)
        required: true
        default: latest
```

One job, `ubuntu-latest`, plain bash + curl + jq:

1. **Secrets gate:** if any of `FLEET_CONSOLE_URL`, `FLEET_DEPLOY_USER`,
   `FLEET_DEPLOY_PASSWORD` is empty → `::error` naming the missing
   secret(s) and how to set them → exit 1.
2. **Login:** `curl -c cookies -X POST $URL/api/login` with the credentials;
   non-200 → error + exit 1.
3. **Deploy:** `POST $URL/api/containers/${{ inputs.container }}/deploy`
   with `{"tag": ...}`; expect 202 and capture `deploymentId`; print the
   error body verbatim on 4xx/5xx and exit 1.
4. **Poll:** `GET $URL/api/deployments/<id>` every 5 s, 5-minute deadline.
   Terminal `succeeded` → exit 0 (print old → new images); `failed` →
   exit 1 (print `detail`); deadline → exit 1 with a note that the deploy
   may still be running server-side.

Documented caveats (README):

- The URL should be HTTPS; run the console behind TLS with
  `FLEET_COOKIE_SECURE=true` before pointing repo secrets at it. The
  dedicated deploy user should be an `admin` account created for CI.
- Self-deploying the console's own `server` container drops the poll
  mid-flight (the established self-deploy footgun): the job may time out
  and report failure even though the deploy succeeded. Deploying `web` or
  any other container is unaffected.

## Docs

- **README:** tick the Phase 3.5 roadmap line; new "CI/CD" section — the
  pipeline shape (lint → typecheck → test → build → image build/push),
  image names and tags, consuming them (`compose pull`, deploy UI rolling
  between `sha-*` tags), the deploy job's inputs/secrets, and the two
  caveats above.
- **CLAUDE.md:** replace "No linter yet" with `npm run lint` in the
  commands section; extend the CI bullet (lint step; images job pushes
  GHCR images on main, builds-only on PRs).

## Error handling

- A red lint/test/typecheck/build in either package blocks the images job
  entirely (`needs`).
- GHCR push failures fail the workflow visibly; nothing retries silently.
- The dispatch job surfaces the console API's own error bodies (422 bad
  tag, 409 already deploying, 403 role) verbatim in the run log.

## Testing / verification

- Lint: `npm run lint` green in both packages locally and in CI.
- Suites: server 165 and web 60 tests stay green (remediation must not
  change behavior); both typechecks and builds stay green.
- Images job: the phase's own PR exercises the build-only path for both
  packages; after merge, verify both GHCR packages exist with `sha-*` and
  `latest` tags (`gh api /user/packages` or the GitHub UI) and that
  `docker compose pull` fetches them.
- Deploy job: dispatch once with secrets unset → verify the loud failure
  path and message. The happy path is exercised the day a reachable host
  exists; until then the script mirrors the API calls already proven live
  in the Phase 3 smoke test.
- Lockfiles: regenerated and validated with npm 10 per CLAUDE.md, in both
  packages.

## Out of scope (follow-up slices)

- Continuous deployment to a real host (needs a reachable URL or
  self-hosted runner — revisit when one exists)
- SemVer release tagging / GitHub Releases
- Prettier or other formatting enforcement
- Image signing/provenance (cosign, SLSA), vulnerability scanning
- Multi-arch builds (amd64 only, matching the demo hosts)
