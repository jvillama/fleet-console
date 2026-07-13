#!/usr/bin/env node
/**
 * Regenerates web/src/types.ts from server/src/types.ts — the single
 * source of truth for the API contract. Zero dependencies by design so it
 * runs on any Node without an install step.
 *
 *   node scripts/sync-types.mjs          rewrite the mirror
 *   node scripts/sync-types.mjs --check  exit 1 with a diff if stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(root, "server", "src", "types.ts");
const mirrorPath = join(root, "web", "src", "types.ts");

const GENERATED_HEADER = `/**
 * GENERATED FROM server/src/types.ts — DO NOT EDIT.
 * Edit the server copy, then run: node scripts/sync-types.mjs
 */
`;

const normalize = (text) => text.replace(/\r\n/g, "\n");

// Strict args: a typo like `--chek` must not silently rewrite the mirror.
const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== "--check");
if (unknown.length > 0) {
  console.error(`unknown argument(s): ${unknown.join(" ")}`);
  console.error("usage: node scripts/sync-types.mjs [--check]");
  process.exit(2);
}

const source = normalize(readFileSync(sourcePath, "utf8"));
// The mirror gets its own header in place of the source file's.
const body = source.replace(/^\/\*\*[\s\S]*?\*\/\n/, "");
const expected = GENERATED_HEADER + body;

if (process.argv.includes("--check")) {
  let actual;
  try {
    actual = normalize(readFileSync(mirrorPath, "utf8"));
  } catch {
    console.error(`missing ${mirrorPath} — run: node scripts/sync-types.mjs`);
    process.exit(1);
  }
  if (actual === expected) {
    console.log("web/src/types.ts is in sync with server/src/types.ts");
    process.exit(0);
  }
  console.error("web/src/types.ts is stale — run: node scripts/sync-types.mjs\n");
  // Pairwise compare: an insertion misaligns every later line, so cap the
  // output instead of flooding the log with the whole file.
  const MAX_MISMATCHES = 20;
  const actualLines = actual.split("\n");
  const expectedLines = expected.split("\n");
  const count = Math.max(actualLines.length, expectedLines.length);
  let shown = 0;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (actualLines[i] !== expectedLines[i]) {
      total++;
      if (shown < MAX_MISMATCHES) {
        console.error(`line ${i + 1}:`);
        console.error(`  expected: ${expectedLines[i] ?? "<missing>"}`);
        console.error(`  actual:   ${actualLines[i] ?? "<missing>"}`);
        shown++;
      }
    }
  }
  if (total > shown) {
    console.error(`…and ${total - shown} more mismatched lines`);
  }
  process.exit(1);
}

writeFileSync(mirrorPath, expected);
console.log(`wrote ${mirrorPath}`);
