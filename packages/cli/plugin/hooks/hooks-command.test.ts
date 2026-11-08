import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// S12: the hook prints only hook JSON, even in a Bun project whose bunfig.toml preloads a script that logs.
const PLUGIN_ROOT = join(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "marcsh-hookcmd-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("the hooks.json command output parses as JSON when the project's bunfig.toml preload logs", () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT };
  Bun.spawnSync(["git", "init", "-q", "-b", "main", root], { env });
  writeFileSync(join(root, "bunfig.toml"), 'preload = ["./pre.ts"]\n');
  writeFileSync(join(root, "pre.ts"), 'console.log("preloaded");\n');

  const command: string = JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command;
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -m x" }, cwd: root });
  const result = Bun.spawnSync(["sh", "-c", command], { cwd: root, env, stdin: new TextEncoder().encode(input) });

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString()).hookSpecificOutput.permissionDecision).toBe("deny");
});
