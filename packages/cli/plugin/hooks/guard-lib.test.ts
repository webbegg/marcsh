import { describe, expect, test } from "bun:test";
import { decide, toHookOutput, type BranchInfo, type Decision } from "./guard-lib";

const on = (branch: string, defaultBranch: string | null = null) => (): BranchInfo => ({ branch, defaultBranch });
const deny = (branch: string): Decision => ({
  decision: "deny",
  reason: `marcsh: commits on ${branch} are blocked; create a branch first (git switch -c <type>/<description>)`,
});
const ask = (action: string): Decision => ({ decision: "ask", reason: `marcsh: ${action} needs your approval` });

describe("branch guard", () => {
  test("git commit on main or master is denied when the default branch is unknown", () => {
    expect(decide('git commit -m "x"', on("main"))).toEqual(deny("main"));
    expect(decide('git commit -m "x"', on("master"))).toEqual(deny("master"));
  });

  test("git commit on the known default branch is denied, on main it is not when the default is develop", () => {
    expect(decide("git commit -m x", on("develop", "develop"))).toEqual(deny("develop"));
    expect(decide("git commit -m x", on("main", "develop"))).toBeNull();
  });

  test("git commit on a feature branch is allowed", () => {
    expect(decide("git commit -m x", on("feat/thing", "main"))).toBeNull();
    expect(decide("git commit -m x", on("feat/thing"))).toBeNull();
  });

  test("an unknown current branch never blocks", () => {
    expect(decide("git commit -m x", () => null)).toBeNull();
  });

  test("git -C <dir> commit looks the branch up in that directory", () => {
    const seen: (string | null)[] = [];
    const result = decide("git -C ../other commit -m x", (dir) => {
      seen.push(dir);
      return { branch: "main", defaultBranch: null };
    });
    expect(result).toEqual(deny("main"));
    expect(seen).toEqual(["../other"]);
  });

  test("git global options before the subcommand are skipped", () => {
    expect(decide("git -c user.name=x --no-pager commit -m x", on("main"))).toEqual(deny("main"));
    expect(decide("git --git-dir=.git commit", on("main"))).toEqual(deny("main"));
  });

  test("commits inside chains, pipes, subshells and with env prefixes are found", () => {
    expect(decide("git add -A && git commit -m x", on("main"))).toEqual(deny("main"));
    expect(decide("git add -A; git commit -m x", on("main"))).toEqual(deny("main"));
    expect(decide("false || git commit -m x", on("main"))).toEqual(deny("main"));
    expect(decide("echo hi | git commit -F -", on("main"))).toEqual(deny("main"));
    expect(decide("(git commit -m x)", on("main"))).toEqual(deny("main"));
    expect(decide("git add .\ngit commit -m x", on("main"))).toEqual(deny("main"));
    expect(decide("GIT_AUTHOR_NAME=a HUSKY=0 git commit -m x", on("main"))).toEqual(deny("main"));
    expect(decide("env FOO=1 git commit -m x", on("main"))).toEqual(deny("main"));
    expect(decide("/usr/bin/git commit -m x", on("main"))).toEqual(deny("main"));
  });

  test("a multi-line message in quotes does not hide or fake a commit", () => {
    const command = `git commit -m "$(cat <<'EOF'\nfix: x; git push\nEOF\n)"`;
    expect(decide(command, on("main"))).toEqual(deny("main"));
    expect(decide(command, on("feat/x"))).toBeNull();
  });

  test("creating a branch earlier in the same command lifts the block for that command", () => {
    expect(decide("git switch -c feat/x && git commit -m x", on("main"))).toBeNull();
    expect(decide("git checkout -b feat/x && git commit -m x", on("main"))).toBeNull();
    // Switching to an existing branch is not creation; the commit is still judged on the starting branch.
    expect(decide("git checkout other && git commit -m x", on("main"))).toEqual(deny("main"));
  });

  test("other git commands and look-alikes are not commits", () => {
    expect(decide("git status", on("main"))).toBeNull();
    expect(decide("git log --grep commit", on("main"))).toBeNull();
    expect(decide("git commit-tree HEAD^{tree}", on("main"))).toBeNull();
    expect(decide("echo git commit", on("main"))).toBeNull();
  });

  test("commit under a deny wins over an ask in the same command", () => {
    expect(decide("git commit -m x && git push", on("main"))).toEqual(deny("main"));
  });
});

