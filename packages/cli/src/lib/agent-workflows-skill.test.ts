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
    // The example uses `tools` (S15): it is applied, so it is neither ignored nor unknown.
    expect(agent!.tools).toBeDefined();
    expect(agent!.unknownTools).toEqual([]);
  });

  test("explains the tools field: both forms, the groups, narrowing only, ask never removed [S15]", () => {
    const body = text();
    expect(body).toContain("| `tools` |");
    for (const word of ["bash: false", "tools: Read, Grep", "read", "edit", "bash", "web", "task", "ask", "mcp", "unknown"]) {
      expect(body).toContain(word);
    }
    expect(body).toMatch(/never (adds|widens)|only (removes|narrows)|cannot (add|widen)/i);
    expect(body).toMatch(/ask[^.]*never removed|never removes[^.]*ask/i);
    expect(body).not.toContain("Per-agent tool lists are not supported");
    expect(body).not.toContain("(`tools`, `temperature`");
  });

  test("every tools form the skill shows parses to the narrowing it claims [S15]", () => {
    const parse = (frontmatter: string) => parseAgentFile(`---\n${frontmatter}\n---\nBody`, { pack: "user", file: "x.md" })!;
    expect(parse("tools:\n  bash: false\n  webfetch: false").tools?.deny).toEqual(["bash", "web"]);
    expect(parse("tools: Read, Grep").tools?.deny).toEqual(["edit", "bash", "web", "task", "mcp"]);
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
    for (const word of ["name", "description", "mode", "primary", "subagent", "permission", "read-only", "build", "model", "provider/id", "tools"]) {
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

  describe("pack hooks (S16)", () => {
    test("says hooks are opt-in and off by default, and no longer says marcsh never runs them", () => {
      const body = text();
      expect(body).toMatch(/opt-in/i);
      expect(body).toMatch(/off by default/i);
      expect(body).not.toContain("marcsh never runs hooks");
      // MCP servers and `hooks` declared anywhere but hooks/ stay unused.
      expect(body).toMatch(/MCP servers[^\n]*never run/i);
    });

    test("shows how to ship hooks: hooks/hooks.json with command hooks and ${CLAUDE_PLUGIN_ROOT}", () => {
      const body = text();
      for (const part of ["hooks/hooks.json", '"type": "command"', "${CLAUDE_PLUGIN_ROOT}", "PreToolUse", "matcher"]) expect(body).toContain(part);
      expect(body).toMatch(/only[^\n]*`command`/i);
    });

    test("describes the review and enable flow, and turning them off", () => {
      const body = text();
      expect(body).toContain("/agents hooks owner/repo");
      expect(body).toContain("/agents hooks owner/repo off");
      expect(body).toMatch(/Cancel/);
      expect(body).toMatch(/exact command/i);
      expect(body).toContain("while one of the pack's agents is selected");
    });

    test("says which events run on which engine", () => {
      const body = text();
      expect(body).toMatch(/PreToolUse, PostToolUse and PostToolUseFailure run on Claude and pi/);
      expect(body).toMatch(/other events[^\n]*Claude only/i);
    });

    test("says what a hook can do on pi: block with exit 2 or deny, never widen, timeout blocks", () => {
      const body = text();
      expect(body).toMatch(/exit code 2/i);
      expect(body).toContain("permissionDecision");
      expect(body).toMatch(/never widen|only narrow/i);
      expect(body).toMatch(/allow[^\n]*no effect/i);
      expect(body).toMatch(/timeout[^\n]*60 s/i);
      expect(body).toMatch(/time[sd]? out[^\n]*blocks/i);
    });

    test("says consent is pinned and re-asked after an update or any change", () => {
      const body = text();
      expect(body).toMatch(/commit/);
      expect(body).toMatch(/digest|every file/i);
      expect(body).toMatch(/update[^\n]*(turns|turned)[^\n]*off/i);
      expect(body).toMatch(/review[^\n]*again/i);
    });

    test("states the limits of hooks/ and what makes the hooks unusable", () => {
      const body = text();
      expect(body).toMatch(/hooks\/[^\n]*1 MB/);
      expect(body).toMatch(/hooks\/[^\n]*5 MB/);
      expect(body).toMatch(/unusable/i);
      expect(body).toMatch(/symlink/);
    });

    test("points to hooks/hooks.json as the supported way when a skill or command declares hooks", () => {
      expect(text()).toMatch(/frontmatter of any skill or command[^\n]*Declare hooks in `hooks\/hooks\.json`/);
    });

    test("says the consent covers the whole pack, since a hook may run any file of it", () => {
      const body = text();
      expect(body).toContain("Hooks may run any file of this pack");
      expect(body).toMatch(/`hooks\/`, `skills\/` and `commands\/`/);
      expect(body).toContain("hooks changed — off");
    });

    test("says what a matcher may be, and that Task and Agent are the same tool", () => {
      const body = text();
      expect(body).toMatch(/`matcher` is empty, `\*`, or tool names separated by `\|`/);
      expect(body).toMatch(/regular expressions included, makes the hooks unusable/i);
      expect(body).toMatch(/`Task` and `Agent` name the same tool/);
    });

    test("says that on Claude too a hook can block but never approve, through marcsh's filter", () => {
      const body = text();
      expect(body).toMatch(/On Claude\*\* marcsh does not hand the pack's `hooks\.json` to Claude/);
      expect(body).toMatch(/filter/);
      expect(body).toMatch(/`allow`, `ask`, `approve` and `updatedInput` are dropped/);
    });

    test("says PostToolUse runs only for a call that succeeded and failures go to PostToolUseFailure", () => {
      expect(text()).toMatch(/PostToolUse runs only for a call that succeeded[^\n]*PostToolUseFailure/);
    });

    test("keeps the documented limit: an edit to the view in the middle of a turn is not noticed until the next turn", () => {
      expect(text()).toMatch(/middle of a turn is not noticed until the next turn/);
    });

    test("the checklist covers the hooks folder", () => {
      expect(text()).toMatch(/- \[ \][^\n]*hooks\/hooks\.json/);
    });
  });
});
