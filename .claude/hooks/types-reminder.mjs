// PostToolUse(Write|Edit) hook: after editing either mirrored types.ts,
// remind both the user (systemMessage) and Claude (additionalContext) that
// the copy in the other package must be updated to match.
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

const m = file.match(/\/(server|web)\/src\/types\.ts$/);
if (!m) process.exit(0);

const edited = `${m[1]}/src/types.ts`;
const other = m[1] === "server" ? "web/src/types.ts" : "server/src/types.ts";

console.log(
  JSON.stringify({
    systemMessage: `${edited} is hand-mirrored — ${other} must be updated to match.`,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `Reminder: server/src/types.ts and web/src/types.ts are hand-mirrored API contract types. You just edited ${edited}; make the corresponding change in ${other} (or run /sync-types) before finishing.`,
    },
  })
);
