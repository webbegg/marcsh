import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
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
    expect(lstatSync(join(view, "skills")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(view, "skills"))).toBe("../src/skills");
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

    makeRepo("acme/good", { ...goodPack, "skills/alias": { symlink: "lint" } });
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
      JSON.stringify({ packs: [{ id: "../evil", url: "u", commit: "c", installedAt: "t" }, { id: "acme/ok", url: "u", commit: "c", installedAt: "t" }] }),
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

describe("previewPack", () => {
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
