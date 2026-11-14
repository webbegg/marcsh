import { describe, expect, test } from "bun:test";
import type { CanUseTool, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalMode } from "../approval-policy";
import { openStorage } from "../storage";
import { createCanUseTool } from "./claude";
import { type PermissionAsk, type PermissionDecision, pathAnswer, type TurnHost } from "./types";

// Not under a temp dir: in yolo, `rm` inside a scratch folder runs without asking, which would hide the floor ask these tests are about.
const cwd = "/srv/t6-project";
const MODES: ApprovalMode[] = ["normal", "auto", "yolo"];

type CallOptions = Partial<Parameters<CanUseTool>[2]>;

function setup(approvalMode: ApprovalMode, answer: PermissionDecision = "allow", { withStore = true }: { withStore?: boolean } = {}) {
  const storage = openStorage(":memory:");
  const asked: PermissionAsk[] = [];
  const host = {
    askPermission: async (ask: PermissionAsk) => {
      asked.push(ask);
      return answer;
    },
  } as unknown as TurnHost;
  const canUseTool = createCanUseTool(host, undefined, { approvalMode, cwd, branchOf: () => ({ kind: "feature", branch: "feat/x" }), ...(withStore ? { pathRules: storage } : {}) });
  const call = (toolName: string, input: Record<string, unknown>, extra: CallOptions = {}) =>
    canUseTool(toolName, input, { signal: new AbortController().signal, toolUseID: "tool-1", requestId: "req-1", ...extra });
  const bash = (command: string, extra: CallOptions = {}) => call("Bash", { command }, extra);
  return { storage, asked, call, bash };
}

const allowed = (input: Record<string, unknown>): PermissionResult => ({ behavior: "allow", updatedInput: input });
const commandsAsked = (asked: PermissionAsk[]) => asked.map((ask) => (ask.input as { command: string }).command);

const suggestionFor = (ruleContent: string): PermissionUpdate[] => [
  { type: "addRules", rules: [{ toolName: "Bash", ruleContent }], behavior: "allow", destination: "session" },
];

describe("a stored path rule skips the ask", () => {
  test("for a folder under /tmp, in every mode", async () => {
    for (const mode of MODES) {
      const { storage, bash, asked } = setup(mode);
      storage.addPathRule({ cwd, program: "rm", dir: "/tmp/x" });

      expect(await bash("rm -rf /tmp/x/y")).toEqual(allowed({ command: "rm -rf /tmp/x/y" }));
      expect(await bash("rm /tmp/x/a && rm -r /tmp/x/b")).toEqual(allowed({ command: "rm /tmp/x/a && rm -r /tmp/x/b" }));
      expect(asked).toEqual([]);
    }
  });

  test("for a project folder, also where the policy would floor-ask (A3)", async () => {
    for (const mode of MODES) {
      const command = `rm -rf ${cwd}/build/out`;
      const { storage, bash, asked } = setup(mode);

      await bash(command);
      expect(asked).toHaveLength(1);
      if (mode !== "normal") expect(asked[0]?.suppressAlwaysAllowRule).toBe(true);

      storage.addPathRule({ cwd, program: "rm", dir: `${cwd}/build` });
      expect(await bash(command)).toEqual(allowed({ command }));
      expect(asked).toHaveLength(1);
    }
  });
});

describe("a stored path rule does not cover", () => {
  const NOT_COVERED = [
    "mv -f /srv/data/x/a /srv/data/x/b",
    "rm -rf /srv/data/xy/a",
    "rm -rf /srv/data/x",
    "rm -rf /srv/data/x/a && ls",
    "cd /srv/data/x && rm -rf a",
    "rm -rf $DIR",
    "rm -rf /srv/data/x/../y",
    "rm -rf /srv/elsewhere/a",
  ];

  test("another program, another folder, a mixed chain, another project (normal: every one asks)", async () => {
    const { storage, bash, asked } = setup("normal");
    storage.addPathRule({ cwd, program: "rm", dir: "/srv/data/x" });
    storage.addPathRule({ cwd: "/other", program: "rm", dir: "/srv/elsewhere" });

    for (const command of NOT_COVERED) await bash(command);

    expect(commandsAsked(asked)).toEqual(NOT_COVERED);
  });

  test("the same in yolo: what asked before the rule still asks", async () => {
    const { storage, bash, asked } = setup("yolo");
    storage.addPathRule({ cwd, program: "rm", dir: "/srv/data/x" });
    const floorAsked = NOT_COVERED.filter((command) => command.includes("rm -rf"));

    for (const command of floorAsked) await bash(command);

    expect(commandsAsked(asked)).toEqual(floorAsked);
  });

  test("sudo or doas", async () => {
    for (const mode of MODES) {
      const { storage, bash, asked } = setup(mode);
      storage.addPathRule({ cwd, program: "rm", dir: "/tmp/x" });

      await bash("sudo rm -rf /tmp/x/y");
      await bash("doas rm -rf /tmp/x/y");

      expect(asked).toHaveLength(2);
      expect(asked[0]?.pathRule).toBeUndefined();
    }
  });
});

