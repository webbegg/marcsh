import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MARCSH_DB_PATH = ":memory:";

const { getStorage } = await import("./storage");
const { PLAN_AGENT_ID, BUILTIN_AGENTS } = await import("./agents");
const { expandCommand, loadUserCommands, parseInvocation, userCommandTurn, userCommandsDir } = await import("./user-commands");

let root: string;
let personal: string;
let project: string;

const write = (dir: string, file: string, text: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), text);
};
const personalFile = (file: string, text: string) => write(personal, file, text);
const projectFile = (file: string, text: string) => write(join(project, ".marcsh", "commands"), file, text);
const names = (commands: { name: string }[]) => commands.map((command) => command.name);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-user-commands-")));
  personal = join(root, "home", "commands");
  project = join(root, "project");
  mkdirSync(project, { recursive: true });
  process.env.MARCSH_COMMANDS_DIR = personal;
});

afterEach(() => {
  delete process.env.MARCSH_COMMANDS_DIR;
  getStorage().setProjectTrust(project, null);
  rmSync(root, { recursive: true, force: true });
});

describe("where the files are read from", () => {
  test("the personal folder is ~/.marcsh/commands unless MARCSH_COMMANDS_DIR says otherwise", () => {
    expect(userCommandsDir()).toBe(personal);
    delete process.env.MARCSH_COMMANDS_DIR;
    expect(userCommandsDir()).toMatch(/\.marcsh[\\/]commands$/);
  });
});

describe("loadUserCommands (S7)", () => {
  test("every .md file becomes a command named after the file, with its frontmatter and body", () => {
    personalFile(
      "review.md",
      "---\ndescription: Review the diff\nagent: reviewer\nmodel: haiku\n---\nReview $ARGUMENTS carefully.\n",
    );

    const [command, ...rest] = loadUserCommands({ cwd: project, trusted: false });

    expect(rest).toEqual([]);
    expect(command).toMatchObject({
      name: "review",
      description: "Review the diff",
      agent: "reviewer",
      model: "haiku",
      template: "Review $ARGUMENTS carefully.",
      source: "personal",
    });
  });

  test("a file with no frontmatter is all prompt; its description is the first line of the body", () => {
    personalFile("plain.md", "\nSummarize the repo.\nBe brief.\n");

    expect(loadUserCommands({ cwd: project, trusted: false })).toMatchObject([
      { name: "plain", description: "Summarize the repo.", template: "Summarize the repo.\nBe brief." },
    ]);
  });

  test("names must match [a-z0-9][a-z0-9-_:]*; the others are skipped", () => {
    for (const file of ["ok.md", "a-b_c.md", "v2:x.md", "9lives.md", "Upper.md", "-lead.md", "_lead.md", "has space.md", "dot.name.md", ".hidden.md", "notes.txt"]) {
      personalFile(file, "body");
    }

    expect(names(loadUserCommands({ cwd: project, trusted: false }))).toEqual(["9lives", "a-b_c", "ok", "v2:x"]);
  });

  test("a file with no prompt, a folder named like a command, and a missing folder are skipped without an error", () => {
    personalFile("empty.md", "---\ndescription: nothing\n---\n   \n");
    mkdirSync(join(personal, "folder.md"));

    expect(loadUserCommands({ cwd: project, trusted: false })).toEqual([]);
    rmSync(personal, { recursive: true });
    expect(loadUserCommands({ cwd: project, trusted: true })).toEqual([]);
  });

  test("built-in command names win over personal and project commands", () => {
    personalFile("new.md", "personal new");
    personalFile("fine.md", "personal fine");
    projectFile("new.md", "project new");

    const commands = loadUserCommands({ cwd: project, trusted: true, builtinNames: ["new", "exit"] });

    expect(names(commands)).toEqual(["fine"]);
  });

  test("a project command overrides a personal one with the same name", () => {
    personalFile("ship.md", "---\ndescription: personal\n---\nPersonal ship");
    personalFile("only-personal.md", "p");
    projectFile("ship.md", "---\ndescription: project\n---\nProject ship");
    projectFile("only-project.md", "q");

    const commands = loadUserCommands({ cwd: project, trusted: true });

    expect(commands.map((c) => [c.name, c.source, c.template])).toEqual([
      ["only-personal", "personal", "p"],
      ["only-project", "project", "q"],
      ["ship", "project", "Project ship"],
    ]);
  });

  test("an untrusted project loads no project commands; personal ones still load", () => {
    personalFile("mine.md", "mine");
    projectFile("theirs.md", "theirs");
    projectFile("mine.md", "project mine");

    const commands = loadUserCommands({ cwd: project, trusted: false });

    expect(commands.map((c) => [c.name, c.source])).toEqual([["mine", "personal"]]);
  });

  test("trust is read from the trust store when not given: undecided and untrusted skip the project, trusted loads it", () => {
    projectFile("theirs.md", "theirs");

    expect(names(loadUserCommands({ cwd: project }))).toEqual([]);
    getStorage().setProjectTrust(project, "untrusted");
    expect(names(loadUserCommands({ cwd: project }))).toEqual([]);
    getStorage().setProjectTrust(project, "trusted");
    expect(names(loadUserCommands({ cwd: project }))).toEqual(["theirs"]);
  });

  test("a project command that is a symlink is not followed", () => {
    write(root, "secret.txt", "secret");
    mkdirSync(join(project, ".marcsh", "commands"), { recursive: true });
    symlinkSync(join(root, "secret.txt"), join(project, ".marcsh", "commands", "leak.md"));
    projectFile("real.md", "real");

    expect(names(loadUserCommands({ cwd: project, trusted: true }))).toEqual(["real"]);
  });
});

