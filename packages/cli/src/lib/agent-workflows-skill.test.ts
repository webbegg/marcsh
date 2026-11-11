import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Mode } from "./modes";
import { parseAgentFile } from "./agents";
import { marcshPluginPath } from "./plugin";

// The skill that teaches a user to author their own agent workflow (S14). It must say what agents.ts and packs.ts enforce.

const file = join(marcshPluginPath()!, "skills", "agent-workflows", "SKILL.md");
const text = () => readFileSync(file, "utf8");

describe("the agent-workflows skill", () => {
  test("is in marcsh's plugin with a name and a description that says when to use it", () => {
    expect(existsSync(file)).toBe(true);
    const match = /^---\n([\s\S]*?)\n---\n/.exec(text());
    expect(match).not.toBeNull();
    const fields = Object.fromEntries([...match![1]!.matchAll(/^([\w-]+):\s*(.*)$/gm)].map((line) => [line[1], line[2]]));
    expect(fields.name).toBe("agent-workflows");
    expect(fields.description).toMatch(/\S/);
    expect(fields.description).toMatch(/^Use this/);
  });

  test("keeps its body short enough to read in one go", () => {
    expect(text().split("\n").length).toBeLessThanOrEqual(250);
  });

  test("its complete example is a primary agent marcsh applies in full", () => {
    const example = /```markdown\n([\s\S]*?)\n```/.exec(text());
    expect(example).not.toBeNull();

    const agent = parseAgentFile(example![1]!, { pack: "user", file: "example.md" });

    expect(agent).not.toBeNull();
    expect(agent!.ignored).toEqual([]);
    expect(agent!.name).toBeTruthy();
    expect(agent!.description).toBeTruthy();
    expect(agent!.prompt).toBeTruthy();
    expect(agent!.mode).toBe(Mode.PLAN);
  });

  test("names where a personal agent lives and the three ways to run a pack command", () => {
    const body = text();
    expect(body).toContain("~/.marcsh/agents/");
    expect(body).toContain("/agents install owner/repo[@ref]");
    expect(body).toContain("/agents update");
    expect(body).toContain("/agents remove");
  });

  test("names every field and value of the agent file", () => {
    const body = text();
    for (const word of ["name", "description", "mode", "primary", "subagent", "permission", "read-only", "build", "model", "provider/id"]) {
      expect(body).toContain(word);
    }
  });

  test("names every layout path of a pack", () => {
    const body = text();
    for (const path of ["agents/", "skills/<name>/SKILL.md", "skills/*.md", "commands/*.md", ".claude-plugin/plugin.json", "owner/repo/<file stem>"]) {
      expect(body).toContain(path);
    }
  });

  test("names every rule packs.ts rejects a pack for", () => {
    const body = text();
    for (const phrase of ["symlink", "1 MB", "256 KB", "5,000 entries", "50 MB", "hooks", "`...`", "allowed-tools", "primary agent", "MCP"]) {
      expect(body).toContain(phrase);
    }
  });

  test("rejects an agent file whose frontmatter is never closed, and says which models Claude takes [R3-002, R3-003]", () => {
    const body = text();
    expect(body).toContain("An agent file whose frontmatter is never closed");
    for (const word of ["claude-", "opus", "sonnet", "haiku", "gpt-4o"]) expect(body).toContain(word);
  });

  test("says Esc cancels an install while it is fetching", () => {
    expect(text()).toMatch(/Esc[^.]*(cancels|stops)[^.]*fetch/i);
  });

  test("says skills and commands load only while the pack's agent is selected", () => {
    expect(text()).toMatch(/only while[^.]*agent[^.]*selected/i);
  });
});