describe("ship guard", () => {
  const none = () => null;

  test("git push asks", () => {
    expect(decide("git push", none)).toEqual(ask("git push"));
    expect(decide("git push origin feat/x --force-with-lease", none)).toEqual(ask("git push"));
    expect(decide("git -C repo push", none)).toEqual(ask("git push"));
    expect(decide("git add . && git commit -m x && git push", on("feat/x"))).toEqual(ask("git push"));
  });

  test("gh pr create and gh pr merge ask", () => {
    expect(decide('gh pr create --title "x" --body y', none)).toEqual(ask("gh pr create"));
    expect(decide("gh pr merge 12 --squash", none)).toEqual(ask("gh pr merge"));
    expect(decide("gh -R owner/repo pr create", none)).toEqual(ask("gh pr create"));
  });

  test("gh pr view and other gh commands do not ask", () => {
    expect(decide("gh pr view 12", none)).toBeNull();
    expect(decide("gh issue create", none)).toBeNull();
  });

  test("npm, pnpm, yarn and bun publish ask", () => {
    expect(decide("npm publish", none)).toEqual(ask("npm publish"));
    expect(decide("npm publish --access public", none)).toEqual(ask("npm publish"));
    expect(decide("npm --tag next publish", none)).toEqual(ask("npm publish"));
    expect(decide("pnpm publish --no-git-checks", none)).toEqual(ask("pnpm publish"));
    expect(decide("pnpm -r publish", none)).toEqual(ask("pnpm publish"));
    expect(decide("yarn npm publish", none)).toEqual(ask("yarn publish"));
    expect(decide("yarn publish", none)).toEqual(ask("yarn publish"));
    expect(decide("bun publish", none)).toEqual(ask("bun publish"));
  });

  test("running a script that happens to be called publish is not a publish", () => {
    expect(decide("npm run publish", none)).toBeNull();
    expect(decide("bun run publish", none)).toBeNull();
    expect(decide("pnpm exec publish", none)).toBeNull();
  });
});

describe("no decision", () => {
  test("unrelated commands", () => {
    for (const command of ["ls -la", "bun test", "git diff", "cat package.json | grep publish", "", "   "]) {
      expect(decide(command, on("main"))).toBeNull();
    }
  });

  test("an unparsable command is not a decision", () => {
    expect(decide('git commit -m "unterminated', on("main"))).toBeNull();
    expect(decide("git push 'oops", on("main"))).toBeNull();
  });

  test("a lookup that throws is not a decision", () => {
    expect(
      decide("git commit -m x", () => {
        throw new Error("no git");
      }),
    ).toBeNull();
  });

  // Documented behavior: text inside quotes is data, so these are NOT matched.
  test("quoted text is not matched: echo \"git push\" is no push", () => {
    expect(decide('echo "git push"', on("main"))).toBeNull();
    expect(decide("echo 'git commit -m x'", on("main"))).toBeNull();
    expect(decide('grep -r "gh pr create" .', on("main"))).toBeNull();
  });

  // Known false negatives (documented in guard-lib.ts): the shell is not run, so indirection hides the action.
  test("known false negatives: shell -c strings, aliases and eval are not looked into", () => {
    expect(decide('bash -c "git push"', on("main"))).toBeNull();
    expect(decide('eval "git commit -m x"', on("main"))).toBeNull();
    expect(decide("git ci -m x", on("main"))).toBeNull();
  });
});

describe("toHookOutput", () => {
  test("shapes the PreToolUse decision", () => {
    expect(toHookOutput({ decision: "ask", reason: "r" })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "r" },
    });
    expect(toHookOutput({ decision: "deny", reason: "r" }).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
