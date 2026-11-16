import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { previewPack, scanPack } from "./packs";

// A pack command with `questions` is marcsh's to run (a form), so the install preview says so, and says when its questions cannot work:
// a `Check:` line (a warning, never a rejection).

let src: string;

const write = (path: string, text: string) => {
  mkdirSync(dirname(join(src, path)), { recursive: true });
  writeFileSync(join(src, path), text);
};

const QUESTIONS = "questions:\n  - id: what\n    label: What?\n    kind: text\n    required: true";

beforeEach(() => {
  src = mkdtempSync(join(tmpdir(), "marcsh-pack-questions-"));
  write("agents/asdd.md", "---\nname: ASDD\npermission: build\n---\nSpec first.");
});

afterEach(() => rmSync(src, { recursive: true, force: true }));

const preview = async () => previewPack(src, { id: "acme/flows", commit: "a".repeat(40) }, await scanPack(src));

describe("the preview of a pack with question commands", () => {
  test("a command with questions and no agent is listed as running as the selected agent and asking", async () => {
    write("commands/start.md", `---\ndescription: Start\n${QUESTIONS}\n---\nDo {{what}}`);
    write("commands/plain.md", "---\ndescription: Plain\n---\nPlain");
    const result = await preview();
    expect(result.commands).toEqual(["plain", "start → the selected agent (asks questions)"]);
    expect(result.warnings).toEqual([]);
  });

  test("a command with an agent and questions says both", async () => {
    write("commands/spec.md", `---\nagent: asdd\n${QUESTIONS}\n---\nSpec {{what}}`);
    expect((await preview()).commands).toEqual(["spec → ASDD (asks questions)"]);
  });

  test("invalid questions are a warning, not a rejection, and the command is listed", async () => {
    write("commands/bad.md", "---\nquestions: nope\n---\nBad {{x}}");
    write("commands/ghost.md", `---\n${QUESTIONS}\n---\nUses {{ghost}}`);
    const result = await preview();
    expect(result.warnings).toEqual([
      "commands/bad.md: questions must be a list; it will not run",
      "commands/ghost.md: the prompt uses {{ghost}}, which names no question; it will not run",
    ]);
    expect(result.commands).toEqual(["bad → the selected agent (questions are invalid)", "ghost → the selected agent (questions are invalid)"]);
  });

  test("a skill's own questions key is not a command's: nothing is said", async () => {
    write("skills/s/SKILL.md", `---\nname: s\ndescription: d\n${QUESTIONS}\n---\nSkill`);
    const result = await preview();
    expect(result.warnings).toEqual([]);
  });
});
