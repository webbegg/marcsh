import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MARCSH_DB_PATH = ":memory:";

const { BUILTIN_AGENTS, loadAgents } = await import("./agents");
const { loadUserCommands, userCommandTurn } = await import("./user-commands");

// M2: a pack's `commands/*.md` that names an `agent` is marcsh's to run: listed while the pack is installed, expanded by marcsh, and
// run for one turn as that agent of the same pack (or a built-in).

let root: string;
let personal: string;
let project: string;
let packs: string;
let agentsDir: string;

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

/** An installed pack as marcsh lays it out: the lock entry, the clone's agents and the generated view's commands. */
function installPack(id: string, { agents = {}, commands = {} }: { agents?: Record<string, string>; commands?: Record<string, string> }) {
  const [owner, repo] = id.split("/") as [string, string];
  for (const [file, text] of Object.entries(agents)) write(join(packs, owner, repo, "src", "agents", file), text);
  for (const [file, text] of Object.entries(commands)) {
    write(join(packs, owner, repo, "src", "commands", file), text);
    write(join(packs, owner, repo, "plugin", "commands", file), text);
  }
}

function lock(ids: string[]) {
  write(join(packs, "packs.json"), JSON.stringify({ packs: ids.map((id) => ({ id, url: `https://github.com/${id}.git`, commit: "a".repeat(40), installedAt: "t" })) }));
}

const SPEC = '---\ndescription: Write a spec for an idea\nagent: asdd\nargument-hint: "[spec slug]"\n---\nSpec this: $ARGUMENTS (first word $1)\n';

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-pack-commands-")));
  personal = join(root, "home", "commands");
  project = join(root, "project");
  packs = join(root, "packs");
  agentsDir = join(root, "agents");
  mkdirSync(project, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  process.env.MARCSH_COMMANDS_DIR = personal;
  installPack("acme/flows", {
    agents: { "asdd.md": "---\nname: ASDD\n---\nSpec first.", "ftd.md": "---\nname: Fast Track\n---\nTest first.", "refuter.md": "---\nmode: subagent\n---\nRefute." },
    commands: {
      "spec.md": SPEC,
      "ftd.md": "---\ndescription: Fast track\nagent: Fast Track\nargument-hint: <what to change>\n---\nFTD: $ARGUMENTS",
      "plan.md": "---\nagent: plan\n---\nPlan only: $ARGUMENTS",
      "upper.md": "---\nagent: ASDD\n---\nx",
      "foreign.md": "---\nagent: other/tools/helper\n---\nForeign: $ARGUMENTS",
      "mine.md": "---\nagent: mine\n---\nMine: $ARGUMENTS",
      "nobody.md": "---\nagent: nobody\n---\nNobody: $ARGUMENTS",
      "sub.md": "---\nagent: refuter\n---\nSub: $ARGUMENTS",
      "plain.md": "---\ndescription: No agent\n---\nPlain $ARGUMENTS",
      "new.md": "---\nagent: asdd\n---\nShadow the built-in",
    },
  });
  installPack("other/tools", { agents: { "helper.md": "Help." }, commands: { "spec.md": "---\nagent: helper\n---\nOther spec", "tool.md": "---\nagent: helper\n---\nTool $ARGUMENTS" } });
  writeFileSync(join(agentsDir, "mine.md"), "---\nname: Mine\n---\nMy prompt.");
  lock(["acme/flows", "other/tools"]);
});

afterEach(() => {
  delete process.env.MARCSH_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true });
});

const load = () => loadUserCommands({ cwd: project, trusted: false, builtinNames: ["new", "agents"], packsDir: packs });

