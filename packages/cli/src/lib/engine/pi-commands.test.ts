import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripFrontmatter, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { getMenuCommands } from "../../components/command-menu/filter-commands";
import { marcshPluginPath } from "../plugin";
import { bundledPiCommands, expandPluginInvocation, normalizePiCommands, toMenuCommands } from "./pi-commands";

const PLUGIN = "/opt/marcsh/plugin";

function info(name: string, source: SlashCommandInfo["source"], path = `/home/me/.marcsh/agent/${name}.ts`, description?: string): SlashCommandInfo {
  return { name, source, description, sourceInfo: { path, source: "local", scope: "user", origin: "top-level" } };
}

describe("normalizePiCommands", () => {
  test("keeps extension commands, prompt templates and skills with their source tag", () => {
    const commands = normalizePiCommands([
      info("deploy", "extension", undefined, "Ship it"),
      info("review", "prompt", undefined, "Review a file"),
      info("skill:pdf", "skill", undefined, "Read PDFs"),
    ]);

    expect(commands.map(({ name, source, description }) => ({ name, source, description }))).toEqual([
      { name: "deploy", source: "extension", description: "Ship it" },
      { name: "review", source: "prompt", description: "Review a file" },
      { name: "skill:pdf", source: "skill", description: "Read PDFs" },
    ]);
  });

  test("a missing description is empty and the argument hint is empty (pi lists none)", () => {
    const [command] = normalizePiCommands([info("bare", "prompt")]);

    expect(command).toMatchObject({ name: "bare", description: "", argumentHint: "" });
  });

  test("skips entries without a usable name or a known source, and strips a leading slash", () => {
    const commands = normalizePiCommands([
      info("", "prompt"),
      info("   ", "prompt"),
      info("/slashed", "prompt"),
      { ...info("odd", "prompt"), source: "builtin" as never },
      null as never,
    ]);

    expect(commands.map((c) => c.name)).toEqual(["slashed"]);
  });

  test("on the same name an extension command wins over a template, and a template over a skill", () => {
    const commands = normalizePiCommands([
      info("go", "skill", undefined, "from the skill"),
      info("go", "prompt", undefined, "from the template"),
      info("go", "extension", undefined, "from the extension"),
    ]);

    expect(commands.map((c) => [c.name, c.source, c.description])).toEqual([["go", "extension", "from the extension"]]);
  });

  test("the plugin's template and skill take the Claude names marcsh:feature and marcsh:workflow", () => {
    const commands = normalizePiCommands(
      [
        info("feature", "prompt", `${PLUGIN}/commands/feature.md`, "Create or resume the feature doc"),
        info("skill:workflow", "skill", `${PLUGIN}/skills/workflow/SKILL.md`, "Pick the lane"),
        info("feature-notes", "prompt", `${PLUGIN}-other/commands/feature-notes.md`),
      ],
      PLUGIN,
    );

    expect(commands.map((c) => [c.name, c.invoke, c.source])).toEqual([
      ["marcsh:feature", "feature", "prompt"],
      ["feature-notes", "feature-notes", "prompt"],
      ["marcsh:workflow", "skill:workflow", "skill"],
    ]);
  });

  test("without a plugin path nothing is renamed", () => {
    const [command] = normalizePiCommands([info("feature", "prompt", `${PLUGIN}/commands/feature.md`)]);

    expect(command).toMatchObject({ name: "feature", invoke: "feature" });
  });

  test("toMenuCommands drops what pi needs to run a command and keeps the rest", () => {
    const list = toMenuCommands(normalizePiCommands([info("deploy", "extension", undefined, "Ship it")]));

    expect(list).toEqual([{ name: "deploy", description: "Ship it", argumentHint: "", source: "extension" }]);
  });
});

describe("the / menu entries of a pi session", () => {
  test("show the pi source, after marcsh's own commands", () => {
    const menu = getMenuCommands(toMenuCommands(normalizePiCommands([info("deploy", "extension"), info("skill:pdf", "skill")])));

    expect(menu.slice(-2).map((c) => [c.name, c.source])).toEqual([
      ["deploy", "extension"],
      ["skill:pdf", "skill"],
    ]);
    expect(menu[0]!.name).toBe("new");
    expect(menu[0]!.source).toBeUndefined();
  });

  test("a pi command named like one of marcsh's own loses to it, in any letter case", () => {
    const menu = getMenuCommands(toMenuCommands(normalizePiCommands([info("new", "prompt", undefined, "pi's new"), info("Models", "extension"), info("mine", "prompt")])));

    expect(menu.filter((c) => c.name.toLowerCase() === "new").map((c) => c.description)).toEqual(["Start a new conversation"]);
    expect(menu.filter((c) => c.name.toLowerCase() === "models")).toHaveLength(1);
    expect(menu.filter((c) => c.source === "prompt").map((c) => c.name)).toEqual(["mine"]);
  });

  test("commands without a source keep the claude tag", () => {
    const menu = getMenuCommands([{ name: "review", description: "", argumentHint: "" }]);

    expect(menu.at(-1)).toMatchObject({ name: "review", source: "claude" });
  });
});

