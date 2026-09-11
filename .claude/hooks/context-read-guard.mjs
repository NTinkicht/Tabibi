#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const MAX_UNBOUNDED_BYTES = 24 * 1024;
const MAX_UNBOUNDED_LINES = 350;
const MAX_BOUNDED_LINES = 300;

const bootstrapAllowlist = new Set([
  "coordination/BOOTSTRAP.md",
  "coordination/STATE.json",
  "coordination/WORK_QUEUE.md",
  "coordination/AI_CAPACITY_POLICY.md",
  "coordination/CONTEXT_ROUTER.md",
]);

function allow() {
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  try {
    const event = JSON.parse(raw || "{}");
    if (event.tool_name !== "Read") allow();

    const input = event.tool_input ?? {};
    const requested = String(input.file_path ?? "");
    if (!requested) allow();

    const projectDir = path.resolve(
      process.env.CLAUDE_PROJECT_DIR || event.cwd || process.cwd(),
    );
    const absolute = path.resolve(projectDir, requested);
    const relative = path.relative(projectDir, absolute).replaceAll("\\", "/");

    if (relative.startsWith("../") || path.isAbsolute(relative)) {
      allow();
    }
    if (bootstrapAllowlist.has(relative)) allow();
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) allow();

    const limit = Number(input.limit);
    if (Number.isFinite(limit) && limit > 0 && limit <= MAX_BOUNDED_LINES) {
      allow();
    }

    const stat = fs.statSync(absolute);
    if (stat.size <= MAX_UNBOUNDED_BYTES) allow();

    const text = fs.readFileSync(absolute, "utf8");
    const lines = text.split(/\r?\n/).length;
    if (lines <= MAX_UNBOUNDED_LINES) allow();

    deny(
      `Context Router blocked an unbounded read of ${relative} (${lines} lines, ${stat.size} bytes). ` +
        `Use deterministic discovery first, e.g. node scripts/context-router.mjs search "<symbol/question term>", ` +
        `then Read only the relevant slice with offset+limit <= ${MAX_BOUNDED_LINES}. ` +
        `If broad semantic compression is genuinely needed, use the explicit opt-in compression path documented in coordination/CONTEXT_ROUTER.md.`,
    );
  } catch {
    // A hook failure must not strand engineering work. Fail open and let the
    // normal Claude permission system continue to govern the read.
    allow();
  }
});
