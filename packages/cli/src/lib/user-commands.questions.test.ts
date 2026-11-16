import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MARCSH_DB_PATH = ":memory:";

const { loadAgents } = await import("./agents");
const { Mode } = await import("./modes");
const { loadUserCommands, userCommandTurn } = await import("./user-commands");

// Commands with question forms: a command whose frontmatter has `questions` is not sent as its template. `userCommandTurn` says what to
// ask (`form`), and a command whose questions are invalid loads (so it is never mistaken for the engine's copy) but says why it cannot run.

let root: string;
let personal: string;
let project: string;
let packs: string;
let agentsDir: string;

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

const QUESTIONS = ["questions:", "  - id: what", "    label: What to build?", "    kind: long", "    required: true", "  - id: area", "    label: Area", "    kind: text"].join("\n");
const START = `---\ndescription: Start a task\nargument-hint: "[what]"\n${QUESTIONS}\n---\nBuild this: {{what}}\nArea: {{area}}\nTyped: $ARGUMENTS`;

function installPack(id: string, { agents = {}, commands = {} }: { agents?: Record<string, string>; commands?: Record<string, string> }) {
  const [owner, repo] = id.split("/") as [string, string];
  for (const [file, text] of Object.entries(agents)) write(join(packs, owner, repo, "src", "agents", file), text);
  for (const [file, text] of Object.entries(commands)) {
    write(join(packs, owner, repo, "src", "commands", file), text);
    write(join(packs, owner, repo, "plugin", "commands", file), text);
  }
  write(join(packs, "packs.json"), JSON.stringify({ packs: [{ id, url: `https://github.com/${id}.git`, commit: "a".repeat(40), installedAt: "t" }] }));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-question-commands-")));
  personal = join(root, "home", "commands");
  project = join(root, "project");
  packs = join(root, "packs");
  agentsDir = join(root, "agents");
  mkdirSync(project, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  process.env.MARCSH_COMMANDS_DIR = personal;
});

afterEach(() => {
  delete process.env.MARCSH_COMMANDS_DIR;
  rmSync(root, { recursive: true, force: true });
});

const options = (selected?: string) => {
  const agents = loadAgents(agentsDir, packs);
  return { cwd: project, engine: "claude", trusted: false, agents, selected: agents.find((agent) => agent.id === (selected ?? "build")), builtinNames: ["new", "agents"], packsDir: packs };
};

describe("a command with questions", () => {
  test("loads with its questions, and stays an ordinary command otherwise", () => {
    write(join(personal, "start.md"), START);
    write(join(personal, "plain.md"), "Plain {{what}} $ARGUMENTS");
    const commands = loadUserCommands({ cwd: project, trusted: false, packsDir: packs });
    const start = commands.find((command) => command.name === "start")!;
    expect(start.questions?.map((question) => question.id)).toEqual(["what", "area"]);
    expect(start.invalid).toBeUndefined();
    expect(start.argumentHint).toBe("[what]");
    // Without a `questions` key a `{{x}}` is just text.
    expect(commands.find((command) => command.name === "plain")).toMatchObject({ template: "Plain {{what}} $ARGUMENTS" });
    expect(commands.find((command) => command.name === "plain")?.questions).toBeUndefined();
  });

  test("asks instead of sending: the turn carries the form, never the raw template", () => {
    write(join(personal, "start.md"), START);
    const turn = userCommandTurn("/start fix login", options())!;
    expect(turn.form).toMatchObject({ name: "start", args: "fix login", template: expect.stringContaining("{{what}}") });
    expect(turn.form!.questions.map((question) => question.id)).toEqual(["what", "area"]);
    // The text is not something to send.
    expect(turn.text).toBe("");
    expect(turn.error).toBeUndefined();
  });

  test("a command whose questions are invalid loads, says why it cannot run, and carries no form", () => {
    write(join(personal, "broken.md"), "---\nquestions:\n  - id: a\n    label: A\n    kind: text\n---\nUses {{a}} and {{ghost}}");
    const commands = loadUserCommands({ cwd: project, trusted: false, packsDir: packs });
    expect(commands.find((command) => command.name === "broken")?.invalid).toMatch(/names no question/);

    const turn = userCommandTurn("/broken", options())!;
    expect(turn.form).toBeUndefined();
    expect(turn.error).toBe("/broken: the prompt uses {{ghost}}, which names no question; nothing was sent.");
    expect(turn.text).toBe("");
  });

  test("an empty list of questions is no form: the command is sent, with its placeholders checked", () => {
    write(join(personal, "none.md"), "---\nquestions: []\n---\nJust $ARGUMENTS");
    const turn = userCommandTurn("/none go", options())!;
    expect(turn.form).toBeUndefined();
    expect(turn.text).toBe("Just go");
  });

  test("a project command asks too, once the project is trusted", () => {
    write(join(project, ".marcsh", "commands", "start.md"), START);
    expect(userCommandTurn("/start", { ...options(), trusted: true })?.form?.name).toBe("start");
    expect(userCommandTurn("/start", options())).toBeNull();
  });
});

