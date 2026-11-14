import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { marcshPluginPath, readPluginCommands, readPluginEntries } from "./plugin";

const CLI_ROOT = join(import.meta.dir, "..", "..");

// Returns the frontmatter fields of a markdown file as a flat key → value map.
function frontmatter(file: string): Record<string, string> {
  const match = readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---\n/);
  expect(match).not.toBeNull();
  const fields: Record<string, string> = {};
  for (const line of match![1]!.split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return fields;
}

describe("marcshPluginPath", () => {
  test("resolves the plugin directory from the sources", () => {
    expect(marcshPluginPath()).toBe(join(CLI_ROOT, "plugin"));
  });

  test("resolves it from the built dist directory too", () => {
    expect(marcshPluginPath(join(CLI_ROOT, "dist"))).toBe(join(CLI_ROOT, "plugin"));
  });

  test("returns null when no candidate has a manifest", () => {
    expect(marcshPluginPath("/nonexistent/marcsh/dir")).toBeNull();
    expect(marcshPluginPath(tmpdir())).toBeNull();
  });
});

describe("readPluginCommands", () => {
  const commands = readPluginCommands(marcshPluginPath()!);
  const find = (name: string) => commands.find((command) => command.name === name);

  test("lists the feature command as marcsh:feature with its description and argument hint", () => {
    const feature = find("marcsh:feature");
    expect(feature).toBeDefined();
    expect(feature!.argumentHint).toBe("<feature-name>");
    expect(feature!.description).toBe(frontmatter(join(marcshPluginPath()!, "commands", "feature.md")).description!);
    expect(feature!.description.length).toBeGreaterThan(0);
  });

  test("lists the workflow skill as marcsh:workflow with its description", () => {
    const workflow = find("marcsh:workflow");
    expect(workflow).toBeDefined();
    expect(workflow!.argumentHint).toBe("");
    expect(workflow!.description).toBe(frontmatter(join(marcshPluginPath()!, "skills", "workflow", "SKILL.md")).description!);
  });

  test("returns [] for a missing or empty directory", () => {
    expect(readPluginCommands("/nonexistent/marcsh/plugin")).toEqual([]);
    expect(readPluginCommands(tmpdir())).toEqual([]);
  });

  test("reads quoted values, falls back to the file or folder name, and skips unreadable entries", () => {
    const root = mkdtempSync(join(tmpdir(), "marcsh-plugin-"));
    try {
      mkdirSync(join(root, "commands"));
      mkdirSync(join(root, "skills", "plain"), { recursive: true });
      mkdirSync(join(root, "skills", "empty"), { recursive: true });
      writeFileSync(join(root, "commands", "quoted.md"), '---\ndescription: "Say \'hi\'"\nargument-hint: \'<who>\'\n---\nbody\n');
      writeFileSync(join(root, "commands", "bare.md"), "no frontmatter\n");
      writeFileSync(join(root, "commands", "notes.txt"), "ignored");
      writeFileSync(join(root, "skills", "plain", "SKILL.md"), "---\nname: renamed\ndescription: A skill\n---\n");

      expect(readPluginCommands(root).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: "marcsh:bare", description: "", argumentHint: "" },
        { name: "marcsh:quoted", description: "Say 'hi'", argumentHint: "<who>" },
        { name: "marcsh:renamed", description: "A skill", argumentHint: "" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readPluginEntries", () => {
  test("tells the command from the skill and gives the file or folder name each is known by", () => {
    const entries = readPluginEntries(marcshPluginPath()!);

    expect(entries.map((entry) => [entry.name, entry.kind, entry.id])).toEqual([
      ["marcsh:feature", "command", "feature"],
      ["marcsh:agent-workflows", "skill", "agent-workflows"],
      ["marcsh:workflow", "skill", "workflow"],
    ]);
  });

  test("gives the file each entry was read from", () => {
    const path = marcshPluginPath()!;

    expect(readPluginEntries(path).map((entry) => entry.file)).toEqual([
      join(path, "commands", "feature.md"),
      join(path, "skills", "agent-workflows", "SKILL.md"),
      join(path, "skills", "workflow", "SKILL.md"),
    ]);
  });

  test("a command is known by its file name and a skill by its name field, whatever the Claude name says", () => {
    const root = mkdtempSync(join(tmpdir(), "marcsh-plugin-"));
    try {
      mkdirSync(join(root, "commands"));
      mkdirSync(join(root, "skills", "folder"), { recursive: true });
      writeFileSync(join(root, "commands", "file.md"), "---\nname: shown\ndescription: A command\n---\n");
      writeFileSync(join(root, "skills", "folder", "SKILL.md"), "---\nname: skillname\ndescription: A skill\n---\n");

      expect(readPluginEntries(root).map((entry) => [entry.name, entry.kind, entry.id])).toEqual([
        ["marcsh:shown", "command", "file"],
        ["marcsh:skillname", "skill", "skillname"],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("readPluginCommands lists the same entries without the extra fields", () => {
    const path = marcshPluginPath()!;

    expect(readPluginCommands(path)).toEqual(
      readPluginEntries(path).map(({ name, description, argumentHint }) => ({ name, description, argumentHint })),
    );
  });
});

describe("plugin contents", () => {
  const path = marcshPluginPath()!;

  test("plugin.json names the plugin marcsh", () => {
    const manifest = JSON.parse(readFileSync(join(path, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBe("marcsh");
    // The plugin ships inside marcsh, so it carries marcsh's version.
    const cli = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"));
    expect(manifest.version).toBe(cli.version);
    expect(typeof manifest.description).toBe("string");
    expect(manifest.description.length).toBeGreaterThan(0);
  });

  test("the workflow skill has a name and a description", () => {
    const fields = frontmatter(join(path, "skills", "workflow", "SKILL.md"));
    expect(fields.name).toBe("workflow");
    expect(fields.description!.length).toBeGreaterThan(20);
  });

  test("the feature command has a description and an argument hint", () => {
    const fields = frontmatter(join(path, "commands", "feature.md"));
    expect(fields.description!.length).toBeGreaterThan(0);
    expect(fields["argument-hint"]).toBe("<feature-name>");
    expect(readFileSync(join(path, "commands", "feature.md"), "utf8")).toContain("$ARGUMENTS");
  });

  test("hooks.json runs the guard on Bash and the script exists", () => {
    const config = JSON.parse(readFileSync(join(path, "hooks", "hooks.json"), "utf8"));
    const entries = config.hooks.PreToolUse;
    expect(entries).toHaveLength(1);
    expect(entries[0].matcher).toBe("Bash");
    // Runs from the plugin root so a project's bunfig.toml preload cannot corrupt the hook JSON.
    expect(entries[0].hooks).toEqual([
      { type: "command", command: 'cd "${CLAUDE_PLUGIN_ROOT}" && bun "${CLAUDE_PLUGIN_ROOT}/hooks/guard.ts"' },
    ]);
    expect(existsSync(join(path, "hooks", "guard.ts"))).toBe(true);
    expect(existsSync(join(path, "hooks", "guard-lib.ts"))).toBe(true);
  });
});
