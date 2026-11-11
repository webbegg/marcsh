import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PackError,
  installPack,
  listPacks,
  packPluginDir,
  packsRoot,
  parsePackSpec,
  previewPack,
  printable,
  removePack,
  updatePack,
  type PackPreview,
} from "./packs";

const AGENT = "---\nname: Reviewer\ndescription: Reviews\npermission: read-only\nmodel: openai/gpt-5\n---\nReview only.";

// Every test runs real git processes (fixture repos, fetches), which can take seconds on a busy machine.
setDefaultTimeout(60_000);

// A fixture repo is a real git repository under <fixtures>/<owner>/<repo>, fetched through file:// like a GitHub URL.
type Files = Record<string, string | { symlink: string } | { text: string; mode: number }>;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();

function commitFiles(repo: string, files: Files, message = "c") {
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    rmSync(full, { force: true });
    if (typeof content === "string") writeFileSync(full, content);
    else if ("symlink" in content) symlinkSync(content.symlink, full);
    else {
      writeFileSync(full, content.text);
      chmodSync(full, content.mode);
    }
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  // On a branch, HEAD names a ref file that holds the SHA (cheaper than a git process on a slow machine).
  const ref = readFileSync(join(repo, ".git", "HEAD"), "utf8").trim().replace(/^ref: /, "");
  return readFileSync(join(repo, ".git", ref), "utf8").trim();
}

let work: string;
let fixtures: string;
let root: string;
let urlBase: string;

function makeRepo(id: string, files: Files) {
  const repo = join(fixtures, id);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  return { repo, sha: commitFiles(repo, files) };
}

const goodPack: Files = {
  "agents/reviewer.md": AGENT,
  "agents/helper.md": "---\nmode: subagent\n---\nHelps.",
  "skills/lint/SKILL.md": "---\nname: lint\ndescription: Lints\n---\nLint it.",
  "commands/ship.md": "---\ndescription: Ship\n---\nShip it.",
  "hooks/hooks.json": '{"hooks":{}}',
  ".mcp.json": '{"mcpServers":{}}',
  "scripts/run.sh": "echo hi",
};

const yes = async () => true;
const no = async () => false;
const options = (confirm: (p: PackPreview) => boolean | Promise<boolean> = yes) => ({ confirm, root, urlBase });

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "marcsh-packs-"));
  fixtures = join(work, "fixtures");
  root = join(work, "packs");
  urlBase = `file://${fixtures}`;
});

afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("parsePackSpec", () => {
  const savedBase = process.env.MARCSH_PACK_URL_BASE;
  beforeEach(() => delete process.env.MARCSH_PACK_URL_BASE);
  afterEach(() => {
    if (savedBase !== undefined) process.env.MARCSH_PACK_URL_BASE = savedBase;
  });

  test("owner/repo, with an optional @ref", () => {
    expect(parsePackSpec("acme/flows")).toEqual({ id: "acme/flows", url: "https://github.com/acme/flows.git" });
    expect(parsePackSpec("acme/flows@v1.2")).toEqual({ id: "acme/flows", url: "https://github.com/acme/flows.git", ref: "v1.2" });
    expect(parsePackSpec("acme/flows@feature/x")?.ref).toBe("feature/x");
  });

  test("a github.com URL, with or without .git and @ref", () => {
    const expected = { id: "acme/flows", url: "https://github.com/acme/flows.git" };
    expect(parsePackSpec("https://github.com/acme/flows")).toEqual(expected);
    expect(parsePackSpec("https://github.com/acme/flows.git")).toEqual(expected);
    expect(parsePackSpec("https://github.com/acme/flows.git@main")).toEqual({ ...expected, ref: "main" });
    expect(parsePackSpec("  acme/flows  ")?.id).toBe("acme/flows");
  });

  test("the ID is lower case, like GitHub names", () => {
    expect(parsePackSpec("Acme/Flows").id).toBe("acme/flows");
  });

  test("anything else is rejected with the accepted forms in the message", () => {
    for (const bad of [
      "",
      "acme",
      "../x",
      "acme/..",
      "../..",
      "acme/repo; rm -rf",
      "acme/repo extra",
      "acme/repo/sub",
      "acme/re$po",
      ".staging/repo",
      "-x/repo",
      "acme/repo@",
      "acme/repo@-x",
      "acme/repo@a..b",
      "acme/repo@a b",
      "http://github.com/acme/flows",
      "https://evil.example/acme/flows",
      "https://github.com/acme/flows/tree/main",
      "ssh://github.com/acme/flows",
      "file:///etc/passwd",
    ]) {
      expect(() => parsePackSpec(bad), bad).toThrow(PackError);
    }
    expect(() => parsePackSpec("../x")).toThrow(/owner\/repo/);
  });

  test("a URL base (tests) replaces https://github.com", () => {
    expect(parsePackSpec("acme/flows", { urlBase: "file:///tmp/fx" }).url).toBe("file:///tmp/fx/acme/flows");
  });
});