describe("expandCommand (S7)", () => {
  test("$ARGUMENTS is everything after the command name", () => {
    expect(expandCommand("Fix: $ARGUMENTS (now)", "the  login\nbug")).toBe("Fix: the  login\nbug (now)");
  });

  test("$1..$9 are the whitespace-separated words; a missing one is empty", () => {
    expect(expandCommand("[$1] [$2] [$3] [$9]", "  alpha   beta ")).toBe("[alpha] [beta] [] []");
    expect(expandCommand("$1$2$3$4$5$6$7$8$9", "a b c d e f g h i j")).toBe("abcdefghi");
  });

  test("with no arguments, every placeholder is empty", () => {
    expect(expandCommand("a $ARGUMENTS b $1 c", "")).toBe("a  b  c");
  });

  test("a template with no placeholder is returned as it is, and $0, $10 and a lone $ are not placeholders", () => {
    expect(expandCommand("Just do it. $0 $ $x", "ignored")).toBe("Just do it. $0 $ $x");
    expect(expandCommand("$10", "a b")).toBe("a0");
  });

  test("arguments are inserted as text: a placeholder inside them is not expanded again", () => {
    expect(expandCommand("$1 / $ARGUMENTS", "$2 $ARGUMENTS")).toBe("$2 / $2 $ARGUMENTS");
  });
});

describe("parseInvocation (S7)", () => {
  test("splits a typed /name from its arguments", () => {
    expect(parseInvocation("/review src/app.ts  now")).toEqual({ name: "review", args: "src/app.ts  now" });
    expect(parseInvocation("/review")).toEqual({ name: "review", args: "" });
    expect(parseInvocation("/review\nline one\nline two")).toEqual({ name: "review", args: "line one\nline two" });
  });

  test("text that is not a command name is not an invocation", () => {
    expect(parseInvocation("review it")).toBeNull();
    expect(parseInvocation("/Review")).toBeNull();
    expect(parseInvocation("/")).toBeNull();
    expect(parseInvocation("//review")).toBeNull();
  });
});

describe("userCommandTurn (S7)", () => {
  const agents = [
    ...BUILTIN_AGENTS,
    { id: "user/reviewer", name: "Reviewer", mode: "PLAN" as const, ignored: [] },
  ];
  // `project` is a new folder for each test.
  const base = () => ({ cwd: project, engine: "claude", agents, builtinNames: ["new"] });

  test("is null for text that is not one of the user's commands", () => {
    personalFile("review.md", "Review $ARGUMENTS");

    expect(userCommandTurn("hello there", base())).toBeNull();
    expect(userCommandTurn("/unknown x", base())).toBeNull();
    expect(userCommandTurn("/new", base())).toBeNull();
  });

  test("expands the template into the prompt to send", () => {
    personalFile("review.md", "Review $1 then $ARGUMENTS");

    expect(userCommandTurn("/review a.ts b.ts", base())).toEqual({ text: "Review a.ts then a.ts b.ts" });
  });

  test("the agent field picks an agent by ID or name for that turn; an unknown one warns and is ignored", () => {
    personalFile("by-id.md", "---\nagent: user/reviewer\n---\nx");
    personalFile("by-name.md", "---\nagent: REVIEWER\n---\nx");
    personalFile("builtin.md", `---\nagent: ${PLAN_AGENT_ID}\n---\nx`);
    personalFile("nobody.md", "---\nagent: nobody\n---\nx");

    expect(userCommandTurn("/by-id", base())?.agent?.id).toBe("user/reviewer");
    expect(userCommandTurn("/by-name", base())?.agent?.id).toBe("user/reviewer");
    expect(userCommandTurn("/builtin", base())?.agent?.id).toBe(PLAN_AGENT_ID);
    const unknown = userCommandTurn("/nobody", base())!;
    expect(unknown.agent).toBeUndefined();
    expect(unknown.warning).toBe("/nobody: no agent named “nobody”; the selected agent is used.");
  });

  test("the model field is used when the engine can use it; otherwise it warns and is ignored", () => {
    personalFile("fast.md", "---\nmodel: haiku\n---\nx");
    personalFile("other.md", "---\nmodel: openai/gpt-5\n---\nx");

    expect(userCommandTurn("/fast", base())).toEqual({ text: "x", model: "haiku" });
    expect(userCommandTurn("/fast", { ...base(), engine: "pi" })?.model).toBeUndefined();
    expect(userCommandTurn("/other", { ...base(), engine: "pi" })?.model).toBe("openai/gpt-5");
    expect(userCommandTurn("/other", base())).toEqual({
      text: "x",
      warning: "/other: the model “openai/gpt-5” does not fit this engine; the session model is used.",
    });
  });

  test("a project command is used only in a trusted project", () => {
    projectFile("deploy.md", "Deploy $ARGUMENTS");

    expect(userCommandTurn("/deploy now", base())).toBeNull();
    getStorage().setProjectTrust(project, "trusted");
    expect(userCommandTurn("/deploy now", base())).toEqual({ text: "Deploy now" });
  });
});