describe("a pack command with questions", () => {
  const PACK_AGENTS = { "asdd.md": "---\nname: ASDD\n---\nSpec first." };

  test("runs in marcsh even without an agent, as the selected agent", () => {
    installPack("acme/flows", { agents: PACK_AGENTS, commands: { "start.md": START } });
    const commands = loadUserCommands({ cwd: project, trusted: false, packsDir: packs });
    expect(commands.find((command) => command.name === "start")).toMatchObject({ pack: "acme/flows", source: "pack", engineName: "acme-flows:start" });
    const turn = userCommandTurn("/start x", options())!;
    expect(turn.form?.name).toBe("start");
    expect(turn.agent).toBeUndefined();
    // The engine's copy answers to marcsh too: it is never run raw.
    expect(userCommandTurn("/acme-flows:start x", options())?.form?.name).toBe("start");
  });

  test("a pack command without questions and without an agent is still the engine's", () => {
    installPack("acme/flows", { agents: PACK_AGENTS, commands: { "plain.md": "---\ndescription: Plain\n---\nPlain" } });
    expect(loadUserCommands({ cwd: project, trusted: false, packsDir: packs }).map((command) => command.name)).not.toContain("plain");
  });

  test("a pack command with invalid questions and no agent is marcsh's too, so the raw template is never run", () => {
    installPack("acme/flows", { agents: PACK_AGENTS, commands: { "bad.md": "---\nquestions: nope\n---\nBad {{x}}" } });
    const turn = userCommandTurn("/bad", options())!;
    expect(turn.error).toBe("/bad: questions must be a list; nothing was sent.");
  });

  test("with an agent, the form runs as that agent; from Plan it stays read-only", () => {
    installPack("acme/flows", { agents: PACK_AGENTS, commands: { "spec.md": START.replace("description: Start a task", "description: Spec\nagent: asdd") } });
    const build = userCommandTurn("/spec x", options())!;
    expect(build.form?.name).toBe("spec");
    expect(build.agent).toMatchObject({ id: "acme/flows/asdd", mode: Mode.BUILD });

    const plan = userCommandTurn("/spec x", options("plan"))!;
    expect(plan.agent).toMatchObject({ id: "acme/flows/asdd", mode: Mode.PLAN });
    expect(plan.notice).toContain("read-only");
  });

  test("the pack's text is printable", () => {
    installPack("acme/flows", { agents: PACK_AGENTS, commands: { "start.md": START.replace("Start a task", "bad\u001b[31m red") } });
    const start = loadUserCommands({ cwd: project, trusted: false, packsDir: packs }).find((command) => command.name === "start")!;
    expect(start.description).not.toContain("\u001b");
  });
});
