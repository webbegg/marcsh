import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  askQuestions,
  composeRequest,
  missingRequired,
  prefillFromArguments,
  questionDefault,
  readFacts,
  readQuestions,
  readTestScript,
  type CommandQuestion,
  type QuestionForm,
  type QuestionUi,
} from "./command-questions";

// Questions of a command (frontmatter `questions`): parsing, the typed arguments, the facts the defaults use, the prompt that is composed
// and the loop that asks. The composer and the loop follow brigadev's workflows (lib/workflow-run.ts).

const question = (id: string, extra: Partial<CommandQuestion> = {}): CommandQuestion => ({ id, label: `Label ${id}`, kind: "text", required: false, ...extra });
const form = (template: string, questions: CommandQuestion[], name = "sample"): QuestionForm => ({ name, template, questions });

describe("readQuestions", () => {
  const file = (frontmatter: string, body = "Body") => ({ text: `---\n${frontmatter}\n---\n${body}`, body });
  const read = (frontmatter: string, body = "Body") => {
    const { text, body: template } = file(frontmatter, body);
    return readQuestions(text, template);
  };

  test("a file without a questions key has none to read", () => {
    expect(read("description: x")).toBeNull();
    expect(readQuestions("Just a prompt", "Just a prompt")).toBeNull();
    expect(readQuestions("---\ndescription: x\n", "")).toBeNull();
  });

  test("reads every field of a question, with the indentation the flat reader loses", () => {
    const result = read(
      [
        "description: Start",
        "questions:",
        "  - id: route",
        '    label: "Which route?"',
        "    kind: text",
        "    required: true",
        "  - id: auth",
        "    label: Authentication",
        "    kind: choice",
        '    options: ["Public", "Signed in"]',
        '    default: "Signed in"',
        "  - id: base",
        "    label: Base branch",
        "    kind: long",
        '    default: "{{defaultBranch}}"',
      ].join("\n"),
      "{{route}} {{auth}} {{base}}",
    );
    expect(result).toEqual({
      questions: [
        { id: "route", label: "Which route?", kind: "text", required: true },
        { id: "auth", label: "Authentication", kind: "choice", required: false, options: ["Public", "Signed in"], default: "Signed in" },
        { id: "base", label: "Base branch", kind: "long", required: false, default: "{{defaultBranch}}" },
      ],
    });
  });

  test("an empty questions key is a list of none", () => {
    expect(read("questions:")).toEqual({ questions: [] });
    expect(read("questions: []")).toEqual({ questions: [] });
  });

  test.each([
    ["questions: nope", /questions must be a list/],
    ["questions:\n  - just text", /question 1 is not a map/],
    ["questions:\n  - id: Bad Id\n    label: x\n    kind: text", /question 1 needs an id/],
    ["questions:\n  - id: a\n    kind: text", /question "a" needs a label/],
    ["questions:\n  - id: a\n    label: x\n    kind: number", /question "a" has kind "number"; use text, long, or choice/],
    ["questions:\n  - id: a\n    label: x\n    kind: choice\n    options: [only]", /question "a" is a choice and needs at least two options/],
    ["questions:\n  - id: a\n    label: x\n    kind: choice\n    options: [one, two]\n    default: three", /question "a" default must be one of its options/],
    ['questions:\n  - id: a\n    label: x\n    kind: text\n    default: "{{nope}}"', /question "a" default uses unknown fact "nope"/],
    ["questions:\n  - id: a\n    label: x\n    kind: text\n    default: {{currentBranch}}", /default must be text|not valid YAML/],
    ["questions:\n  - id: a\n    label: x\n    kind: text\n  - id: a\n    label: y\n    kind: text", /duplicate question id "a"/],
  ])("%j is invalid", (frontmatter, message) => {
    const result = read(frontmatter);
    expect(result && "error" in result ? result.error : "").toMatch(message);
  });

  test("a placeholder that names no question makes it invalid", () => {
    const result = read("questions:\n  - id: a\n    label: x\n    kind: text", "Use {{a}} and {{ghost}}");
    expect(result).toEqual({ error: 'the prompt uses {{ghost}}, which names no question' });
  });

  test("YAML that does not parse is invalid, not a throw", () => {
    const result = read("questions:\n  - id: [unclosed");
    expect(result && "error" in result ? result.error : "").toMatch(/not valid YAML/);
  });
});

