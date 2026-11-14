import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApprovalMode, decideApproval } from "./approval-policy";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-floor-")));
mkdirSync(join(cwd, ".git", "hooks"), { recursive: true });
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
const shell = (mode: ApprovalMode, command: string) => decideApproval(mode, { kind: "shell", command }, cwd).action;

describe("a merge through gh api is a merge", () => {
  test("merging a PR, a branch or moving a branch remotely asks in yolo", () => {
    for (const command of [
      "gh api -XPUT repos/o/r/pulls/1/merge",
      "gh api --method=PUT /repos/o/r/pulls/2/merge -f merge_method=squash",
      "gh api repos/o/r/merges -f base=main -f head=feat",
      "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
      "gh api graphql -f query='mutation{enablePullRequestAutoMerge(input:{}){clientMutationId}}'",
      "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc",
      "gh api -X PUT repos/o/r/contents/README.md -f message=x -f content=eA==",
    ]) {
      expect(shell("yolo", command)).toBe("ask");
    }
  });

  test("other gh api writes stay delivery, reads stay ordinary", () => {
    expect(shell("yolo", "gh api -X POST repos/o/r/issues/1/comments -f body=x")).toBe("allow");
    expect(shell("yolo", "gh api repos/o/r/pulls/1")).toBe("allow");
  });

  test("a request body from a file is a write", () => {
    expect(shell("auto", "gh api --input body.json repos/o/r/pulls")).toBe("ask");
  });
});

describe("the floor reads combined short options", () => {
  test("a force push with -f in a group asks in yolo", () => {
    for (const command of ["git push -fu origin feat", "git push -uf origin feat"]) expect(shell("yolo", command)).toBe("ask");
  });
  test("gh api -XPUT is a write and asks in auto", () => {
    expect(shell("auto", "gh api -XPUT repos/o/r/pulls/1/merge")).toBe("ask");
  });
  test("gh api --method=PUT and -X PUT ask in auto, -XDELETE in yolo", () => {
    for (const command of ["gh api --method=PUT repos/o/r/x", "gh api -X PUT repos/o/r/x", "gh api -XPOST repos/o/r/x"]) expect(shell("auto", command)).toBe("ask");
    expect(shell("yolo", "gh api -XDELETE repos/o/r/x")).toBe("ask");
    expect(shell("yolo", "gh api -XPUT repos/o/r/x")).toBe("allow");
  });
  test("grouped -d, -D, -f and -n in git branch, clean and push", () => {
    expect(shell("yolo", "git push -df origin feat")).toBe("ask");
    expect(shell("yolo", "git push --force-with-lease=x origin feat")).toBe("ask");
    expect(shell("yolo", "git branch -fd old")).toBe("ask");
    expect(shell("yolo", "git clean -fdx")).toBe("ask");
    expect(shell("yolo", "git clean -fdn")).toBe("allow");
  });
  test("a plain push is still delivery", () => {
    expect(shell("yolo", "git push -u origin feat")).toBe("allow");
    expect(shell("auto", "git push -u origin feat")).toBe("ask");
  });
});

describe("publish with options before the subcommand asks", () => {
  test("npm, pnpm and yarn", () => {
    for (const command of ["npm -w pkg publish", "npm --workspace pkg publish", "pnpm -r publish", "pnpm --filter x publish", "npm --tag beta publish", "yarn npm publish"]) {
      for (const mode of ["auto", "yolo"] as const) expect(shell(mode, command)).toBe("ask");
    }
  });
  test("unpublish and dist-tag after options ask; a script named publish does not", () => {
    for (const command of ["npm -w pkg unpublish x", "npm --tag beta dist-tag add x@1 beta"]) expect(shell("yolo", command)).toBe("ask");
    for (const command of ["npm run publish", "npm -w pkg run publish", "pnpm dlx publish", "npm dist-tag ls"]) expect(shell("yolo", command)).toBe("allow");
  });
});

describe("wrapper options that take a value do not hide the command", () => {
  test("rm -rf behind xargs, nice, env and timeout asks", () => {
    for (const command of ["ls | xargs -I {} rm -rf {}", "ls | xargs -n 1 rm -rf", "ls | xargs -P 4 rm -rf", "nice -n 10 rm -rf dir", "env -u FOO rm -rf dir", "timeout -s KILL 5 rm -rf dir"]) {
      for (const mode of ["auto", "yolo"] as const) expect(shell(mode, command)).toBe("ask");
    }
  });
  test("other wrappers and their value options", () => {
    for (const command of [
      "xargs -0 rm -rf",
      "xargs --max-args=1 rm -rf",
      "xargs --max-args 1 rm -rf",
      "env -S 'rm -rf dir'",
      "env --split-string='rm -rf dir'",
      "env -C /tmp rm -rf dir",
      "timeout --signal KILL --kill-after 3 5 rm -rf dir",
      "caffeinate -t 5 rm -rf dir",
      "time -f %e rm -rf dir",
      "exec -a name rm -rf dir",
      "nohup rm -rf dir",
    ]) {
      expect(shell("yolo", command)).toBe("ask");
    }
  });
  test("sudo -u bob is privileged and sees the wrapped command", () => {
    const verdict = decideApproval("yolo", { kind: "shell", command: "sudo -u bob rm -rf dir" }, cwd);
    expect(verdict.action).toBe("ask");
    const reason = verdict.action === "ask" ? verdict.reason : "";
    expect(reason).toContain("elevated privileges");
    expect(reason).toContain("rm recursive removal");
  });
  test("a wrapped ordinary command still runs", () => {
    for (const command of ["nice -n 10 ls", "env -u FOO ls", "timeout -s KILL 5 ls", "ls | xargs -n 1 echo"]) expect(shell("yolo", command)).toBe("allow");
  });
});

describe("catastrophic forms with a trailing dot or star are blocked", () => {
  test("rm -rf /. ~/. $HOME/*", () => {
    for (const command of ["rm -rf /.", "rm -rf ~/.", "rm -rf $HOME/*", "rm -rf ${HOME}/*", "rm -rf ~/*/", "rm -rf /*"]) {
      for (const mode of ["normal", "auto", "yolo"] as const) expect(shell(mode, command)).toBe("block");
    }
  });
  test("a folder under home is not catastrophic", () => {
    expect(shell("yolo", "rm -rf ~/projects/x")).toBe("ask");
  });
});

describe("a redirect into a secret or .git file inside the project asks", () => {
  test("like an edit does", () => {
    for (const command of ["echo x > .git/hooks/pre-commit", "echo x > .env", "echo x >> .env.local", "echo x > keys/id_rsa", "echo x > ./.ssh/config"]) {
      for (const mode of ["auto", "yolo"] as const) expect(shell(mode, command)).toBe("ask");
    }
  });
  test("an example env file, a normal file and /dev/null do not", () => {
    for (const command of ["echo x > .env.example", "echo x > out.txt", "echo x > /dev/null", "ls 2>&1"]) expect(shell("yolo", command)).toBe("allow");
  });
});
