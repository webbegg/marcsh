import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MARCSH_DB_PATH = ":memory:";

const { BUILTIN_AGENTS, loadAgents } = await import("./agents");
const { loadCommandSet, loadUserCommands, takePackCommandNotices, userCommandTurn } = await import("./user-commands");

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
    // It loses the clash, so it is reachable under its pack's repository name.
    expect(load().find((command) => command.name === "flows:new")?.pack).toBe("acme/flows");
  });

  test("two packs with the same command: the first pack by ID keeps the name; the user's own command wins over any pack's", () => {
    expect(load().find((command) => command.name === "spec")?.pack).toBe("acme/flows");
    expect(load().find((command) => command.name === "tools:spec")?.pack).toBe("other/tools");
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

describe("engine commands beat pack commands (L5)", () => {
  const withEngine = (engineNames: string[]) => loadUserCommands({ cwd: project, trusted: false, builtinNames: ["new", "agents"], engineNames, packsDir: packs });
  const turnOptions = (engine: string, engineNames: string[]) => ({
    cwd: project,
    engine,
    trusted: false,
    agents: loadAgents(agentsDir, packs),
    builtinNames: ["new", "agents"],
    engineNames,
    packsDir: packs,
  });

  beforeEach(() => {
    takePackCommandNotices();
    write(join(packs, "acme", "flows", "plugin", "commands", "review.md"), "---\ndescription: Review the spec\nagent: asdd\n---\nReview: $ARGUMENTS");
  });

  test("Claude's built-in /review keeps its name: the pack's /review is listed as /flows:review, and /review goes to Claude as typed", () => {
    const commands = withEngine(["review", "compact", "acme-flows:review"]);
    expect(commands.find((command) => command.name === "review")).toBeUndefined();
    expect(commands.find((command) => command.name === "flows:review")).toMatchObject({ pack: "acme/flows", engineName: "acme-flows:review", description: "Review the spec" });

    expect(userCommandTurn("/review the diff", turnOptions("claude", ["review"]))).toBeNull();
    const turn = userCommandTurn("/flows:review the diff", turnOptions("claude", ["review"]))!;
    expect(turn.text).toBe("Review: the diff");
    expect(turn.agent?.id).toBe("acme/flows/asdd");
  });

  test("on pi, a prompt template (or extension command) with the same name keeps it too", () => {
    expect(userCommandTurn("/spec x", turnOptions("pi", ["spec", "skill:specify"]))).toBeNull();
    expect(userCommandTurn("/flows:spec x", turnOptions("pi", ["spec"]))?.agent?.id).toBe("acme/flows/asdd");
    // The other pack's spec, which already lost to acme/flows, keeps its own prefixed name.
    expect(userCommandTurn("/tools:spec", turnOptions("pi", ["spec"]))?.text).toBe("Other spec");
  });

  test("an engine name in another letter case is the same name", () => {
    expect(withEngine(["Review"]).map((command) => command.name)).toContain("flows:review");
  });

  test("a pack command that clashes with nothing is unchanged", () => {
    const ftd = withEngine(["review", "spec"]).find((command) => command.pack === "acme/flows" && command.agent === "Fast Track")!;
    expect(ftd.name).toBe("ftd");
    expect(userCommandTurn("/ftd x", turnOptions("claude", ["review"]))?.agent?.id).toBe("acme/flows/ftd");
    expect(takePackCommandNotices()).toEqual([]);
  });

  test("when the prefixed name is taken as well, the command is hidden and a notice names the clash, once", () => {
    const names = withEngine(["review", "flows:review"]).map((command) => command.name);
    expect(names).not.toContain("review");
    expect(names).not.toContain("flows:review");
    expect(takePackCommandNotices()).toEqual(["acme/flows's /review is hidden: /review and /flows:review are already other commands."]);
    withEngine(["review", "flows:review"]);
    expect(takePackCommandNotices()).toEqual([]);
  });

  // After the notice test: a clash is said once per run.
  test("a hidden command's engine copy is not listed by its name and typing that name runs marcsh's command, never the raw copy (T8 d)", () => {
    const { commands, hidden } = loadCommandSet({ cwd: project, trusted: false, builtinNames: ["new", "agents"], engineNames: ["review", "flows:review"], packsDir: packs });
    expect(commands.map((command) => command.name)).not.toContain("acme-flows:review");
    expect(hidden.map((command) => command.engineName)).toEqual(["acme-flows:review"]);
    const turn = userCommandTurn("/acme-flows:review x", turnOptions("claude", ["review", "flows:review"]))!;
    expect(turn.text).toBe("Review: x");
    expect(turn.agent?.id).toBe("acme/flows/asdd");
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

  test("an empty agent (`agent:` or `agent: \"\"`) warns and stays marcsh's command, run as the selected agent (T8 a)", () => {
    write(join(packs, "acme", "flows", "plugin", "commands", "blank.md"), "---\nagent:\n---\nBlank: $ARGUMENTS");
    write(join(packs, "acme", "flows", "plugin", "commands", "quoted.md"), '---\nagent: ""\n---\nQuoted: $ARGUMENTS');
    for (const name of ["blank", "quoted"]) {
      expect(load().find((command) => command.name === name), name).toMatchObject({ pack: "acme/flows", agent: "" });
      const turn = userCommandTurn(`/${name} it`, base())!;
      expect(turn.agent, name).toBeUndefined();
      expect(turn.text).toContain("it");
      expect(turn.warning).toBe(`/${name}: acme/flows names no agent (its agent: is empty); the selected agent is used.`);
    }
  });

  test("with a read-only agent selected, a pack command naming a build agent runs as that agent in plan, with a notice (T8 c, L6)", () => {
    const plan = BUILTIN_AGENTS.find((agent) => agent.id === "plan")!;
    const turn = userCommandTurn("/spec x", { ...base(), selected: plan })!;
    expect(turn.agent).toMatchObject({ id: "acme/flows/asdd", mode: "PLAN", prompt: "Spec first." });
    expect(turn.notice).toBe("/spec runs as ASDD in Plan (read-only): switch to Build to let it change files.");
    expect(turn.warning).toBeUndefined();

    // A read-only pack agent selected is read-only too.
    const reviewer = { ...plan, id: "acme/flows/reviewer", name: "Reviewer" };
    expect(userCommandTurn("/spec x", { ...base(), selected: reviewer })!.agent?.mode).toBe("PLAN");

    // From a build agent, nothing changes.
    const build = BUILTIN_AGENTS.find((agent) => agent.id === "build")!;
    const fromBuild = userCommandTurn("/spec x", { ...base(), selected: build })!;
    expect(fromBuild.agent).toMatchObject({ id: "acme/flows/asdd", mode: "BUILD" });
    expect(fromBuild.notice).toBeUndefined();
    // A command that names Plan from Plan says nothing.
    expect(userCommandTurn("/plan x", { ...base(), selected: plan })!.notice).toBeUndefined();
  });

  // R1-3: a pack command never widens the selected agent's tools: its agent runs with the selected agent's denials added.
  test("the selected agent's denied tools stay denied when a pack command runs as another agent", () => {
    const build = BUILTIN_AGENTS.find((agent) => agent.id === "build")!;
    const narrowed = { ...build, id: "user/no-shell", name: "No shell", tools: { deny: ["bash" as const] } };
    const toPack = userCommandTurn("/spec x", { ...base(), selected: narrowed })!;
    expect(toPack.agent).toMatchObject({ id: "acme/flows/asdd", mode: "BUILD" });
    expect(toPack.agent?.tools?.deny).toEqual(["bash"]);

    // A command that names Build, from an agent without edits: still without edits.
    write(join(packs, "acme", "flows", "plugin", "commands", "tobuild.md"), "---\nagent: build\n---\nBuild: $ARGUMENTS");
    const noEdit = { ...build, id: "acme/flows/reviewer", name: "Reviewer", pack: "acme/flows", tools: { deny: ["edit" as const] } };
    const toBuild = userCommandTurn("/tobuild x", { ...base(), selected: noEdit })!;
    expect(toBuild.agent?.id).toBe("build");
    expect(toBuild.agent?.tools?.deny).toEqual(["edit"]);

    // Both deny: the union, each once.
    const both = userCommandTurn("/tobuild x", { ...base(), selected: { ...noEdit, tools: { deny: ["edit" as const, "bash" as const] } } })!;
    expect([...(both.agent?.tools?.deny ?? [])].sort()).toEqual(["bash", "edit"]);

    // From an agent that denies nothing, the command's agent is unchanged.
    expect(userCommandTurn("/spec x", { ...base(), selected: build })!.agent?.tools).toBeUndefined();
  });

  test("the agents list without the pack's agents (none loaded) warns rather than guessing", () => {
    const turn = userCommandTurn("/spec x", { ...base(), agents: BUILTIN_AGENTS })!;
    expect(turn.agent).toBeUndefined();
    expect(turn.warning).toContain("acme/flows has no agent “asdd”");
  });
});