describe("bundledPiCommands", () => {
  test("lists the marcsh plugin's feature command as a prompt and its workflow skill as a skill, read from disk", () => {
    const commands = bundledPiCommands(marcshPluginPath()!);

    expect(commands.map((c) => [c.name, c.source])).toEqual([
      ["marcsh:feature", "prompt"],
      ["marcsh:agent-workflows", "skill"],
      ["marcsh:workflow", "skill"],
    ]);
    expect(commands[0]!.argumentHint).toBe("<feature-name>");
    expect(commands.every((c) => c.description.length > 0)).toBe(true);
  });

  test("is empty without a plugin", () => {
    expect(bundledPiCommands("/nonexistent/marcsh/plugin")).toEqual([]);
  });
});

// marcsh expands its plugin's /marcsh:... entries itself, so a user's own `feature` template or `workflow` skill
// (which pi would pick for the plain name) cannot hide them.
describe("expandPluginInvocation", () => {
  const withPlugin = (run: (root: string) => void) => {
    const root = mkdtempSync(join(tmpdir(), "marcsh-expand-"));
    try {
      mkdirSync(join(root, "commands"));
      mkdirSync(join(root, "skills", "folder"), { recursive: true });
      writeFileSync(join(root, "commands", "echo.md"), "---\ndescription: Echo\n---\nA:$1|B:$2|ALL:$ARGUMENTS|AT:$@|D:${3:-dflt}|S:${@:2}|L:${@:2:1}|X:$9\n");
      writeFileSync(join(root, "skills", "folder", "SKILL.md"), "---\nname: skillname\ndescription: A skill\n---\n\n# Body\n\nDo it.\n");
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const expand = (text: string, root: string | null) => expandPluginInvocation(text, root, stripFrontmatter);

  test("a plugin command expands like a pi prompt template: $1.., $@, $ARGUMENTS, defaults, slices, quoted arguments", () => {
    withPlugin((root) => {
      expect(expand('/marcsh:echo one "two words" ', root)).toBe("A:one|B:two words|ALL:one two words|AT:one two words|D:dflt|S:two words|L:two words|X:");
      expect(expand("/marcsh:echo", root)).toBe("A:|B:|ALL:|AT:|D:dflt|S:|L:|X:");
      expect(expand("/marcsh:echo\n  a\nb", root)).toBe("A:a|B:b|ALL:a b|AT:a b|D:dflt|S:b|L:b|X:");
    });
  });

  test("the real feature command gets its arguments and nothing else of pi's name resolution", () => {
    const text = expand("/marcsh:feature my-feature", marcshPluginPath());

    expect(text).toContain("Create or resume the feature doc named `my-feature`.");
    expect(text).not.toContain("$ARGUMENTS");
    expect(text).not.toContain("argument-hint");
  });

  test("a plugin skill expands like pi's /skill:<name>: a <skill> block with its location, base dir and the arguments after it", () => {
    withPlugin((root) => {
      const file = join(root, "skills", "folder", "SKILL.md");
      const block = `<skill name="skillname" location="${file}">\nReferences are relative to ${join(root, "skills", "folder")}.\n\n# Body\n\nDo it.\n</skill>`;

      expect(expand("/marcsh:skillname fix the bug\nnow  ", root)).toBe(`${block}\n\nfix the bug\nnow`);
      expect(expand("/marcsh:skillname", root)).toBe(block);
      expect(expand("/marcsh:skillname   ", root)).toBe(block);
    });
  });

  test("leaves every other text as typed", () => {
    withPlugin((root) => {
      for (const text of [
        "/deploy prod",
        "/feature already-pi-name",
        "/skill:skillname x",
        "/marcsh:echox",
        "/marcsh:unknown a b",
        "/marcsh:folder",
        "hello /marcsh:echo",
        " /marcsh:echo",
        "plain text",
        "",
      ]) {
        expect(expand(text, root)).toBe(text);
      }
    });
  });

  test("without a plugin, or with one that cannot be read, the text is left as typed", () => {
    expect(expand("/marcsh:feature x", null)).toBe("/marcsh:feature x");
    expect(expand("/marcsh:feature x", "/nonexistent/marcsh/plugin")).toBe("/marcsh:feature x");
  });
});