describe("installPack", () => {
  test("fetches, previews, and on consent pins the commit in the lockfile", async () => {
    const { sha } = makeRepo("acme/flows", goodPack);
    let preview: PackPreview | undefined;
    const result = await installPack("acme/flows", options((p) => ((preview = p), true)));

    expect(result.status).toBe("installed");
    expect(preview).toEqual({
      id: "acme/flows",
      commit: sha,
      agents: [{ name: "Reviewer", permission: "read-only", model: "openai/gpt-5" }],
      skills: ["lint"],
      commands: ["ship"],
      ignored: ["hooks/", ".mcp.json", "subagent helper.md"],
      warnings: [],
    });

    const lock = JSON.parse(readFileSync(join(root, "packs.json"), "utf8"));
    expect(lock.packs).toHaveLength(1);
    expect(lock.packs[0]).toMatchObject({ id: "acme/flows", url: `${urlBase}/acme/flows`, commit: sha });
    expect(lock.packs[0].commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Number.isNaN(Date.parse(lock.packs[0].installedAt))).toBe(false);
    expect(lock.packs[0].ref).toBeUndefined();
    expect(listPacks({ root }).map((p) => p.id)).toEqual(["acme/flows"]);

    expect(readFileSync(join(root, "acme/flows/src/agents/reviewer.md"), "utf8")).toBe(AGENT);
    expect(git(join(root, "acme/flows/src"), "rev-parse", "HEAD")).toBe(sha);
  });

  test("the plugin view has a manifest and skills/commands only: no hooks, MCP or agents", async () => {
    makeRepo("acme/flows", goodPack);
    await installPack("acme/flows", options());

    const view = packPluginDir("acme/flows", root);
    expect(view).toBe(join(root, "acme/flows/plugin"));
    expect(readdirSync(view).sort()).toEqual([".claude-plugin", "commands", "skills"]);
    expect(readdirSync(join(view, ".claude-plugin"))).toEqual(["plugin.json"]);
    const manifest = JSON.parse(readFileSync(join(view, ".claude-plugin/plugin.json"), "utf8"));
    expect(manifest.name).toBe("acme-flows");
    expect(Object.keys(manifest).sort()).toEqual(["description", "name"]);
    // Copies, never links: the engines can only see what was scanned.
    expect(lstatSync(join(view, "skills")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(view, "skills/lint/SKILL.md")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(view, "commands/ship.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(view, "skills/lint/SKILL.md"), "utf8")).toContain("Lint it.");
    expect(readFileSync(join(view, "commands/ship.md"), "utf8")).toContain("Ship it.");
    expect(existsSync(join(view, "hooks"))).toBe(false);
    expect(existsSync(join(view, ".mcp.json"))).toBe(false);
    expect(existsSync(join(view, "agents"))).toBe(false);
  });

  test("a pack without skills or commands gets a manifest only", async () => {
    makeRepo("acme/flows", { "agents/a.md": "Do it." });
    await installPack("acme/flows", options());
    expect(readdirSync(packPluginDir("acme/flows", root))).toEqual([".claude-plugin"]);
  });

  test("@ref installs that ref and records it", async () => {
    const { repo } = makeRepo("acme/flows", goodPack);
    git(repo, "tag", "v1");
    const second = commitFiles(repo, { "agents/second.md": "Second." });
    const result = await installPack("acme/flows@v1", options());
    expect(result.status).toBe("installed");
    const [entry] = listPacks({ root });
    expect(entry).toMatchObject({ ref: "v1" });
    expect(entry!.commit).not.toBe(second);
    expect(existsSync(join(root, "acme/flows/src/agents/second.md"))).toBe(false);
  });

  test("declining leaves nothing behind", async () => {
    makeRepo("acme/flows", goodPack);
    const result = await installPack("acme/flows", options(no));
    expect(result.status).toBe("cancelled");
    expect(listPacks({ root })).toEqual([]);
    expect(existsSync(join(root, "acme"))).toBe(false);
    expect(readdirSync(root).filter((name) => name !== ".staging")).toEqual([]);
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
  });

  test("a confirm that throws leaves nothing behind", async () => {
    makeRepo("acme/flows", goodPack);
    await expect(
      installPack("acme/flows", options(() => {
        throw new Error("dialog crashed");
      })),
    ).rejects.toThrow("dialog crashed");
    expect(listPacks({ root })).toEqual([]);
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
  });

  test("a symlink that points outside the clone rejects the pack", async () => {
    const secret = join(work, "secret.txt");
    writeFileSync(secret, "s3cret");
    makeRepo("acme/flows", { ...goodPack, "skills/lint/leak.md": { symlink: secret } });
    let asked = false;
    await expect(installPack("acme/flows", options(() => ((asked = true), true)))).rejects.toThrow(/outside/);
    expect(asked).toBe(false);
    expect(listPacks({ root })).toEqual([]);
    expect(existsSync(join(root, "acme"))).toBe(false);
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
  });

  test("a relative symlink that climbs out of the clone is rejected, a link inside it is fine", async () => {
    makeRepo("acme/bad", { ...goodPack, "agents/evil.md": { symlink: "../../../../../../etc/passwd" } });
    await expect(installPack("acme/bad", options())).rejects.toThrow(/outside/);

    makeRepo("acme/good", { ...goodPack, "docs/alias": { symlink: "../skills/lint" } });
    expect((await installPack("acme/good", options())).status).toBe("installed");
  });

  test("a symlinked directory that resolves outside the clone is rejected", async () => {
    const outside = join(work, "outside");
    mkdirSync(outside);
    makeRepo("acme/flows", { ...goodPack, "skills/external": { symlink: outside } });
    await expect(installPack("acme/flows", options())).rejects.toThrow(/outside/);
  });

  test("a pack without a primary agent is rejected", async () => {
    makeRepo("acme/none", { "skills/lint/SKILL.md": "x" });
    await expect(installPack("acme/none", options())).rejects.toThrow(/agents\/\*\.md/);
    makeRepo("acme/subs", { "agents/helper.md": "---\nmode: subagent\n---\nH" });
    await expect(installPack("acme/subs", options())).rejects.toThrow(/agents\/\*\.md/);
    expect(listPacks({ root })).toEqual([]);
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
  });

  test("an agent file over 256 KB rejects the pack", async () => {
    makeRepo("acme/big", { "agents/a.md": "Do it.", "agents/huge.md": "x".repeat(256 * 1024 + 1) });
    await expect(installPack("acme/big", options())).rejects.toThrow(/256 KB/);
  });

  test("a skill or command that declares hooks rejects the pack; allowed-tools is a warning", async () => {
    makeRepo("acme/hooked", { ...goodPack, "skills/lint/SKILL.md": "---\nname: lint\nhooks:\n  PreToolUse: x\n---\nL" });
    await expect(installPack("acme/hooked", options())).rejects.toThrow(/hooks/);

    makeRepo("acme/tooled", { ...goodPack, "commands/ship.md": "---\nallowed-tools: Bash(*)\n---\nShip" });
    let preview: PackPreview | undefined;
    await installPack("acme/tooled", options((p) => ((preview = p), true)));
    expect(preview!.warnings).toEqual(["commands/ship.md pre-approves tools (allowed-tools)"]);
  });

  test("plugin.json hooks and MCP servers are listed as ignored", async () => {
    makeRepo("acme/flows", {
      "agents/a.md": "Do it.",
      ".claude-plugin/plugin.json": JSON.stringify({ name: "x", hooks: "./h.json", mcpServers: {} }),
    });
    let preview: PackPreview | undefined;
    await installPack("acme/flows", options((p) => ((preview = p), true)));
    expect(preview!.ignored).toEqual([".claude-plugin hooks", ".claude-plugin mcpServers"]);
  });

  test("the pack's own plugin manifest is not used: the view has marcsh's", async () => {
    makeRepo("acme/flows", {
      "agents/a.md": "Do it.",
      ".claude-plugin/plugin.json": JSON.stringify({ name: "x", hooks: "./h.json" }),
      "skills/s/SKILL.md": "S",
    });
    await installPack("acme/flows", options());
    const manifest = JSON.parse(readFileSync(join(packPluginDir("acme/flows", root), ".claude-plugin/plugin.json"), "utf8"));
    expect(manifest.hooks).toBeUndefined();
    expect(manifest.name).toBe("acme-flows");
  });

  test("installing the same pack twice is an error that points to update", async () => {
    makeRepo("acme/flows", goodPack);
    await installPack("acme/flows", options());
    await expect(installPack("acme/flows@main", options())).rejects.toThrow(/already installed.*update/);
    expect(listPacks({ root })).toHaveLength(1);
  });

  test("a failed fetch surfaces git's message and leaves nothing", async () => {
    await expect(installPack("acme/missing", options())).rejects.toThrow(/missing|not exist|repository/i);
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
    makeRepo("acme/flows", goodPack);
    await expect(installPack("acme/flows@nope", options())).rejects.toThrow(PackError);
  });

  test("a hook the pack ships never runs, even when a relative core.hooksPath points at it", async () => {
    const marker = join(work, "hook-ran");
    const hook = { text: `#!/bin/sh\necho ran > '${marker}'\n`, mode: 0o755 };
    makeRepo("acme/flows", {
      ...goodPack,
      ".githooks/post-checkout": hook,
      ".githooks/post-merge": hook,
      ".githooks/reference-transaction": hook,
    });
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: ".githooks" });
    try {
      await installPack("acme/flows", options());
    } finally {
      for (const key of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, "acme/flows/src/.githooks/post-checkout"))).toBe(true);
  });

  test("a submodule the pack declares is not fetched", async () => {
    const { repo: inner } = makeRepo("acme/inner", { "payload.txt": "inner" });
    const { repo } = makeRepo("acme/flows", goodPack);
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", inner, "vendor");
    git(repo, "commit", "-m", "submodule");
    await installPack("acme/flows", options());
    const vendor = join(root, "acme/flows/src/vendor");
    expect(!existsSync(vendor) || readdirSync(vendor).length === 0).toBe(true);
  });
});