describe("questionDefault", () => {
  test("fills fact placeholders and drops the default when a fact is missing", () => {
    const q = question("target", { default: "{{currentBranch}} against {{defaultBranch}}" });
    expect(questionDefault(q, { currentBranch: "feat/x", defaultBranch: "main" })).toBe("feat/x against main");
    expect(questionDefault(q, { currentBranch: "feat/x", defaultBranch: null })).toBeUndefined();
    expect(questionDefault(question("n", { default: "origin" }), {})).toBe("origin");
    expect(questionDefault(question("n"), {})).toBeUndefined();
  });
});

describe("composeRequest", () => {
  const w = form("Plan the work.\n- What: {{what}}\n- Area: {{area}}\n- Ticket: {{ticket}}", [question("what", { required: true }), question("area"), question("ticket")]);

  test("quotes every answer verbatim", () => {
    const text = composeRequest(w, { what: 'Add a {{ticket}} thing "quoted" & $HOME $1', area: "src/a.ts", ticket: "ABC-1" }, {});
    expect(text).toContain('- What: Add a {{ticket}} thing "quoted" & $HOME $1');
    expect(text).toContain("- Area: src/a.ts");
    expect(text).toContain("- Ticket: ABC-1");
  });

  test("block-quotes a multi-line answer line by line", () => {
    expect(composeRequest(w, { what: "line one\n\nline three", area: "a" }, {})).toContain("- What:\n> line one\n>\n> line three\n- Area: a");
  });

  test("a blank line of a multi-line answer renders as a bare > and \\r\\n becomes \\n", () => {
    const text = composeRequest(w, { what: "a\r\n\r\nb", area: "x\r\ny" }, {});
    expect(text).not.toContain("\r");
    expect(text).not.toMatch(/> $/m);
    expect(text).toBe("Plan the work.\n- What:\n> a\n>\n> b\n- Area:\n> x\n> y");
  });

  test("a cleared answer (kept as an empty string) is skipped and does not fall back to the default; an absent one does", () => {
    const d = form("Start\nBase: {{base}}", [question("base", { default: "x" })]);
    expect(composeRequest(d, { base: "" }, {})).toBe("Start");
    expect(composeRequest(d, {}, {})).toBe("Start\nBase: x");
    const r = form("{{v}}", [question("v", { required: true, default: "x" })]);
    expect(missingRequired(r.questions, { v: "" }, {}).map((q) => q.id)).toEqual(["v"]);
  });

  test("omits the lines of skipped optional answers", () => {
    expect(composeRequest(w, { what: "x", area: "  " }, {})).toBe("Plan the work.\n- What: x");
  });

  test("keeps the provided answers of a line when only some of its placeholders are skipped", () => {
    const two = form("Start\nWhere: {{a}} / Ticket: {{b}}\nOther: {{c}}", [question("a"), question("b"), question("c")]);
    expect(composeRequest(two, { a: "x" }, {})).toBe("Start\nWhere: x / Ticket:");
    expect(composeRequest(two, { b: "T-1" }, {})).toBe("Start\nWhere: / Ticket: T-1");
    expect(composeRequest(two, { a: "x", b: "T-1" }, {})).toBe("Start\nWhere: x / Ticket: T-1");
    // Only a line whose placeholders are all skipped is left out.
    expect(composeRequest(two, {}, {})).toBe("Start");
  });

  test("puts a multi-line answer on its own quoted lines and the trailing text after the quote", () => {
    const t = form("- What: {{what}} (required)\n  - Nested: {{what}} done\n- Plain: {{what}}", [question("what")]);
    expect(composeRequest(t, { what: "a\nb" }, {})).toBe("- What:\n> a\n> b\n(required)\n  - Nested:\n  > a\n  > b\n  done\n- Plain:\n> a\n> b");
    expect(composeRequest(t, { what: "one" }, {})).toBe("- What: one (required)\n  - Nested: one done\n- Plain: one");
  });

  test("falls back to the default built from the facts", () => {
    const d = form("Start\nBase: {{base}}", [question("base", { default: "{{defaultBranch}}" })]);
    expect(composeRequest(d, {}, { defaultBranch: "main" })).toBe("Start\nBase: main");
    expect(composeRequest(d, { base: "develop" }, { defaultBranch: "main" })).toBe("Start\nBase: develop");
    expect(composeRequest(d, {}, {})).toBe("Start");
  });

  test("refuses a request with an empty required answer, naming the question", () => {
    expect(missingRequired(w.questions, { what: "  ", area: "a" }, {}).map((q) => q.id)).toEqual(["what"]);
    expect(() => composeRequest(w, { area: "a" }, {})).toThrow(/required.*what/);
  });

  test("a required question with a default is satisfied by the default", () => {
    const d = form("{{v}}", [question("v", { required: true, default: "{{testScript}}" })]);
    expect(missingRequired(d.questions, {}, { testScript: "npm test" })).toEqual([]);
    expect(missingRequired(d.questions, {}, {}).map((q) => q.id)).toEqual(["v"]);
  });

  test("$ARGUMENTS and $1..$9 expand as typed in the same pass: nothing is expanded twice", () => {
    const t = form("Ask: $ARGUMENTS\nFirst: $1 second: $2 fourth: [$4]\nAnswer: {{a}}", [question("a")]);
    // An answer that looks like an argument stays as typed, and so does an argument that looks like a placeholder.
    expect(composeRequest(t, { a: "costs $1 and $ARGUMENTS" }, {}, "fix {{a}} now")).toBe("Ask: fix {{a}} now\nFirst: fix second: {{a}} fourth: []\nAnswer: costs $1 and $ARGUMENTS");
  });

  test("a line whose answers were all skipped goes even when it also has an argument; one without answers stays", () => {
    const t = form("Top\nWith args: $ARGUMENTS and {{a}}\nPlain: $ARGUMENTS", [question("a")]);
    expect(composeRequest(t, {}, {}, "x")).toBe("Top\nPlain: x");
  });
});

