import { describe, expect, test } from "bun:test";
import { decide, type BranchInfo, type Decision } from "./guard-lib";

// S12: the branch guard judges the branch the commit lands on, including a switch earlier in the same command.
const LOCAL_BRANCHES = new Set(["main", "develop", "feat/x", "x"]);
const on = (branch: string, defaultBranch: string | null = null) => (): BranchInfo => ({
  branch,
  defaultBranch,
  isLocalBranch: (name) => LOCAL_BRANCHES.has(name),
});
const deny = (branch: string): Decision => ({
  decision: "deny",
  reason: `marcsh: commits on ${branch} are blocked; create a branch first (git switch -c <type>/<description>)`,
});

describe("branch guard follows a switch to an existing branch in the same command", () => {
  test("switching to the default branch and committing is denied", () => {
    expect(decide("git checkout main && git merge --squash feat/x && git commit -m x", on("feat/x"))).toEqual(deny("main"));
    expect(decide("git switch main && git commit -m x", on("feat/x"))).toEqual(deny("main"));
    expect(decide("git checkout develop && git commit -m x", on("feat/x", "develop"))).toEqual(deny("develop"));
  });

  test("creating a branch and switching back to the default does not lift the block", () => {
    expect(decide("git switch -c x; git switch main; git commit -m x", on("main"))).toEqual(deny("main"));
  });

  test("switching from the default to an existing feature branch and committing is allowed", () => {
    expect(decide("git switch feat/x && git commit -m x", on("main"))).toBeNull();
  });
});
