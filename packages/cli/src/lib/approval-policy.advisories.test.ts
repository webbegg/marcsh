import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApprovalMode, decideApproval } from "./approval-policy";

// Advisories of the branch review: R1-003 (case-insensitive sensitive paths), R1-005 (nested checkouts), R3 re-review (copy into a linked folder).
const base = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-advisories-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const cwd = join(base, "proj");
const outside = join(base, "outside");
mkdirSync(join(cwd, ".git"), { recursive: true });
mkdirSync(join(cwd, "plain"));
mkdirSync(join(cwd, "nested", ".git"), { recursive: true });
mkdirSync(join(cwd, "filegit"));
writeFileSync(join(cwd, "filegit", ".git"), "gitdir: ../elsewhere\n");
mkdirSync(join(cwd, "dist"));
mkdirSync(join(cwd, "dist2"));
mkdirSync(outside);
symlinkSync(outside, join(cwd, "dist", "x"));
writeFileSync(join(cwd, "x"), "1");

const feature = { kind: "feature", branch: "feat/x" } as const;
const shell = (mode: ApprovalMode, command: string) => decideApproval(mode, { kind: "shell", command }, cwd, feature);
const edit = (mode: ApprovalMode, path: string) => decideApproval(mode, { kind: "edit", path }, cwd, feature);
const reasonOf = (verdict: ReturnType<typeof shell>) => (verdict.action === "ask" ? verdict.reason : "");
const eachShell = (mode: ApprovalMode, commands: string[], expected: string) => {
  for (const command of commands) expect([mode, command, shell(mode, command).action]).toEqual([mode, command, expected]);
};

describe("sensitive paths are matched case-insensitively (R1-003)", () => {
  test("edits to .GIT, .Env, .SSH and other secret-looking names ask", () => {
    for (const path of [".GIT/hooks/pre-commit", ".Git/config", ".Env", ".ENV.local", ".SSH/authorized_keys", ".NPMRC", ".Netrc", "server.KEY", "cert.PEM", "ID_RSA", "Credentials.JSON"]) {
      expect([path, edit("yolo", path).action]).toEqual([path, "ask"]);
    }
  });

  test("redirects and file operands ask too", () => {
    eachShell("yolo", ["echo x > .GIT/hooks/pre-commit", "echo x > .Env", "cp x .SSH/authorized_keys", "tee .GIT/config", "mv x .Env", "touch .NPMRC"], "ask");
  });

  test("the lowercase forms still ask, and the example env files stay exempt in any case", () => {
    for (const path of [".git/hooks/pre-commit", ".env", ".ssh/authorized_keys"]) expect([path, edit("yolo", path).action]).toEqual([path, "ask"]);
    for (const path of [".env.example", ".ENV.EXAMPLE", ".Env.Sample", "plain/a.txt"]) expect([path, edit("yolo", path).action]).toEqual([path, "allow"]);
  });
});

describe("a write inside a nested checkout asks (R1-005)", () => {
  test("an edit, a redirect and a file operand name the other checkout", () => {
    for (const mode of ["auto", "yolo"] as const) {
      expect(reasonOf(edit(mode, "nested/file.txt"))).toContain("an edit inside another checkout (nested/file.txt)");
      expect(reasonOf(edit(mode, "filegit/file.txt"))).toContain("an edit inside another checkout (filegit/file.txt)");
      expect(reasonOf(shell(mode, "echo x > nested/a.txt"))).toContain("a redirect inside another checkout (nested/a.txt)");
      expect(reasonOf(shell(mode, "echo x > filegit/sub/a.txt"))).toContain("a redirect inside another checkout (filegit/sub/a.txt)");
      expect(reasonOf(shell(mode, "cp x nested/y"))).toContain("a write by cp inside another checkout (nested/y)");
      expect(reasonOf(shell(mode, "touch filegit/y"))).toContain("a write by touch inside another checkout (filegit/y)");
    }
  });

  test("ordinary edits, and the root's own .git folder, do not count", () => {
    expect(edit("yolo", "plain/a.txt").action).toBe("allow");
    expect(edit("auto", "src/new/a.txt").action).toBe("allow");
    eachShell("yolo", ["echo x > plain/a.txt", "cp x plain/y", "touch plain/z"], "allow");
  });

  test("normal mode keeps the existing flow", () => {
    expect(edit("normal", "nested/file.txt").action).toBe("unchanged");
  });
});

describe("a copy or move into a folder holding a link reports the link's target (R3 re-review)", () => {
  test("cp x dist/ asks when dist/x is a link to a folder outside the project", () => {
    eachShell("yolo", ["cp x dist/", "cp x dist", "cp -t dist x", "cp --target-directory=dist x", "mv x dist/", "install x dist/", "ln -s x dist/"], "ask");
    expect(reasonOf(shell("yolo", "cp x dist/"))).toContain("outside the project (dist/x)");
  });

  test("the same commands run when the destination holds no link", () => {
    eachShell("yolo", ["cp x dist2/", "cp x dist2", "cp -t dist2 x", "mv x dist2/", "install x dist2/", "cp x plain/y"], "allow");
  });
});

describe("the landing name is only checked when the destination is a folder (verification blocker)", () => {
  test("a copy onto a file name, onto a device, or with a variable into a folder without links still runs", () => {
    mkdirSync(join(cwd, "out"), { recursive: true });
    writeFileSync(join(cwd, "out", "x.ts"), "1");
    eachShell(
      "yolo",
      ['cp "$f" out/x.ts', "cp x out/x.ts", 'cp "$f" out/', 'for f in src/*.ts; do cp "$f" out/; done', "cp x /dev/null", "mv x /dev/null", "cp src/*.ts out/"],
      "allow",
    );
  });

  test("a variable or glob copied into a folder that holds a symlink asks", () => {
    eachShell("yolo", ['cp "$f" dist/', "cp src/*.ts dist"], "ask");
  });

  test("an ask on the destination is not repeated for the landing name", () => {
    expect(reasonOf(shell("yolo", "cp x ~"))).toBe("marcsh: a write by cp outside the project (~) needs your approval");
  });
});
