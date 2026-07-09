// PostToolUse(Write|Edit) hook: typecheck the package containing the edited
// .ts/.tsx file. Exit 2 feeds tsc errors back to Claude; exit 0 is silent.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const raw = await new Promise((resolve) => {
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => resolve(s || "{}"));
});

let file = "";
try {
  file = (JSON.parse(raw).tool_input?.file_path ?? "").replaceAll("\\", "/");
} catch {
  process.exit(0);
}

const m = file.match(/\/(server|web)\/src\/.*\.tsx?$/);
if (!m) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = join(root, m[1]);
// Can't typecheck if deps were never installed; stay silent rather than
// having npx fetch typescript from the network mid-edit.
if (!existsSync(join(pkg, "node_modules", "typescript"))) process.exit(0);

try {
  execSync("npx tsc --noEmit", { cwd: pkg, stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  console.error(`tsc --noEmit failed in ${m[1]}/:\n` + String(e.stdout ?? "") + String(e.stderr ?? ""));
  process.exit(2);
}
