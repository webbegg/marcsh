import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../components/command-menu/commands";
import { PERMISSIONS_USAGE } from "../components/command-menu/permissions-command";
import { APPROVAL_MODES } from "../lib/approval-policy";
import { PACK_USAGE, parsePackCommand } from "../lib/pack-command";
import { marcshPluginPath, readPluginEntries } from "../lib/plugin";

// packages/cli/src/docs -> repository root
const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const DOC = join(ROOT, "docs", "commands.md");

const doc = existsSync(DOC) ? readFileSync(DOC, "utf8") : "";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasHeading = (name: string) => new RegExp(`^### /${escape(name)}\\s*$`, "m").test(doc);
const headings = () => [...doc.matchAll(/^### \/(\S+)\s*$/gm)].map((match) => match[1]!);

// pack-command.ts exports no list of its verbs, so they are repeated here. The checks below fail when the parser stops
// accepting one of them or starts to advertise another in its usage line.
const PACK_VERBS = ["install", "update", "remove", "hooks"] as const;

// The input bar handles `/queue` outside the command menu and keeps its pattern private, so this name cannot be read from the code:
// it is the one heading that no list in the code backs.
const INPUT_BAR_COMMANDS = ["queue"];

// The commands and skills of marcsh's bundled plugin are in the menu as `marcsh:<name>`.
const pluginNames = () => readPluginEntries(marcshPluginPath()!).map((entry) => entry.name);

describe("docs/commands.md", () => {
  test("exists", () => {
    expect(existsSync(DOC)).toBe(true);
  });

  test("has a '### /name' heading for every command in the command menu", () => {
    const missing = COMMANDS.map((command) => command.name).filter((name) => !hasHeading(name));
    expect(missing).toEqual([]);
  });

  test("has a heading for /queue, which the input bar handles outside the menu", () => {
    for (const name of INPUT_BAR_COMMANDS) expect(hasHeading(name)).toBe(true);
  });

  test("has a '### /marcsh:name' heading for every bundled command and skill", () => {
    expect(pluginNames().length).toBeGreaterThan(0);
    const missing = pluginNames().filter((name) => !hasHeading(name));
    expect(missing).toEqual([]);
  });

  test("has no heading for a command that no longer exists", () => {
    const known = [...COMMANDS.map((command) => command.name), ...INPUT_BAR_COMMANDS, ...pluginNames()];
    expect(headings().filter((name) => !known.includes(name))).toEqual([]);
  });

  test("mentions every /agents subcommand the parser accepts", () => {
    const missing = PACK_VERBS.filter((verb) => !doc.includes(`/agents ${verb}`));
    expect(missing).toEqual([]);
  });

  test("quotes the usage line exactly as the parser prints it", () => {
    expect(doc).toContain(PACK_USAGE);
  });

  test("describes /permissions: every mode, the default form and the usage line exactly as the parser prints it", () => {
    for (const mode of APPROVAL_MODES) expect(doc).toContain(`\`${mode}\``);
    expect(doc).toContain("/permissions default <normal|auto|yolo>");
    expect(doc).toContain(PERMISSIONS_USAGE);
  });

  test("says /permissions auto and yolo are paused off a feature branch", () => {
    expect(doc).toContain("is paused here");
    expect(doc).toContain("feature branch");
    expect(doc).toContain("worktree");
  });

  test("the list of /agents subcommands matches the parser", () => {
    for (const verb of PACK_VERBS) {
      expect(parsePackCommand(`${verb} acme/flows`).kind).not.toBe("usage");
      expect(PACK_USAGE).toContain(verb);
    }
    // The usage line names exactly these verbs.
    const advertised = [...PACK_USAGE.matchAll(/(?:^|\| |: \/agents )(\w+)(?= |$)/g)].map((match) => match[1]);
    expect(advertised.sort()).toEqual([...PACK_VERBS].sort());
  });
});