describe("updatePack", () => {
  test("an unchanged pack is up to date and nothing is asked", async () => {
    makeRepo("acme/flows", goodPack);
    await installPack("acme/flows", options());
    let asked = false;
    const result = await updatePack("acme/flows", options(() => ((asked = true), true)));
    expect(result.status).toBe("up-to-date");
    expect(asked).toBe(false);
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
  });

  test("a changed pack previews old → new commit and is swapped after consent", async () => {
    const { repo, sha: oldSha } = makeRepo("acme/flows", goodPack);
    await installPack("acme/flows", options());
    const newSha = commitFiles(repo, { "agents/writer.md": "---\nname: Writer\n---\nWrite.", "agents/reviewer.md": AGENT.replace("Review only.", "Review v2.") });

    let preview: PackPreview | undefined;
    const result = await updatePack("acme/flows", options((p) => ((preview = p), true)));

    expect(result.status).toBe("updated");
    expect(preview).toMatchObject({ id: "acme/flows", commit: newSha, previousCommit: oldSha });
    expect(preview!.agents.map((a) => a.name).sort()).toEqual(["Reviewer", "Writer"]);
    const [entry] = listPacks({ root });
    expect(entry!.commit).toBe(newSha);
    expect(readFileSync(join(root, "acme/flows/src/agents/reviewer.md"), "utf8")).toContain("Review v2.");
    expect(existsSync(join(root, "acme/flows/src/agents/writer.md"))).toBe(true);
    expect(existsSync(join(packPluginDir("acme/flows", root), ".claude-plugin/plugin.json"))).toBe(true);
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
    expect(readdirSync(join(root, "acme"))).toEqual(["flows"]);
  });

  test("declining keeps the old commit and files", async () => {
    const { repo, sha: oldSha } = makeRepo("acme/flows", goodPack);
    await installPack("acme/flows", options());
    commitFiles(repo, { "agents/writer.md": "Write." });

    const result = await updatePack("acme/flows", options(no));

    expect(result.status).toBe("cancelled");
    expect(listPacks({ root })[0]!.commit).toBe(oldSha);
    expect(existsSync(join(root, "acme/flows/src/agents/writer.md"))).toBe(false);
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
  });

  test("a pinned ref follows that ref only", async () => {
    const { repo } = makeRepo("acme/flows", goodPack);
    git(repo, "tag", "v1");
    await installPack("acme/flows@v1", options());
    commitFiles(repo, { "agents/writer.md": "Write." });
    expect((await updatePack("acme/flows", options())).status).toBe("up-to-date");
  });

  test("an update that turns unsafe is rejected and keeps the old install", async () => {
    const { repo, sha } = makeRepo("acme/flows", goodPack);
    await installPack("acme/flows", options());
    commitFiles(repo, { "skills/leak": { symlink: "/etc" } });
    await expect(updatePack("acme/flows", options())).rejects.toThrow(/outside/);
    expect(listPacks({ root })[0]!.commit).toBe(sha);
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
  });

  test("an unknown pack is an error", async () => {
    await expect(updatePack("acme/nope", options())).rejects.toThrow(/not installed/);
  });
});

