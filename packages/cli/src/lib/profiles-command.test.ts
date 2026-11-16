import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionProfile, setSessionProfile } from "./profiles";
import { parseProfileCommand, PROFILE_USAGE, runProfileCommand, type ProfileEnv } from "./profiles-command";

let dir: string;
let path: string;
let piModels: string[];
let claudeModels: string[];

const profiles = {
  version: 1,
  default: "cheap",
  profiles: {
    cheap: { primary: { model: "anthropic/claude-haiku-5-5", fallback: [{ model: "openai/gpt-5" }] }, "review-*": { model: "anthropic/claude-haiku-5-5", thinking: "low" } },
    claudeish: { primary: { model: "sonnet", fallback: [{ model: "haiku" }] }, "*": { model: "haiku" } },
    oddball: { primary: { model: "claude-sonnet-4-5" } },
    nomain: { "*": { model: "anthropic/claude-haiku-5-5" } },
  },
};

const env = (engine: string, extra: Partial<ProfileEnv> = {}): ProfileEnv => ({
  engine,
  setPiModel: (model) => piModels.push(model),
  setClaudeModel: (model) => claudeModels.push(model),
  subagents: () => [{ name: "review-style" }, { name: "worker", model: "anthropic/claude-opus-5-5" }],
  path,
  ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-profile-command-"));
  path = join(dir, "profiles.json");
  writeFileSync(path, JSON.stringify(profiles));
  piModels = [];
  claudeModels = [];
  setSessionProfile(undefined);
});

