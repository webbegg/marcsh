import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { marcshPluginPath } from "./plugin";

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

describe("plugin contents", () => {
  const path = marcshPluginPath()!;

  test("plugin.json names the plugin marcsh", () => {
    const manifest = JSON.parse(readFileSync(join(path, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBe("marcsh");
    expect(manifest.version).toBe("0.1.0");
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