describe("removePack", () => {
  test("deletes the directory and the lock entry, and only that pack's", async () => {
    makeRepo("acme/flows", goodPack);
    makeRepo("acme/other", goodPack);
    await installPack("acme/flows", options());
    await installPack("acme/other", options());

    await removePack("acme/flows", { root });

    expect(existsSync(join(root, "acme/flows"))).toBe(false);
    expect(existsSync(join(root, "acme/other/src"))).toBe(true);
    expect(listPacks({ root }).map((p) => p.id)).toEqual(["acme/other"]);
  });

  test("an unknown pack is an error and a hostile ID never touches the disk", async () => {
    await expect(removePack("acme/nope", { root })).rejects.toThrow(/not installed/);
    mkdirSync(join(work, "keep"));
    await expect(removePack("../keep", { root })).rejects.toThrow(PackError);
    expect(existsSync(join(work, "keep"))).toBe(true);
  });

  test("a removed pack can be installed again", async () => {
    makeRepo("acme/flows", goodPack);
    await installPack("acme/flows", options());
    await removePack("acme/flows", { root });
    expect((await installPack("acme/flows", options())).status).toBe("installed");
  });
});

describe("listPacks and the lockfile", () => {
  test("no lockfile, or an unreadable one, lists nothing; entries with a hostile id are dropped", () => {
    expect(listPacks({ root })).toEqual([]);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "packs.json"), "{not json");
    expect(listPacks({ root })).toEqual([]);
    writeFileSync(
      join(root, "packs.json"),
      JSON.stringify({
        packs: [
          { id: "../evil", url: "https://github.com/x/y.git", commit: "c", installedAt: "t" },
          { id: "acme/ok", url: "https://github.com/acme/ok.git", commit: "c", installedAt: "t" },
        ],
      }),
    );
    expect(listPacks({ root }).map((p) => p.id)).toEqual(["acme/ok"]);
  });

  test("an unreadable lockfile stops an install instead of being overwritten", async () => {
    makeRepo("acme/flows", goodPack);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "packs.json"), "{not json");
    await expect(installPack("acme/flows", options())).rejects.toThrow(/packs\.json/);
    expect(readFileSync(join(root, "packs.json"), "utf8")).toBe("{not json");
  });

  test("the root is ~/.marcsh/packs unless MARCSH_PACKS_DIR says otherwise", () => {
    const saved = process.env.MARCSH_PACKS_DIR;
    try {
      delete process.env.MARCSH_PACKS_DIR;
      expect(packsRoot()).toMatch(/\.marcsh[/\\]packs$/);
      process.env.MARCSH_PACKS_DIR = root;
      expect(packsRoot()).toBe(root);
    } finally {
      if (saved === undefined) delete process.env.MARCSH_PACKS_DIR;
      else process.env.MARCSH_PACKS_DIR = saved;
    }
  });
});

