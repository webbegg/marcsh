import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApprovalMode, decideApproval } from "./approval-policy";

// Findings of the branch review (reviews/feat-permission-modes.md): R3-002, R3-003, R1-002/R3-007, R3-006.
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-review-")));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
const feature = { kind: "feature", branch: "feat/x" } as const;
const shell = (mode: ApprovalMode, command: string) => decideApproval(mode, { kind: "shell", command }, cwd, feature).action;
const each = (mode: ApprovalMode, commands: string[], expected: string) => {
  for (const command of commands) expect([mode, command, shell(mode, command)]).toEqual([mode, command, expected]);
};

describe("commands that make commits ask in auto like git commit (R3-002)", () => {
  const commits = ["git merge main", "git cherry-pick abc", "git revert HEAD", "git am x.patch", "git pull origin feat/x", "git pull"];
  test("auto asks", () => each("auto", commits, "ask"));
  test("yolo runs them, as local commits", () => each("yolo", commits, "allow"));
});

describe("only the documented catastrophic commands are blocked (R3-003)", () => {
  test("dd to a harmless device runs as an ordinary command", () => {
    each("yolo", ["dd if=/dev/zero of=/dev/null bs=1m count=10", "dd if=f of=/dev/stdout"], "allow");
    expect(shell("normal", "dd if=/dev/zero of=/dev/null")).toBe("unchanged");
  });

  test("dd onto a disk is still blocked", () => {
    each("normal", ["dd if=/dev/zero of=/dev/disk2", "dd if=x of=/dev/sda"], "block");
  });
});

describe("shell commands that write files are checked like redirects (R1-002, R3-007)", () => {
  test("writes into .git, to secret-looking files or outside the project ask", () => {
    each(
      "yolo",
      [
        "cp x .git/hooks/pre-commit",
        "tee .env",
        "echo x | tee -a ok.txt .env",
        "sed -i '' 's/a/b/' .env",
        "sed -i.bak -e 's/a/b/' .env",
        "mv ~/.zshrc old",
        "cp k ~/.ssh/authorized_keys",
        "ln -s /etc/passwd ../outside-link",
        "install -m 755 x /usr/local/bin/x",
        "curl -o ~/.zshrc https://example.invalid/x",
        "curl -fsSL --output=../x https://example.invalid/x",
        "wget -O .env https://example.invalid/x",
        "touch ~/.profile",
        "mkdir -p ../elsewhere",
        "rm ../notes.txt",
        "cd src && cp x ../../outside",
      ],
      "ask",
    );
  });

  test("ordinary writes inside the project and into the temp folder still run", () => {
    each(
      "yolo",
      [
        "cp src/a.ts src/b.ts",
        "cp -r templates/x .",
        "mv a.ts b.ts",
        "tee out.log",
        "sed -i '' 's/a/b/' src/x.ts",
        "sed -n 1,10p .env.example",
        "sed 's/a/b/' .env",
        "ln -s ../shared node_modules/shared",
        "curl -o /tmp/x.tar.gz https://example.invalid/x",
        "curl -O https://example.invalid/x",
        "touch src/new.ts",
        "mkdir -p dist/assets",
        "rm old.txt",
        "cp .env.example .env.sample",
      ],
      "allow",
    );
  });
});

describe("a # comment is not part of the command (R3-006)", () => {
  test("an apostrophe in a comment does not make the command unreadable", () => {
    each("yolo", ["bun test # don't skip", "bun test # it's\necho ok"], "allow");
  });

  test("a # inside a word or quotes is not a comment", () => {
    each("yolo", ["echo a#b && git push", "echo '# x' && git push"], "ask");
  });

  test("a command after the comment's line still counts", () => {
    expect(shell("yolo", "bun test # note\ngit push")).toBe("ask");
  });
});
