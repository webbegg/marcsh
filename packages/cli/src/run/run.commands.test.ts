import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engines } from "../lib/engine";
import type { Engine, TurnRequest } from "../lib/engine/types";
import { openStorage, type Storage } from "../lib/storage";
import { runHeadless, type RunOptions } from "./run";

// `marcsh run "/name args"` runs one of the user's commands as the interface does: marcsh expands it, and a command with questions takes
// the typed text and the defaults as its answers, because nobody is there to answer the rest. Its raw template never reaches the engine.

let dir: string;
let cwd: string;
let storage: Storage;
let out: string;
let err: string;
let requests: TurnRequest[];

const io = { stdout: (text: string) => void (out += text), stderr: (text: string) => void (err += text) };

function installEngine() {
  requests = [];
  const engine: Engine = {
    id: "fake",
    startTurn(request, host) {
      requests.push(request);
      return {
        done: Promise.resolve().then(() => host.emit({ type: "reply", update: (reply) => ({ ...reply, parts: [{ type: "text", text: "ok" }] }) })),
        interrupt() {},
      };
    },
    warmUpCommands: async () => {},
  };
  engines.set("claude", engine);
}

const run = (message: string, rest: Partial<RunOptions> = {}) =>
  runHeadless({ message, continue: false, format: "text", engine: "claude", cwd, ...rest }, { storage, io });

const command = (name: string, text: string) => writeFileSync(join(dir, "commands", `${name}.md`), text);

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-run-commands-")));
  cwd = join(dir, "project");
  mkdirSync(cwd);
  mkdirSync(join(dir, "commands"));
  process.env.MARCSH_COMMANDS_DIR = join(dir, "commands");
  storage = openStorage(":memory:");
  out = "";
  err = "";
  installEngine();
});
afterEach(() => {
  delete process.env.MARCSH_COMMANDS_DIR;
  engines.set("claude", undefined);
  rmSync(dir, { recursive: true, force: true });
});

const QUICK = `---
description: Quick change
questions:
  - id: what
    label: What to change
    kind: text
    required: true
  - id: area
    label: Area or files
    kind: text
---
Make this change.

- What: {{what}}
- Area: {{area}}
`;

describe("marcsh run with a user command", () => {
  test("a plain command is expanded by marcsh before it is sent", async () => {
    command("hello", "---\ndescription: Say hi\n---\nSay hi to $ARGUMENTS.\n");
    expect(await run("/hello the team")).toBe(0);
    expect(requests[0]!.prompt).toBe("Say hi to the team.");
  });

  test("a command with questions takes the typed text as its first answer; a skipped optional line is left out", async () => {
    command("quick", QUICK);
    expect(await run("/quick rename the flag")).toBe(0);
    expect(requests[0]!.prompt).toBe("Make this change.\n\n- What: rename the flag");
    expect(requests[0]!.prompt).not.toContain("{{");
  });

  test("the saved session keeps the expanded text as the user message and the typed prompt as the title", async () => {
    command("hello", "---\ndescription: Say hi\n---\nSay hi to $ARGUMENTS.\n");
    expect(await run("/hello the team")).toBe(0);
    const saved = storage.getSession(storage.listSessions()[0]!.id)!;
    expect(saved.title).toBe("/hello the team");
    const user = saved.messages.find((message) => message.role === "user")!;
    expect(user.parts).toEqual([{ type: "text", text: "Say hi to the team." }]);
  });

  test("a required answer nobody gave is a usage error (exit 2) that sends nothing and creates no session", async () => {
    command("quick", QUICK);
    expect(await run("/quick")).toBe(2);
    expect(requests).toEqual([]);
    expect(err).toContain("What to change");
    expect(storage.listSessions()).toEqual([]);
  });

  test("a command whose questions are invalid sends nothing (exit 2)", async () => {
    command("broken", "---\ndescription: Broken\nquestions:\n  - id: a\n    label: A\n    kind: text\n---\nUses {{missing}}.\n");
    expect(await run("/broken x")).toBe(2);
    expect(requests).toEqual([]);
    expect(err).toContain("/broken");
  });

  test("a message that is not a known command is sent as typed", async () => {
    expect(await run("/nothing-here x")).toBe(0);
    expect(requests[0]!.prompt).toBe("/nothing-here x");
  });
});
