# CI/CD Pipeline (Phase 3.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every main merge lints, tests, builds, and publishes GHCR images for both packages; PRs prove the images build; a manual dispatch job can deploy a tag through the console's own API.

**Architecture:** The existing `ci.yml` gains a lint step per package and one `images` matrix job (build always, push only on main) authenticated with the built-in `GITHUB_TOKEN`. Compose keeps `build:` and gains `image:` names so published images are one `pull` away. A separate `deploy.yml` holds the secrets-gated `workflow_dispatch` deploy job.

**Tech Stack:** ESLint 9 flat config + typescript-eslint 8 (+ eslint-plugin-react-hooks 5 on web), docker/build-push-action v6, GHCR, bash+curl+jq.

**Spec:** `docs/superpowers/specs/2026-07-12-cicd-pipeline-design.md`

## Global Constraints

- Image names: `ghcr.io/jvillama/fleet-console-server` and `ghcr.io/jvillama/fleet-console-web`; tags per main merge: `sha-<7char>` and `latest`. Registry auth: built-in `GITHUB_TOKEN`, job-level `permissions: packages: write` — no PAT.
- PR events build images but never push; pushes happen only on push events (ci.yml only triggers push on main).
- Lint remediation must not change behavior: server 165 tests, web 60 tests, both typechecks and builds stay green.
- Remediation policy: fix mechanical findings; keep deliberate patterns with a targeted `// eslint-disable-next-line <rule> -- <reason>`; never turn a rule off globally to silence one site. A tests-scoped relaxation of the `no-unsafe-*` family is permitted (mock-heavy fixtures) if findings there exceed ~10 — with a comment explaining why.
- **Dependency changes use CI's npm (CLAUDE.md rule):** install with `npx -y npm@10.9.8 install -D <pkgs>` inside the package, then validate with `npx -y npm@10.9.8 ci`. Never write the lock with npm 11.
- Server relative imports end in `.js`; web imports extensionless. All npm commands run inside `server/` or `web/`.
- Commit messages: no Co-Authored-By trailer.
- Work on branch `cicd-pipeline` (branch from main before Task 1).
- The dispatch deploy job fails loudly (exit 1 + `::error`) when any secret is unset; workflow inputs are passed to bash via `env:` blocks, never interpolated directly into script text (shell-injection hygiene).

---

### Task 1: ESLint in server/

**Files:**
- Create: `server/eslint.config.js`
- Modify: `server/package.json` (lint script; devDeps via npm install)
- Modify: `server/package-lock.json` (via npm@10 only)
- Modify: `server/src/**` / `server/test/**` only as lint remediation requires

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run lint` (exit 0) in `server/`; the config shape Task 2 mirrors.

- [ ] **Step 1: Install dev dependencies with CI's npm**

Run (in `server/`):
```bash
npx -y npm@10.9.8 install -D "eslint@^9" "typescript-eslint@^8"
```
Expected: `package.json` gains the two devDependencies; lock rewritten by npm 10.

- [ ] **Step 2: Create `server/eslint.config.js`**

```js
import tseslint from "typescript-eslint";