/** A scripted UI: each call takes the next reply; titles and prefills are recorded. */
function scripted(replies: Array<string | undefined>) {
  const calls: Array<{ kind: string; title: string; arg?: string | string[] }> = [];
  const next = (kind: string, title: string, arg?: string | string[]) => {
    calls.push({ kind, title, arg });
    if (replies.length === 0) throw new Error(`unexpected ${kind} "${title}"`);
    return Promise.resolve(replies.shift());
  };
  const ui: QuestionUi = { select: (title, options) => next("select", title, options), input: (title, placeholder) => next("input", title, placeholder), editor: (title, prefill) => next("editor", title, prefill) };
  return { ui, calls };
}

describe("askQuestions", () => {
  const w = form("{{a}}{{b}}{{c}}{{d}}", [
    question("a", { required: true }),
    question("b", { kind: "long" }),
    question("c", { kind: "choice", options: ["one", "two", "three"], default: "two" }),
    question("d", { default: "{{defaultBranch}}" }),
  ]);

  test("asks in order with the right control for each kind and returns the answers", async () => {
    const { ui, calls } = scripted(["answer a", "long\nanswer", "three", "develop"]);
    const answers = await askQuestions(w, { defaultBranch: "main" }, ui);
    expect(answers).toEqual({ a: "answer a", b: "long\nanswer", c: "three", d: "develop" });
    expect(calls.map((c) => c.kind)).toEqual(["input", "editor", "select", "input"]);
    expect(calls[0]!.title).toMatch(/^Label a/);
    expect(calls[1]!.title).toMatch(/optional/);
  });

  test("offers the default first in a choice and as the placeholder of a text question", async () => {
    const { ui, calls } = scripted(["a", "", "two", ""]);
    const answers = await askQuestions(w, { defaultBranch: "main" }, ui);
    expect(calls[2]!.arg).toEqual(["two", "one", "three"]);
    expect(calls[3]!.arg).toBe("main");
    expect(answers).toEqual({ a: "a", c: "two", d: "main" });
  });

  test("passes current answers as the defaults when editing", async () => {
    const { ui, calls } = scripted(["", "", "one", ""]);
    const answers = await askQuestions(w, { defaultBranch: "main" }, ui, { current: { a: "first", b: "was long", c: "one", d: "x" } });
    expect(calls[0]!.arg).toBe("first");
    expect(calls[1]!.arg).toBe("was long");
    expect(calls[2]!.arg?.[0]).toBe("one");
    expect(calls[3]!.arg).toBe("x");
    // Clearing the editor prefill of an optional long question that had an answer clears it (kept as empty).
    expect(answers).toEqual({ a: "first", b: "", c: "one", d: "x" });
  });

  test("lets an optional text answer be cleared with a literal dash when editing", async () => {
    const { ui, calls } = scripted(["-", "-", "one", "-"]);
    const answers = await askQuestions(w, {}, ui, { current: { a: "first", b: "was long", c: "one", d: "x" } });
    // Required a: the dash is an ordinary answer. Optional text d: cleared. Long b: no dash rule.
    expect(answers?.a).toBe("-");
    expect(answers?.b).toBe("-");
    expect(answers?.d).toBe("");
    expect(calls[0]!.title).not.toMatch(/clears/);
    expect(calls[3]!.title).toMatch(/\(optional, "-" clears\)/);

    // Without a previous answer there is nothing to clear and the title does not mention it.
    const first = scripted(["a", "", "two", "-"]);
    const fresh = await askQuestions(w, {}, first.ui);
    expect(first.calls[3]!.title).toMatch(/\(optional\)$/);
    expect(fresh?.d).toBe("-");
  });

  test("offers (no answer) last on an optional choice that has a previous answer, and only then", async () => {
    const opt = form("{{c}}", [question("c", { kind: "choice", options: ["one", "two"] })]);
    const clear = scripted(["(no answer)"]);
    expect(await askQuestions(opt, {}, clear.ui, { current: { c: "two" } })).toEqual({ c: "" });
    expect(clear.calls[0]!.arg).toEqual(["two", "one", "(no answer)"]);

    const keep = scripted(["one"]);
    expect(await askQuestions(opt, {}, keep.ui, { current: { c: "two" } })).toEqual({ c: "one" });

    const fresh = scripted(["one"]);
    await askQuestions(opt, {}, fresh.ui);
    expect(fresh.calls[0]!.arg).toEqual(["one", "two"]);

    const required = form("{{c}}", [question("c", { kind: "choice", required: true, options: ["one", "two"] })]);
    const req = scripted(["two"]);
    await askQuestions(required, {}, req.ui, { current: { c: "one" } });
    expect(req.calls[0]!.arg).toEqual(["one", "two"]);
  });

  test("composes after a clear: the cleared optional answer is left out instead of coming back as the default", async () => {
    const t = form("Start\nNote: {{n}}\nKind: {{k}}", [question("n", { default: "x" }), question("k", { kind: "choice", options: ["one", "two"], default: "two" })]);
    const first = scripted(["", "two"]);
    const answers = await askQuestions(t, {}, first.ui);
    expect(composeRequest(t, answers!, {})).toBe("Start\nNote: x\nKind: two");
    const edit = scripted(["-", "(no answer)"]);
    const cleared = await askQuestions(t, {}, edit.ui, { current: answers });
    expect(composeRequest(t, cleared!, {})).toBe("Start");
    // A long question with a default, emptied in the editor, is cleared too.
    const long = form("Start\nNote: {{n}}", [question("n", { kind: "long", default: "x" })]);
    const emptied = await askQuestions(long, {}, scripted([""]).ui);
    expect(composeRequest(long, emptied!, {})).toBe("Start");
  });

  test("cancels everything when any question is escaped", async () => {
    const { ui } = scripted(["a", undefined]);
    expect(await askQuestions(w, {}, ui)).toBeUndefined();
  });

  test("re-asks an empty required answer once with a hint, then cancels", async () => {
    const retry = scripted(["  ", "now filled", "", "one", ""]);
    const answers = await askQuestions(w, {}, retry.ui);
    expect(answers?.a).toBe("now filled");
    expect(retry.calls[1]!.title).toMatch(/required/);
    expect(retry.calls[0]!.title === retry.calls[1]!.title).toBe(false);

    const giveUp = scripted(["", " "]);
    expect(await askQuestions(w, {}, giveUp.ui)).toBeUndefined();
    expect(giveUp.calls.length).toBe(2);
  });

  test("presets (the typed arguments) are shown like a default and replace it, without being answers on their own", async () => {
    const { ui, calls } = scripted(["", "", "three", ""]);
    const answers = await askQuestions(w, { defaultBranch: "main" }, ui, { presets: { a: "typed", c: "three" } });
    expect(calls[0]!.arg).toBe("typed");
    expect(calls[2]!.arg).toEqual(["three", "one", "two"]);
    // Accepting the shown text takes it; a choice the user picks is the answer.
    expect(answers).toEqual({ a: "typed", c: "three", d: "main" });
    // Nothing offers "clear": a preset is not an earlier answer.
    expect(calls[3]!.title).toMatch(/\(optional\)$/);
  });
});