describe("hostile packs (T6 verify)", () => {
  const HOOK = "  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: touch /tmp/x\n";
  const variants: Record<string, Files> = {
    "quoted-key": { "skills/x/SKILL.md": `---\nname: x\ndescription: d\n"hooks":\n${HOOK}---\nb` },
    "single-quoted": { "commands/c.md": `---\ndescription: d\n'hooks':\n${HOOK}---\nb` },
    indented: { "skills/x/SKILL.md": `---\n  name: x\n  description: d\n  hooks:\n    PreToolUse: []\n---\nb` },
    flow: { "skills/x/SKILL.md": "---\n{name: x, description: d, hooks: {PreToolUse: []}}\n---\nb" },
    "upper-ext": { "skills/x/SKILL.MD": `---\nname: x\ndescription: d\nhooks:\n${HOOK}---\nb` },
    "linked-file": { "docs/e.md": `---\nname: x\ndescription: d\nhooks:\n${HOOK}---\nb`, "skills/x/SKILL.md": { symlink: "../../docs/e.md" } },
    "linked-dir": { "docs/x/SKILL.md": `---\nname: x\ndescription: d\nhooks:\n${HOOK}---\nb`, "skills/x": { symlink: "../docs/x" } },
    "linked-command": { "docs/c.txt": `---\ndescription: d\nhooks:\n${HOOK}---\nb`, "commands/c.md": { symlink: "../docs/c.txt" } },
    "linked-skills-dir": { "docs/s/x/SKILL.md": "---\nname: x\n---\nb", skills: { symlink: "docs/s" } },
    padded: { "commands/c.md": `---\ndescription: d\n${"# pad\n".repeat(12000)}hooks:\n${HOOK}---\nb` },
    "merge-key": { "commands/c.md": "---\ndescription: d\nbase: &b\n  hooks: {PreToolUse: []}\n<<: *b\n---\nb" },
    "upper-key": { "commands/c.md": "---\ndescription: d\nHOOKS:\n  PreToolUse: []\n---\nb" },
    "not-yaml": { "commands/c.md": "---\ndescription: [unclosed\n---\nb" },
    unclosed: { "commands/c.md": "---\ndescription: d\nb" },
  };
  for (const [name, files] of Object.entries(variants)) {
    test(`a skill or command declaring hooks is rejected however it is written (${name}) [S11]`, async () => {
      makeRepo(`acme/${name}`, { "agents/reviewer.md": AGENT, ...files });
      await expect(installPack(`acme/${name}`, options())).rejects.toThrow(/hooks|symlink|frontmatter/);
      expect(listPacks({ root })).toEqual([]);
      expect(readdirSync(join(root, ".staging"))).toEqual([]);
    });
  }

  test("text that merely mentions hooks, in a value or the body, is not a declaration [S11]", async () => {
    makeRepo("acme/talk", {
      "agents/reviewer.md": AGENT,
      "skills/x/SKILL.md": "---\nname: x\ndescription: \"Explains git hooks: how they work\"\n---\nhooks:\n  not frontmatter",
      "commands/c.md": "no frontmatter\nhooks: none",
    });
    expect((await installPack("acme/talk", options())).status).toBe("installed");
  });

  test("every skill and command the view exposes is in the preview, or the pack is rejected [S10]", async () => {
    makeRepo("acme/hidden", {
      "agents/reviewer.md": AGENT,
      "docs/hid/SKILL.md": "---\nname: hid\ndescription: d\n---\nx",
      "skills/hid": { symlink: "../docs/hid" },
      "docs/c.txt": "---\ndescription: d\n---\nx",
      "commands/linked.md": { symlink: "../docs/c.txt" },
      "commands/ns/nested.md": "---\ndescription: d\n---\nx",
    });
    let seen: PackPreview | undefined;
    try {
      await installPack("acme/hidden", options((p) => ((seen = p), true)));
    } catch {
      return;
    }
    expect(seen!.skills).toContain("hid");
    expect(seen!.commands.join(" ")).toMatch(/linked/);
    expect(seen!.commands.join(" ")).toMatch(/nested/);
  });

  test("a lock entry whose ref or url starts with '-' never reaches git [A1]", async () => {
    const { repo } = makeRepo("acme/p", { "agents/reviewer.md": AGENT });
    const marker = join(work, "MARKER");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "packs.json"),
      JSON.stringify({ packs: [{ id: "acme/p", url: `file://${repo}`, ref: `--upload-pack=touch ${marker}; git-upload-pack`, commit: "0".repeat(40), installedAt: "x" }] }),
    );
    await updatePack("acme/p", { root, confirm: no }).catch(() => {});
    expect(existsSync(marker)).toBe(false);
    expect(listPacks({ root })).toEqual([]);
  });

  test("a lock entry with an option-like url is refused too [A1]", async () => {
    mkdirSync(root, { recursive: true });
    const entry = { id: "acme/p", url: "--upload-pack=touch x", commit: "0".repeat(40), installedAt: "x" };
    writeFileSync(join(root, "packs.json"), JSON.stringify({ packs: [entry] }));
    expect(listPacks({ root })).toEqual([]);
    await expect(updatePack("acme/p", { root, confirm: no })).rejects.toThrow(PackError);
  });

  test("a ref that starts with '-' is passed after -- so git cannot take it as an option [A1]", async () => {
    const { repo } = makeRepo("acme/p", { "agents/reviewer.md": AGENT });
    const marker = join(work, "MARKER");
    const { fetchPack } = await import("./packs");
    await fetchPack({ url: `file://${repo}`, ref: `--upload-pack=touch ${marker}; git-upload-pack`, root }).catch(() => {});
    expect(existsSync(marker)).toBe(false);
  });

  test("git is run without a credential helper or askpass program [A2]", async () => {
    const { repo } = makeRepo("acme/p", { "agents/reviewer.md": AGENT });
    const marker = join(work, "ASKED");
    const askpass = join(work, "askpass.sh");
    writeFileSync(askpass, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(askpass, 0o755);
    const trace = join(work, "trace.txt");
    const keys = ["GIT_ASKPASS", "SSH_ASKPASS", "GIT_TRACE2_EVENT", "GIT_TRACE2_CONFIG_PARAMS"];
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, GIT_TRACE2_EVENT: trace, GIT_TRACE2_CONFIG_PARAMS: "core.askpass,credential.*" });
    try {
      const { fetchPack } = await import("./packs");
      await fetchPack({ url: `file://${repo}`, root });
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
    // git's trace2 log records the settings given with -c (scope "command"); the names are lower-cased and the values empty.
    const settings = readFileSync(trace, "utf8")
      .split("\n")
      .filter((line) => line.includes('"def_param"'))
      .map((line) => JSON.parse(line) as { param: string; value: string });
    expect(settings).toContainEqual(expect.objectContaining({ param: "core.askpass", value: "" }));
    expect(settings).toContainEqual(expect.objectContaining({ param: "credential.helper", value: "" }));
    expect(existsSync(marker)).toBe(false);
  });
});