afterEach(() => {
  setSessionProfile(undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe("parseProfileCommand", () => {
  test("no arguments show; use, default and clear are the others", () => {
    expect(parseProfileCommand("")).toEqual({ kind: "show" });
    expect(parseProfileCommand("  ")).toEqual({ kind: "show" });
    expect(parseProfileCommand("use fast")).toEqual({ kind: "use", name: "fast" });
    expect(parseProfileCommand("USE Fast")).toEqual({ kind: "use", name: "Fast" });
    expect(parseProfileCommand("default fast")).toEqual({ kind: "default", name: "fast" });
    expect(parseProfileCommand("clear")).toEqual({ kind: "clear" });
  });

  test("anything else is a usage error that shows the usage", () => {
    for (const args of ["use", "use a b", "default", "default a b", "clear now", "wat", "fast"]) {
      const command = parseProfileCommand(args);
      expect(command.kind, args).toBe("usage");
      expect((command as { message: string }).message).toContain(PROFILE_USAGE);
    }
  });
});

describe("/profile use", () => {
  test("on pi: sets the session's profile and switches the model to its primary route", () => {
    const outcome = runProfileCommand({ kind: "use", name: "cheap" }, env("pi"));
    expect(getSessionProfile()).toBe("cheap");
    expect(piModels).toEqual(["anthropic/claude-haiku-5-5"]);
    expect(outcome).toEqual({ toast: { variant: "success", message: "Profile cheap is in use for this session. Model: anthropic/claude-haiku-5-5." } });
  });

  test("on Claude: the primary route's alias becomes the model; a pi route does not apply", () => {
    runProfileCommand({ kind: "use", name: "claudeish" }, env("claude"));
    expect(claudeModels).toEqual(["sonnet"]);
    const skipped = runProfileCommand({ kind: "use", name: "cheap" }, env("claude"));
    expect(claudeModels).toEqual(["sonnet"]);
    expect(skipped).toMatchObject({ toast: { variant: "success" } });
    expect((skipped as { toast: { message: string } }).toast.message).toContain("no primary route fits claude");
  });

  test("a primary model Claude's picker does not offer is said, and the model stays", () => {
    const outcome = runProfileCommand({ kind: "use", name: "oddball" }, env("claude"));
    expect(claudeModels).toEqual([]);
    expect((outcome as { toast: { message: string } }).toast.message).toContain("claude-sonnet-4-5 is not one /models offers");
  });

  test("a profile with no primary route only routes subagents: the model stays", () => {
    const outcome = runProfileCommand({ kind: "use", name: "nomain" }, env("pi"));
    expect(getSessionProfile()).toBe("nomain");
    expect(piModels).toEqual([]);
    expect((outcome as { toast: { message: string } }).toast.message).toContain("the model stays as it is");
  });

  test("an unknown profile changes nothing and lists the ones there are", () => {
    setSessionProfile("cheap");
    const outcome = runProfileCommand({ kind: "use", name: "nope" }, env("pi"));
    expect(outcome).toEqual({ toast: { variant: "error", message: 'There is no profile "nope". Profiles: cheap, claudeish, oddball, nomain.' } });
    expect(getSessionProfile()).toBe("cheap");
    expect(piModels).toEqual([]);
    expect(runProfileCommand({ kind: "use", name: "__proto__" }, env("pi"))).toMatchObject({ toast: { variant: "error" } });
  });

  test("without a profiles file, or with an invalid one, it says so and changes nothing", () => {
    const missing = runProfileCommand({ kind: "use", name: "cheap" }, env("pi", { path: join(dir, "none.json") }));
    expect((missing as { toast: { message: string } }).toast.message).toContain("There is no profiles file");
    writeFileSync(path, "{ broken");
    const broken = runProfileCommand({ kind: "use", name: "cheap" }, env("pi"));
    expect(broken).toMatchObject({ toast: { variant: "error" } });
    expect((broken as { toast: { message: string } }).toast.message).toContain("cannot be read");
    expect(getSessionProfile()).toBeUndefined();
  });
});

describe("/profile default and clear", () => {
  test("default writes the file, keeping the rest; the session's choice is not touched", () => {
    setSessionProfile("claudeish");
    const outcome = runProfileCommand({ kind: "default", name: "claudeish" }, env("pi"));
    expect(outcome).toMatchObject({ toast: { variant: "success" } });
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.default).toBe("claudeish");
    expect(Object.keys(written.profiles)).toEqual(["cheap", "claudeish", "oddball", "nomain"]);
    expect(piModels).toEqual([]);
    expect(getSessionProfile()).toBe("claudeish");
  });

  test("default with an unknown profile, or a broken file, writes nothing", () => {
    expect(runProfileCommand({ kind: "default", name: "nope" }, env("pi"))).toMatchObject({ toast: { variant: "error" } });
    expect(JSON.parse(readFileSync(path, "utf8")).default).toBe("cheap");
    writeFileSync(path, "{ broken");
    expect(runProfileCommand({ kind: "default", name: "cheap" }, env("pi"))).toMatchObject({ toast: { variant: "error" } });
    expect(readFileSync(path, "utf8")).toBe("{ broken");
  });

  test("clear drops the session's profile and says which default applies", () => {
    setSessionProfile("claudeish");
    expect(runProfileCommand({ kind: "clear" }, env("pi"))).toEqual({ toast: { variant: "success", message: "Session profile cleared; the default profile cheap applies." } });
    expect(getSessionProfile()).toBeUndefined();
    expect(runProfileCommand({ kind: "clear" }, env("pi"))).toEqual({ toast: { variant: "info", message: "No profile was chosen for this session." } });
  });
});

describe("/profile (show)", () => {
  test("the effective routing with the source of each value", () => {
    setSessionProfile("claudeish");
    const outcome = runProfileCommand({ kind: "show" }, env("claude"));
    const text = (outcome as { show: string[] }).show.join("\n");
    expect(text).toContain("Session profile: claudeish");
    expect(text).toContain("Default profile: cheap");
    expect(text).toContain("Main turn (primary): sonnet (session profile claudeish, route primary) · then haiku");
    expect(text).toContain("review-style: haiku (session profile claudeish, route *)");
    // `worker` has a pi model in its file and the session's `*` route covers it.
    expect(text).toContain("worker: haiku (session profile claudeish, route *)");
    expect(text).toContain("Profiles in the file: cheap, claudeish, oddball, nomain");
  });

  test("on pi the default profile applies and the Claude-only route is listed as skipped", () => {
    const text = (runProfileCommand({ kind: "show" }, env("pi")) as { show: string[] }).show.join("\n");
    expect(text).toContain("Default profile: cheap");
    expect(text).toContain("review-style: anthropic/claude-haiku-5-5 (default profile cheap, route review-*) · thinking low");
    expect(text).toContain("worker: anthropic/claude-opus-5-5 (agent file)");
  });

  test("with no file it says where to make one; with a broken one it lists what is ignored", () => {
    const none = (runProfileCommand({ kind: "show" }, env("pi", { path: join(dir, "none.json") })) as { show: string[] }).show;
    expect(none[0]).toContain("There is no profiles file yet");
    expect(none.join("\n")).toContain("No profile is in force");
    writeFileSync(path, JSON.stringify({ version: 1, profiles: { ok: { "*": { model: "a/b" } }, bad: 3 } }));
    const partly = (runProfileCommand({ kind: "show" }, env("pi")) as { show: string[] }).show.join("\n");
    expect(partly).toContain('Ignored: profile "bad" must be an object of routes');
  });
});