// Type-checked linting for TS sources and tests. Config files at the
// package root (vitest.config.ts) are covered via allowDefaultProject;
// this config file itself is plain JS and deliberately unlinted.
export default tseslint.config(
  { ignores: ["dist/", "data/", "eslint.config.js"] },
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.config.ts", "scripts/*.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
```

- [ ] **Step 3: Add the lint script**

In `server/package.json` scripts, after `"typecheck"`:

```json
    "lint": "eslint .",
```

- [ ] **Step 4: Run lint, triage the findings (RED)**

Run (in `server/`): `npm run lint`
Expected: findings on existing code (this is the RED state). Record the initial count in your report.

- [ ] **Step 5: Remediate per policy**

- Mechanical (fix): unused imports/vars, redundant assertions, missing `void` on intentionally-unawaited promises that lack one.
- Deliberate patterns (keep + targeted disable with reason): e.g. `void runPipeline(...)` fire-and-forget in `src/deploy.ts` if `no-floating-promises` complains about the pattern despite `void`; intentional empty `catch` in `src/docker.ts` restore paths (`no-empty` is not in this config, but if a typed rule fires there, disable that line with a reason).
- If `test/**` trips the `no-unsafe-*` family more than ~10 times on mock fixtures, add ONE scoped block instead of per-line noise:

```js
  {
    files: ["test/**"],
    rules: {
      // Mock-heavy fixtures: dockerode fakes are structurally typed, and
      // per-line disables would outnumber the assertions they guard.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
```

(Include only the rules that actually fired; delete the ones that didn't.)

- [ ] **Step 6: Verify GREEN — lint, suite, typecheck, lockfile**

Run (in `server/`):
```bash
npm run lint && npm test && npm run typecheck && npx -y npm@10.9.8 ci
```
Expected: lint exit 0; 165/165 tests; typecheck clean; `npm ci` succeeds (lockfile valid for npm 10). (`npm ci` wipes node_modules — that's expected.)

- [ ] **Step 7: Commit**

```bash
git add server/eslint.config.js server/package.json server/package-lock.json server/src server/test
git commit -m "feat: ESLint 9 flat config (type-checked) in server package"
```

---

### Task 2: ESLint in web/

**Files:**
- Create: `web/eslint.config.js`
- Modify: `web/package.json` (lint script; devDeps via npm install)
- Modify: `web/package-lock.json` (via npm@10 only)
- Modify: `web/src/**` / `web/test/**` only as lint remediation requires

**Interfaces:**
- Consumes: the config shape from Task 1.
- Produces: `npm run lint` (exit 0) in `web/`.

- [ ] **Step 1: Install dev dependencies with CI's npm**

Run (in `web/`):
```bash
npx -y npm@10.9.8 install -D "eslint@^9" "typescript-eslint@^8" "eslint-plugin-react-hooks@^5.2.0"
```

- [ ] **Step 2: Create `web/eslint.config.js`**

```js
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Type-checked linting for TS/TSX sources and tests, plus the React hooks
// rules (exhaustive-deps, rules-of-hooks). Root config files are covered
// via allowDefaultProject; this file itself is plain JS and unlinted.
export default tseslint.config(
  { ignores: ["dist/", "eslint.config.js"] },
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      reactHooks.configs["recommended-latest"],
    ],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
```

Note: `eslint-plugin-react-hooks@^5.2` exposes the flat config as `configs["recommended-latest"]`. If the installed version resolves ≥6 and that key is missing, use the version's documented flat-config export (check `node_modules/eslint-plugin-react-hooks/README.md`) rather than downgrading blindly — and report the substitution.

- [ ] **Step 3: Add the lint script**

In `web/package.json` scripts, after `"typecheck"`:

```json
    "lint": "eslint .",
```

- [ ] **Step 4: Run lint, triage (RED)**

Run (in `web/`): `npm run lint`
Expected: findings on existing code; record the count.

- [ ] **Step 5: Remediate per policy**

Same policy as Task 1 (mechanical fixes; targeted disables with reasons; optional single `test/**` block for the `no-unsafe-*` family if >~10 fixture findings). Additional web-specific notes:
- `react-hooks/exhaustive-deps` findings must be examined individually: a genuinely missing dependency is a bug fix (fix it and note it); a deliberately-omitted dependency (e.g. `usePolling`'s ref pattern) gets a per-line disable with the reason.
- Do not change any component's behavior — the 60 web tests are the referee.

- [ ] **Step 6: Verify GREEN — lint, suite, typecheck, build, lockfile**

Run (in `web/`):
```bash
npm run lint && npm test && npm run typecheck && npm run build && npx -y npm@10.9.8 ci
```
Expected: lint exit 0; 60/60; typecheck clean; build succeeds; `npm ci` succeeds.

- [ ] **Step 7: Commit**

```bash
git add web/eslint.config.js web/package.json web/package-lock.json web/src web/test
git commit -m "feat: ESLint 9 flat config (type-checked + react-hooks) in web package"
```

---

### Task 3: CI — lint steps + images job

**Files:**
- Modify: `.github/workflows/ci.yml` (full new content below)

**Interfaces:**
- Consumes: `npm run lint` from Tasks 1–2; the existing `server/Dockerfile` and `web/Dockerfile`.
- Produces: GHCR images `ghcr.io/jvillama/fleet-console-{server,web}` tagged `sha-<7char>` + `latest` on main merges. Task 4's compose file and README name these images.

- [ ] **Step 1: Replace `.github/workflows/ci.yml` with:**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  server:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    defaults:
      run:
        working-directory: server
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: server/package-lock.json
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
      - run: npm run build

  web:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    defaults:
      run:
        working-directory: web
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: web/package-lock.json
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
      - run: npm run build

  # Builds both container images on every run (a broken Dockerfile fails
  # the PR); pushes to GHCR only on push events, which this workflow
  # receives only for main. Tests and lint gate the push via needs.
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

- [ ] **Step 2: Local sanity — both Dockerfiles still build**

Run (repo root; requires the local daemon):
```bash
docker build -t fleet-ci-sanity-server ./server && docker build -t fleet-ci-sanity-web ./web && docker rmi fleet-ci-sanity-server fleet-ci-sanity-web
```
Expected: both builds succeed (this is what the images job will do on the PR).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: lint steps and GHCR image publishing (build-only on PRs)"
```

---

### Task 4: Compose image names, deploy workflow, docs

**Files:**
- Modify: `docker-compose.yml` (image: names on server/web services)
- Create: `.github/workflows/deploy.yml`
- Modify: `README.md` (roadmap tick, new CI/CD section)
- Modify: `CLAUDE.md` (lint command, CI bullet)

**Interfaces:**
- Consumes: image names/tags from Task 3; the Phase 3 deploy API (`POST /api/containers/:name/deploy {tag}` → 202 `{deploymentId}`; `GET /api/deployments/:id` → `{status, detail, oldImage, newImage}`; statuses terminal at `succeeded`/`failed`).
- Produces: nothing downstream — final task.

- [ ] **Step 1: Add image names to `docker-compose.yml`**

In the `server:` service, directly above `build: ./server`, add:
```yaml
    image: ghcr.io/jvillama/fleet-console-server:latest
```
In the `web:` service, directly above `build: ./web`, add:
```yaml
    image: ghcr.io/jvillama/fleet-console-web:latest
```

- [ ] **Step 2: Validate compose config**

Run (repo root): `docker compose config -q`
Expected: exit 0, no output. (With both `image:` and `build:`, `up --build` builds locally and tags with the registry name; `compose pull` fetches published images.)

- [ ] **Step 3: Create `.github/workflows/deploy.yml`**

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

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    env:
      CONSOLE_URL: ${{ secrets.FLEET_CONSOLE_URL }}
      DEPLOY_USER: ${{ secrets.FLEET_DEPLOY_USER }}
      DEPLOY_PASSWORD: ${{ secrets.FLEET_DEPLOY_PASSWORD }}
      # Inputs enter the scripts via env, never direct interpolation —
      # a crafted input must not become shell syntax.
      CONTAINER: ${{ inputs.container }}
      TAG: ${{ inputs.tag }}
    steps:
      - name: Check deploy secrets
        run: |
          missing=""
          [ -z "$CONSOLE_URL" ] && missing="$missing FLEET_CONSOLE_URL"
          [ -z "$DEPLOY_USER" ] && missing="$missing FLEET_DEPLOY_USER"
          [ -z "$DEPLOY_PASSWORD" ] && missing="$missing FLEET_DEPLOY_PASSWORD"
          if [ -n "$missing" ]; then
            echo "::error::Deploy is not configured. Set repo secrets:$missing (Settings → Secrets and variables → Actions). The console must be reachable over HTTPS from GitHub."
            exit 1
          fi

      - name: Log in
        run: |
          code=$(curl -sS -o login.json -w '%{http_code}' -c cookies.txt \
            -X POST "$CONSOLE_URL/api/login" \
            -H 'Content-Type: application/json' \
            -d "$(jq -n --arg u "$DEPLOY_USER" --arg p "$DEPLOY_PASSWORD" '{username: $u, password: $p}')")
          if [ "$code" != "200" ]; then
            echo "::error::Login failed (HTTP $code): $(cat login.json)"
            exit 1
          fi

      - name: Start deployment
        run: |
          code=$(curl -sS -o deploy.json -w '%{http_code}' -b cookies.txt \
            -X POST "$CONSOLE_URL/api/containers/$CONTAINER/deploy" \
            -H 'Content-Type: application/json' \
            -d "$(jq -n --arg t "$TAG" '{tag: $t}')")
          if [ "$code" != "202" ]; then
            echo "::error::Deploy refused (HTTP $code): $(cat deploy.json)"
            exit 1
          fi
          echo "DEPLOYMENT_ID=$(jq -r .deploymentId deploy.json)" >> "$GITHUB_ENV"
          echo "Deployment $(jq -r .deploymentId deploy.json) started for $CONTAINER → tag $TAG"

      - name: Watch deployment
        run: |
          deadline=$(( $(date +%s) + 300 ))
          while [ "$(date +%s)" -lt "$deadline" ]; do
            curl -sS -o dep.json -b cookies.txt "$CONSOLE_URL/api/deployments/$DEPLOYMENT_ID"
            status=$(jq -r .status dep.json)
            echo "status: $status"
            case "$status" in
              succeeded)
                echo "Deployed: $(jq -r .oldImage dep.json) → $(jq -r .newImage dep.json)"
                exit 0
                ;;
              failed)
                echo "::error::Deployment failed — $(jq -r .detail dep.json)"
                exit 1
                ;;
            esac
            sleep 5
          done
          echo "::error::Timed out after 5 minutes. The deployment may still be running server-side — check the console UI. (Deploying the console's own server container drops this poll by design.)"
          exit 1
```

- [ ] **Step 4: README — roadmap tick + CI/CD section**

1. Roadmap: change the Phase 3.5 line to checked:

```markdown
- [x] **Phase 3.5 — CI/CD:** GitHub Actions build → push image → deploy against the console
```

2. Add a new `## CI/CD` section between `## Roadmap` and `## Security notes`:

```markdown
## CI/CD

Every push to `main` runs the full pipeline — typecheck → lint → test →
build in both packages — then builds and publishes both container images
to GHCR: `ghcr.io/jvillama/fleet-console-server` and
`ghcr.io/jvillama/fleet-console-web`, each tagged `sha-<7char>` (the exact
commit) and `latest`. Pull requests run the same pipeline and build the
images without pushing, so a broken Dockerfile fails the PR.

Consuming the images: `docker compose pull && docker compose up -d`
fetches `latest` (the compose file still builds locally with
`up --build`, so the offline dev loop is unchanged) — or roll a single
container between `sha-*` tags from fleet-console's own deploy UI, which
is the dogfood path.

A manual **Deploy** workflow (`Actions → Deploy → Run workflow`) calls the
console's deploy API for a chosen container and tag. It needs three repo
secrets — `FLEET_CONSOLE_URL`, `FLEET_DEPLOY_USER`, `FLEET_DEPLOY_PASSWORD`
(an admin account created for CI) — and fails with instructions when they
are unset. Two caveats: point it only at an HTTPS console
(`FLEET_COOKIE_SECURE=true` behind TLS), and deploying the console's own
`server` container drops the workflow's status poll mid-flight (the
self-deploy footgun) — the run may report a timeout even though the deploy
succeeded.
```

- [ ] **Step 5: CLAUDE.md updates**

1. In the Commands section, replace the sentence fragment `No linter yet.` (end of the `npm test` bullet) with nothing, and add a new bullet after the typecheck bullet:

```markdown
- `npm run lint` — ESLint 9 flat config, type-checked rules (server: typescript-eslint; web: + react-hooks). Test files relax the `no-unsafe-*` family for mock fixtures — don't tighten without checking the config comment.
```

(Adjust the parenthetical to match what Task 1/2 actually shipped — drop the relaxation clause if the test-scoped block wasn't needed.)

2. Replace the CI bullet:

```markdown
- CI (`.github/workflows/ci.yml`) runs typecheck + lint + tests + builds for both packages on pushes to `main` and PRs, then builds both container images — pushing them to GHCR (`ghcr.io/jvillama/fleet-console-{server,web}`, tags `sha-<7char>` + `latest`) only on `main`. `.github/workflows/deploy.yml` is a manual dispatch job that deploys a tag via the console API (needs FLEET_CONSOLE_URL/FLEET_DEPLOY_USER/FLEET_DEPLOY_PASSWORD secrets).
```

- [ ] **Step 6: Verify**

Run (repo root):
```bash
docker compose config -q && git status --porcelain
```
Expected: compose still valid; only the four intended files modified/created.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml .github/workflows/deploy.yml README.md CLAUDE.md
git commit -m "feat: compose registry image names, manual deploy workflow, CI/CD docs"
```

---

## Final verification (after all tasks)

- [ ] `npm run lint`, `npm test`, `npm run typecheck`, `npm run build` — all green in both packages.
- [ ] `npx -y npm@10.9.8 ci` succeeds in both packages (locks valid for CI's npm).
- [ ] Push branch, open PR — the PR itself must show the new pipeline: lint steps green, `images (server)` and `images (web)` build-only jobs green.
- [ ] After merge to main: CI pushes images — verify both GHCR packages exist with `sha-*` and `latest` tags (`gh api "/users/jvillama/packages?package_type=container"` or the repo's Packages tab), and `docker compose pull` fetches them locally.
- [ ] Dispatch the Deploy workflow once with secrets unset (`gh workflow run Deploy -f container=fleet-console-server-1 -f tag=latest`) — verify it fails with the `::error` naming the three secrets.
- [ ] Note: first GHCR push for each package may need the package visibility/link checked once in the GitHub UI (packages are private by default and linked to the repo automatically when pushed with `GITHUB_TOKEN`).