describe("the plugin view is a copy of what was scanned (T6 verify)", () => {
  // Every file under a directory, relative to it; fails on anything that is not a plain file or directory.
  const tree = (dir: string, base = dir): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) return tree(path, base);
      if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
      return [path.slice(base.length + 1)];
    });

  const nested: Files = {
    "agents/reviewer.md": AGENT,
    "skills/lint/SKILL.md": "---\nname: lint\ndescription: Lints\n---\nLint it.",
    "skills/lint/scripts/run.sh": "echo hi",
    "skills/group/deep/SKILL.md": "---\nname: deep\n---\nDeep.",
    "commands/ship.md": "---\ndescription: Ship\n---\nShip it.",
    "commands/ns/nested.md": "---\ndescription: Nested\n---\nNested.",
    "docs/readme.md": "not part of the view",
  };

  test("holds copies of exactly the files under skills/ and commands/; nested ones are in the preview too [S10]", async () => {
    makeRepo("acme/nest", nested);
    let preview: PackPreview | undefined;
    await installPack("acme/nest", options((p) => ((preview = p), true)));

    expect(preview!.skills).toEqual(["group/deep", "lint"]);
    expect(preview!.commands).toEqual(["ns/nested", "ship"]);
    const view = packPluginDir("acme/nest", root);
    expect(tree(view).sort()).toEqual(
      [
        ".claude-plugin/plugin.json",
        "commands/ns/nested.md",
        "commands/ship.md",
        "skills/group/deep/SKILL.md",
        "skills/lint/SKILL.md",
        "skills/lint/scripts/run.sh",
      ].sort(),
    );
  });

  test("a file changed in the clone after the install does not change the view", async () => {
    makeRepo("acme/nest", nested);
    await installPack("acme/nest", options());
    writeFileSync(join(root, "acme/nest/src/skills/lint/SKILL.md"), "---\nhooks: {}\n---\nevil");
    expect(readFileSync(join(packPluginDir("acme/nest", root), "skills/lint/SKILL.md"), "utf8")).toContain("Lint it.");
  });

  test("a file over 1 MB in skills/ or commands/ rejects the pack", async () => {
    makeRepo("acme/big", { "agents/reviewer.md": AGENT, "skills/x/big.bin": "x".repeat(1024 * 1024 + 1) });
    await expect(installPack("acme/big", options())).rejects.toThrow(/1 MB/);
    makeRepo("acme/bigmd", { "agents/reviewer.md": AGENT, "commands/big.md": `---\ndescription: d\n---\n${"x".repeat(1024 * 1024)}` });
    await expect(installPack("acme/bigmd", options())).rejects.toThrow(/1 MB/);
  });

  test('a quoted "allowed-tools" key still gets the Check warning', async () => {
    makeRepo("acme/tooled", { "agents/reviewer.md": AGENT, "commands/ship.md": '---\n"Allowed-Tools": Bash(*)\n---\nShip', "skills/x/SKILL.md": "---\n{name: x, 'allowed-tools': Bash}\n---\nx" });
    let preview: PackPreview | undefined;
    await installPack("acme/tooled", options((p) => ((preview = p), true)));
    expect(preview!.warnings).toEqual(["skills/x/SKILL.md pre-approves tools (allowed-tools)", "commands/ship.md pre-approves tools (allowed-tools)"]);
  });

  test("an agents directory that is a symlink rejects the pack, as the loader would not read it [A4]", async () => {
    makeRepo("acme/linked", { "docs/agents/reviewer.md": AGENT, agents: { symlink: "docs/agents" } });
    await expect(installPack("acme/linked", options())).rejects.toThrow(/symlink/);
    makeRepo("acme/files", { "docs/r.md": AGENT, "agents/reviewer.md": { symlink: "../docs/r.md" } });
    await expect(installPack("acme/files", options())).rejects.toThrow(/agents\/\*\.md/);
    expect(listPacks({ root })).toEqual([]);
  });

  test("the lockfile is read again before it is written, so an entry added meanwhile is kept [A5]", async () => {
    const { repo } = makeRepo("acme/flows", goodPack);
    const other = { id: "acme/other", url: "https://github.com/acme/other.git", commit: "1".repeat(40), installedAt: "x" };
    const addOther = (confirm = true) => () => {
      const packs = listPacks({ root }).filter((pack) => pack.id !== other.id);
      writeFileSync(join(root, "packs.json"), JSON.stringify({ packs: [...packs, other] }));
      return confirm;
    };

    await installPack("acme/flows", options(addOther()));
    expect(listPacks({ root }).map((pack) => pack.id)).toEqual(["acme/other", "acme/flows"]);

    commitFiles(repo, { "agents/writer.md": "Write." });
    writeFileSync(join(root, "packs.json"), JSON.stringify({ packs: listPacks({ root }).filter((pack) => pack.id !== other.id) }));
    await updatePack("acme/flows", options(addOther()));
    expect(listPacks({ root }).map((pack) => pack.id).sort()).toEqual(["acme/flows", "acme/other"]);
    expect(listPacks({ root }).find((pack) => pack.id === "acme/flows")!.commit).not.toBe("1".repeat(40));
  });

  test("staging directories older than a day are removed when an install starts; newer ones stay [A5, R4-001]", async () => {
    makeRepo("acme/flows", goodPack);
    const staging = join(root, ".staging");
    mkdirSync(join(staging, "pack-stale"), { recursive: true });
    mkdirSync(join(staging, "pack-hours"));
    mkdirSync(join(staging, "pack-fresh"));
    const old = new Date(Date.now() - 48 * 3600_000);
    const hours = new Date(Date.now() - 5 * 3600_000);
    utimesSync(join(staging, "pack-stale"), old, old);
    utimesSync(join(staging, "pack-hours"), hours, hours);
    await installPack("acme/flows", options());
    expect(readdirSync(staging).sort()).toEqual(["pack-fresh", "pack-hours"]);
  });
});