describe("a stored path rule never loosens a block", () => {
  test("a catastrophic command is blocked in every mode, whatever the rules", async () => {
    for (const mode of MODES) {
      const { storage, bash, asked } = setup(mode);
      storage.addPathRule({ cwd, program: "rm", dir: "/tmp" });
      storage.addPathRule({ cwd, program: "rm", dir: "/" });

      for (const command of ["rm -rf /", "rm -rf /tmp/x/a /", "rm -rf /*", "rm -rf ~"]) {
        expect(await bash(command)).toEqual({ behavior: "deny", message: expect.any(String) });
      }
      expect(asked).toEqual([]);
    }
  });
});

describe("asks Claude forces ignore path rules", () => {
  const forcedAsks: Array<[string, CallOptions]> = [
    ["matchedAskRule", { matchedAskRule: { source: "userSettings", toolName: "Bash", ruleContent: "rm:*" } }],
    ["defaultToNo", { defaultToNo: true } as CallOptions],
    ["blockedPath", { blockedPath: "/tmp/x" } as CallOptions],
  ];

  test("a stored rule does not allow them, and no choice is offered", async () => {
    for (const [, extra] of forcedAsks) {
      for (const mode of MODES) {
        const { storage, bash, asked } = setup(mode);
        storage.addPathRule({ cwd, program: "rm", dir: "/tmp/x" });

        await bash("rm -rf /tmp/x/y", extra);

        expect(asked).toHaveLength(1);
        expect(asked[0]?.pathRule).toBeUndefined();
      }
    }
  });

  test("a path answer to one stores nothing", async () => {
    for (const [, extra] of forcedAsks) {
      const { storage, bash } = setup("normal", pathAnswer("/tmp/x"));

      expect(await bash("rm -rf /tmp/x/y", extra)).toEqual(allowed({ command: "rm -rf /tmp/x/y" }));
      expect(storage.pathRulesFor(cwd)).toEqual([]);
    }
  });
});

describe("the ask offers the choice", () => {
  test("a path command carries the program and the folders to allow it under", async () => {
    const { bash, asked } = setup("normal");

    await bash("rm -rf /tmp/x/a /tmp/x/b");

    expect(asked).toHaveLength(1);
    expect(asked[0]?.pathRule).toEqual({ program: "rm", dirs: ["/tmp/x", "/tmp"] });
  });

  test("a floor ask offers it too, and still no always-allow", async () => {
    const { bash, asked } = setup("yolo");

    await bash(`rm -rf ${cwd}/build/out`);

    expect(asked[0]?.suppressAlwaysAllowRule).toBe(true);
    expect(asked[0]?.pathRule).toEqual({ program: "rm", dirs: [`${cwd}/build`, cwd, "/srv"] });
  });

  test("other commands and other tools carry no choice", async () => {
    const { bash, call, asked } = setup("normal");

    await bash("ls -la");
    await bash("rm /tmp/x/a && ls");
    await bash("sudo rm /tmp/x/a");
    await call("Edit", { file_path: "/tmp/x/a" });
    await call("Write", { file_path: "/tmp/x/a", command: "rm /tmp/x/a" });

    expect(asked).toHaveLength(5);
    expect(asked.every((ask) => ask.pathRule === undefined)).toBe(true);
  });

  test("without a store, none is offered", async () => {
    const { bash, asked } = setup("normal", "allow", { withStore: false });

    await bash("rm -rf /tmp/x/a");

    expect(asked[0]?.pathRule).toBeUndefined();
  });
});

describe("a path answer", () => {
  test("allows once, without Claude's own always-allow update, and stores the rule", async () => {
    for (const mode of MODES) {
      const { storage, bash, asked } = setup(mode, pathAnswer("/srv/data/x"));

      expect(await bash("rm -rf /srv/data/x/a", { suggestions: suggestionFor("rm -rf /srv/data/x/a") })).toEqual(
        allowed({ command: "rm -rf /srv/data/x/a" }),
      );
      expect(storage.pathRulesFor(cwd)).toEqual([{ cwd, program: "rm", dir: "/srv/data/x" }]);

      expect(await bash("rm -rf /srv/data/x/b/c")).toEqual(allowed({ command: "rm -rf /srv/data/x/b/c" }));
      expect(asked).toHaveLength(1);
    }
  });

  test("a folder that was not offered stores nothing", async () => {
    const { storage, bash } = setup("normal", pathAnswer("/"));

    expect(await bash("rm -rf /tmp/x/a")).toEqual(allowed({ command: "rm -rf /tmp/x/a" }));
    expect(storage.pathRulesFor(cwd)).toEqual([]);
  });

  test("a deny stores nothing and is refused", async () => {
    const { storage, bash } = setup("normal", "deny");

    expect(await bash("rm -rf /tmp/x/a")).toEqual({ behavior: "deny", message: "The user denied this tool call." });
    expect(storage.pathRulesFor(cwd)).toEqual([]);
  });

  test("always and allow answers store no path rule", async () => {
    for (const answer of ["allow", "always"] as const) {
      const { storage, bash } = setup("normal", answer);

      await bash("rm -rf /tmp/x/a");

      expect(storage.pathRulesFor(cwd)).toEqual([]);
    }
  });
});
