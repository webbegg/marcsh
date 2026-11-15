import { afterEach, describe, expect, test } from "bun:test";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import { Mode } from "../modes";
import { clearSessionMarker, startSessionMarker } from "../background/leftovers";
import { claudeQueryOptions } from "./claude";

// M6: the Claude CLI, and so what its Bash runs, inherits this run's MARCSH_SESSION, so a process it leaves running is a leftover marcsh can find.

const saved = process.env.MARCSH_SESSION;
afterEach(() => {
  clearSessionMarker();
  if (saved === undefined) delete process.env.MARCSH_SESSION;
  else process.env.MARCSH_SESSION = saved;
});

const base = { cwd: tmpdir(), mode: Mode.BUILD, model: "sonnet", abortController: new AbortController(), plugins: [] as string[], canUseTool: (async () => ({ behavior: "deny", message: "" })) as CanUseTool };

describe("the Claude process's environment (M6)", () => {
  test("with pack hook variables, it is marcsh's environment with the marker", () => {
    const marker = startSessionMarker();
    const options = claudeQueryOptions({ ...base, hookEnv: { MARCSH_APPROVAL_MODE: "normal" } });
    expect(options.env?.MARCSH_SESSION).toBe(marker.id);
    // Never marked as marcsh's own infrastructure: that would hide what its Bash leaves running too.
    expect(options.env?.MARCSH_INFRA).toBeUndefined();
  });

  test("without them, the SDK's default (marcsh's own environment) carries it", () => {
    const marker = startSessionMarker();
    expect(claudeQueryOptions(base).env).toBeUndefined();
    expect(process.env.MARCSH_SESSION).toBe(marker.id);
  });
});