describe("prefillFromArguments", () => {
  const qs = [question("what", { kind: "long" }), question("kind", { kind: "choice", options: ["Story", "Bug"] }), question("name")];

  test("non-empty arguments prefill the first text or long question", () => {
    expect(prefillFromArguments([question("c", { kind: "choice", options: ["a", "b"] }), question("t"), question("u")], "fix the login")).toEqual({ t: "fix the login" });
    expect(prefillFromArguments(qs, "  fix the login  ")).toEqual({ what: "fix the login" });
  });

  test("they also preselect the first choice they match, in any case", () => {
    expect(prefillFromArguments(qs, "bug")).toEqual({ what: "bug", kind: "Bug" });
    expect(prefillFromArguments([qs[1]!], "STORY")).toEqual({ kind: "Story" });
  });

  test("they do not preselect a choice they do not match, and nothing is prefilled by empty arguments", () => {
    expect(prefillFromArguments([qs[1]!], "something else")).toEqual({});
    expect(prefillFromArguments(qs, "")).toEqual({});
    expect(prefillFromArguments(qs, "   ")).toEqual({});
  });
});

describe("facts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marcsh-facts-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      stdio: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });

  test("reads scripts.test from package.json and nothing when it is missing or unreadable", () => {
    expect(readTestScript(dir)).toBeUndefined();
    writeFileSync(join(dir, "package.json"), "{ not json");
    expect(readTestScript(dir)).toBeUndefined();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    expect(readTestScript(dir)).toBeUndefined();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    expect(readTestScript(dir)).toBe("package.json test script: node --test");
  });

  test("reads the current and the default branch from local git, and the test script", () => {
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    git("add", "-A");
    git("commit", "-q", "-m", "c");
    git("checkout", "-q", "-b", "feat/x");
    expect(readFacts(dir)).toEqual({ currentBranch: "feat/x", defaultBranch: "main", testScript: "package.json test script: bun test" });
  });

  test("origin/HEAD names the default branch when there is one", () => {
    git("init", "-q", "-b", "develop");
    git("commit", "-q", "--allow-empty", "-m", "c");
    git("update-ref", "refs/remotes/origin/develop", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    git("checkout", "-q", "-b", "work");
    expect(readFacts(dir)).toMatchObject({ currentBranch: "work", defaultBranch: "develop" });
  });

  test("with both main and master and no origin, the default branch is unknown", () => {
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "c");
    git("branch", "master");
    expect(readFacts(dir).defaultBranch).toBeNull();
  });

  test("leaves facts out when there is no git or no folder", () => {
    mkdirSync(join(dir, "plain"));
    expect(readFacts(join(dir, "plain"))).toEqual({ currentBranch: null, defaultBranch: null, testScript: undefined });
    expect(readFacts(join(dir, "missing"))).toEqual({ currentBranch: null, defaultBranch: null, testScript: undefined });
  });
});
