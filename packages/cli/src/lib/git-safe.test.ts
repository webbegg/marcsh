import { describe, expect, test } from "bun:test";
import { readOnlyGitArgs, readOnlyGitEnv } from "./git-safe";

// R1-1: a read-only git call in an untrusted folder runs nothing the repo's config or the surrounding git environment names.

describe("readOnlyGitArgs", () => {
  test("switches off the fsmonitor hook, hooks, the pager and optional locks", () => {
    const args = readOnlyGitArgs();
    expect(args.slice(0, 2)).toEqual(["--no-pager", "--no-optional-locks"]);
    for (const option of ["core.fsmonitor=false", "core.untrackedCache=false", "core.hooksPath=/dev/null", "submodule.recurse=false"]) {
      expect(args[args.indexOf(option) - 1]).toBe("-c");
    }
  });
});

describe("readOnlyGitEnv", () => {
  test("drops every inherited GIT_* variable and sets no system config, no locks, no prompt and no pager", () => {
    const env = readOnlyGitEnv({ PATH: "/bin", HOME: "/home/u", GIT_DIR: "/elsewhere", GIT_EXTERNAL_DIFF: "evil", GIT_CONFIG_PARAMETERS: "'core.fsmonitor=evil'" });
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/u",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
    });
  });
});