describe("loadUserCommands: pack commands (M2)", () => {
  test("a pack command that names an agent is listed with its pack, description and argument hint (quotes stripped)", () => {
    const spec = load().find((command) => command.name === "spec")!;
    expect(spec).toMatchObject({
      name: "spec",
      description: "Write a spec for an idea",
      agent: "asdd",
      argumentHint: "[spec slug]",
      source: "pack",
      pack: "acme/flows",
      engineName: "acme-flows:spec",
    });
    expect(load().find((command) => command.name === "ftd")?.argumentHint).toBe("<what to change>");
  });

  test("a pack command without an agent is left to the engine, as before; a built-in name is never a pack command", () => {
    const names = load().map((command) => command.name);
    expect(names).not.toContain("plain");
    expect(names).not.toContain("new");
  });

  test("two packs with the same command: the first pack by ID keeps the name; the user's own command wins over any pack's", () => {
    expect(load().find((command) => command.name === "spec")?.pack).toBe("acme/flows");
    expect(load().find((command) => command.name === "tool")?.pack).toBe("other/tools");

    write(join(personal, "spec.md"), "My own spec $ARGUMENTS");
    const spec = load().find((command) => command.name === "spec")!;
    expect(spec.source).toBe("personal");
    expect(spec.pack).toBeUndefined();
  });

  test("a pack that is no longer installed has no commands", () => {
    lock(["other/tools"]);
    expect(load().filter((command) => command.pack === "acme/flows")).toEqual([]);
  });

  test("a link in the view's commands is not read (a pack is third-party content), and names and hints are printable", () => {
    const outside = join(root, "outside.md");
    writeFileSync(outside, "---\nagent: asdd\n---\nsecret");
    symlinkSync(outside, join(packs, "acme", "flows", "plugin", "commands", "linked.md"));
    write(join(packs, "acme", "flows", "plugin", "commands", "esc.md"), "---\nagent: asdd\ndescription: bad\u001b[31m red\nargument-hint: <x\u001b[0m>\n---\nx");

    const commands = load();
    expect(commands.map((command) => command.name)).not.toContain("linked");
    const esc = commands.find((command) => command.name === "esc")!;
    expect(esc.description).not.toContain("\u001b");
    expect(esc.argumentHint).not.toContain("\u001b");
  });
});

describe("userCommandTurn: pack commands run as their pack's agent (M2)", () => {
  const base = () => ({ cwd: project, engine: "claude", trusted: false, agents: loadAgents(agentsDir, packs), builtinNames: ["new", "agents"], packsDir: packs });

  test("the agent is the pack's, by file name (any case) or by name, and the template is expanded by marcsh's rules", () => {
    const turn = userCommandTurn("/spec offline mode", base())!;
    expect(turn.text).toBe("Spec this: offline mode (first word offline)\n".trim());
    expect(turn.agent?.id).toBe("acme/flows/asdd");
    expect(turn.agent?.pluginDir).toBe(join(packs, "acme", "flows", "plugin"));
    expect(turn.warning).toBeUndefined();

    expect(userCommandTurn("/ftd x", base())?.agent?.id).toBe("acme/flows/ftd");
    expect(userCommandTurn("/upper", base())?.agent?.id).toBe("acme/flows/asdd");
  });

  test("a built-in agent (Build, Plan) may be named", () => {
    expect(userCommandTurn("/plan x", base())?.agent?.id).toBe("plan");
  });

  test("an agent of another pack, one of the user's, a subagent or an unknown one warns and runs as the selected agent", () => {
    for (const [name, agent] of [
      ["foreign", "other/tools/helper"],
      ["mine", "mine"],
      ["sub", "refuter"],
      ["nobody", "nobody"],
    ] as const) {
      const turn = userCommandTurn(`/${name} it`, base())!;
      expect(turn.agent, name).toBeUndefined();
      expect(turn.text).toContain("it");
      expect(turn.warning).toBe(`/${name}: acme/flows has no agent “${agent}”; the selected agent is used.`);
    }
  });

  test("the name the engine knows the pack's copy by runs marcsh's expansion too, so the engine's copy never runs", () => {
    const turn = userCommandTurn("/acme-flows:spec x", base())!;
    expect(turn.agent?.id).toBe("acme/flows/asdd");
    expect(turn.text).toContain("Spec this: x");
  });

  test("a pack command without an agent is not marcsh's: it goes to the engine as typed", () => {
    expect(userCommandTurn("/plain x", base())).toBeNull();
    expect(userCommandTurn("/new", base())).toBeNull();
  });

  test("the agents list without the pack's agents (none loaded) warns rather than guessing", () => {
    const turn = userCommandTurn("/spec x", { ...base(), agents: BUILTIN_AGENTS })!;
    expect(turn.agent).toBeUndefined();
    expect(turn.warning).toContain("acme/flows has no agent “asdd”");
  });
});