describe("previewPack", () => {
  test("bidi controls and zero-width characters never reach the preview [A6]", () => {
    const [rlo, zwsp, lri, pdi, bom, rlm] = [0x202e, 0x200b, 0x2066, 0x2069, 0xfeff, 0x200f].map((code) => String.fromCharCode(code));
    const dir = join(work, "dir");
    mkdirSync(join(dir, "agents"), { recursive: true });
    mkdirSync(join(dir, "skills", `ev${rlo}il${zwsp}`), { recursive: true });
    writeFileSync(join(dir, "skills", `ev${rlo}il${zwsp}`, "SKILL.md"), "x");
    writeFileSync(join(dir, "agents/a.md"), `---\nname: "Fi${lri}ne${pdi}${bom}"\nmodel: "m${rlm}"\n---\nA`);
    const preview = previewPack(dir, { id: "acme/x", commit: "abc" });
    expect(preview.agents[0]).toEqual({ name: "Fine", permission: "build", model: "m" });
    expect(preview.skills).toEqual(["evil"]);
  });

  test("terminal control characters in names never reach the preview", () => {
    const dir = join(work, "dir");
    mkdirSync(join(dir, "agents"), { recursive: true });
    mkdirSync(join(dir, "skills", "evil\u001b]0;pwn\u0007"), { recursive: true });
    writeFileSync(join(dir, "skills", "evil\u001b]0;pwn\u0007", "SKILL.md"), "x");
    writeFileSync(join(dir, "agents/a.md"), "---\nname: \"Fine\u001b[2J\u0007\"\nmodel: m\u001b[31m\n---\nA");
    const preview = previewPack(dir, { id: "acme/x", commit: "abc" });
    expect(JSON.stringify(preview)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(preview.agents[0]!.name).toBe("Fine[2J");
    expect(preview.skills).toEqual(["evil]0;pwn"]);
  });

  test("reads a directory without running or following anything", () => {
    const dir = join(work, "dir");
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents/b.md"), "---\nname: B\n---\nB");
    writeFileSync(join(dir, "agents/a.md"), "---\nname: A\npermission: read-only\n---\nA");
    expect(previewPack(dir, { id: "acme/x", commit: "abc" })).toEqual({
      id: "acme/x",
      commit: "abc",
      agents: [
        { name: "A", permission: "read-only" },
        { name: "B", permission: "build" },
      ],
      skills: [],
      commands: [],
      ignored: [],
      warnings: [],
    });
  });
});

describe("T6 recheck: what pi loads is what the preview lists", () => {
  test("a .md directly under skills/ is a skill to pi, so the preview lists it [S10]", async () => {
    makeRepo("acme/flows", {
      "agents/reviewer.md": AGENT,
      "skills/lint/SKILL.md": "---\nname: lint\ndescription: Lints\n---\nLint it.",
      "skills/sneaky.md": "---\nname: sneaky\ndescription: Sneaky\n---\nX",
    });
    let preview: PackPreview | undefined;
    await installPack("acme/flows", options((p) => ((preview = p), true)));
    const view = readdirSync(packPluginDir("acme/flows", root), { recursive: true }).map(String);
    expect(view).toContain(join("skills", "sneaky.md"));
    expect(preview!.skills).toEqual(["lint", "sneaky"]);
  });

  test("a ... line inside the frontmatter rejects the pack: readers disagree on what follows it [S11]", async () => {
    makeRepo("acme/dots", {
      "agents/reviewer.md": AGENT,
      "commands/c.md": "---\ndescription: d\n...\nhooks:\n  PreToolUse: []\n---\nb",
    });
    await expect(installPack("acme/dots", options())).rejects.toThrow(/Pack rejected/);
    expect(listPacks({ root })).toEqual([]);
  });
});

describe("review corrections", () => {
  const message = async (run: Promise<unknown>) => {
    try {
      await run;
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected a rejection");
  };
  const ESC = String.fromCharCode(27);

  test("printable removes every Unicode format character and every control character [R1-002]", () => {
    // U+2060 word joiner, U+00AD soft hyphen, U+061C Arabic letter mark, U+E0041 tag letter A, U+200B, U+202E, U+FEFF
    const format = [0x2060, 0x00ad, 0x061c, 0xe0041, 0x200b, 0x202e, 0xfeff].map((code) => String.fromCodePoint(code)).join("");
    expect(printable(`Pl${format}an`)).toBe("Plan");
    expect(printable(`a${ESC}[2Jb\u0007c`)).toBe("a[2Jbc");
    expect(printable("日本語 ok ✓")).toBe("日本語 ok ✓");
  });

  test("a repo's symlink name is cleaned in the rejection message [R1-003]", async () => {
    makeRepo("acme/linky", { "agents/reviewer.md": AGENT, [`skills/lin${ESC}[2Jk`]: { symlink: "/etc" } });
    const text = await message(installPack("acme/linky", options()));
    expect(text).toMatch(/lin\[2Jk is a symlink/);
    expect(text).not.toContain(ESC);
  });

  test("an oversized agent file's name is cleaned in the rejection message [R1-003]", async () => {
    makeRepo("acme/big", { "agents/reviewer.md": AGENT, [`agents/big${ESC}[2J.md`]: "x".repeat(300 * 1024) });
    const text = await message(installPack("acme/big", options()));
    expect(text).toMatch(/agents\/big\[2J\.md is larger/);
    expect(text).not.toContain(ESC);
  });

  test("git's stderr is cleaned and capped before it reaches the message [R4-006]", async () => {
    const bin = join(work, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '${ESC.replace(ESC, "\\033")}[31mboom ' >&2\nhead -c 3000 /dev/zero | tr '\\0' 'x' >&2\nprintf ' THE-END' >&2\nexit 1\n`);
    chmodSync(join(bin, "git"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      const text = await message(installPack("acme/flows", options()));
      expect(text).toStartWith("git init failed: ");
      expect(text).not.toContain(ESC);
      expect(text).toEndWith("THE-END");
      expect(text.length).toBeLessThanOrEqual("git init failed: ".length + 500);
      expect(text).not.toContain("boom");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test("a repo GitHub will not serve without a login says it is missing or private, not 'could not read Username'", async () => {
    const bin = join(work, "bin");
    mkdirSync(bin);
    // GitHub answers a missing or private repo with 401; with prompts off, git ends with this line.
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nfor a in "$@"; do if [ "$a" = fetch ]; then echo "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2; exit 128; fi; done\nexit 0\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      const text = await message(installPack("acme/typo", options()));
      expect(text).toContain("acme/typo");
      expect(text).toContain("not found, or it is private");
      expect(text).not.toContain("Username");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test("a pack agent whose frontmatter is never closed is rejected [R3-002]", async () => {
    makeRepo("acme/open", { "agents/reviewer.md": AGENT, "agents/open.md": "---\nname: Open\npermission: read-only\nNo closing line" });
    await expect(installPack("acme/open", options())).rejects.toThrow(/Pack rejected: agents\/open\.md.*never closed/);
    expect(listPacks({ root })).toEqual([]);
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
  });

  const deleteStaging = () => {
    for (const name of readdirSync(join(root, ".staging"))) if (name.startsWith("pack-")) rmSync(join(root, ".staging", name), { recursive: true, force: true });
    return true;
  };

  test("an update whose second rename fails puts the old pack back [R4-001]", async () => {
    const { repo, sha } = makeRepo("acme/flows", goodPack);
    await installPack("acme/flows", options());
    commitFiles(repo, { "agents/writer.md": "Write." });

    await expect(updatePack("acme/flows", options(deleteStaging))).rejects.toThrow();

    expect(listPacks({ root })[0]!.commit).toBe(sha);
    expect(readFileSync(join(root, "acme/flows/src/agents/reviewer.md"), "utf8")).toBe(AGENT);
    expect(existsSync(join(root, "acme/flows/src/agents/writer.md"))).toBe(false);
    expect(existsSync(join(packPluginDir("acme/flows", root), ".claude-plugin/plugin.json"))).toBe(true);
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
  });

  test("the retired pack is given a fresh mtime so a concurrent stale cleanup cannot take it [R4-001]", async () => {
    const { repo } = makeRepo("acme/flows", goodPack);
    await installPack("acme/flows", options());
    commitFiles(repo, { "agents/writer.md": "Write." });
    const old = new Date(Date.now() - 72 * 3600_000);
    utimesSync(join(root, "acme", "flows"), old, old);

    const real = fs.renameSync;
    const seen: { retiredAge?: number; stagingAge?: number } = {};
    const spy = spyOn(fs, "renameSync").mockImplementation(((from: string, to: string) => {
      if (to === join(root, "acme", "flows") && from.includes(`${join(root, ".staging")}/pack-`)) {
        const retired = readdirSync(join(root, ".staging")).find((name) => name.startsWith("old-pack-"))!;
        seen.retiredAge = Date.now() - statSync(join(root, ".staging", retired)).mtimeMs;
        seen.stagingAge = Date.now() - statSync(from).mtimeMs;
      }
      return real(from, to);
    }) as typeof fs.renameSync);
    try {
      expect((await updatePack("acme/flows", options())).status).toBe("updated");
    } finally {
      spy.mockRestore();
    }
    expect(seen.retiredAge).toBeDefined();
    expect(seen.retiredAge!).toBeLessThan(60_000);
    expect(seen.stagingAge!).toBeLessThan(60_000);
  });
});
