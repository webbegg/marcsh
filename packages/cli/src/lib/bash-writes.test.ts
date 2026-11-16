import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { extractWriteTargets, writesOutsideSurfaces } from "./bash-writes";

// Which files a shell command writes by their literal names (ported from brigadev's bash-writes, on marcsh's command classifier).
// Best effort: variables, globs, substitutions and interpreters are not followed; the working-tree comparison catches those.

const CWD = "/proj";
const targets = (command: string, cwd: string = CWD) => extractWriteTargets(command, cwd);

describe("write targets: redirections", () => {
  test("finds >, >>, >| and &> targets", () => {
    expect(targets("echo hi > a.txt")).toEqual(["/proj/a.txt"]);
    expect(targets("echo hi >> a.txt")).toEqual(["/proj/a.txt"]);
    expect(targets("echo hi >| a.txt")).toEqual(["/proj/a.txt"]);
    expect(targets("make &> build.log")).toEqual(["/proj/build.log"]);
    expect(targets("echo hi >a.txt")).toEqual(["/proj/a.txt"]);
  });

  test("finds fd-prefixed redirections with a file target", () => {
    expect(targets("cmd 2> err.log")).toEqual(["/proj/err.log"]);
    expect(targets("cmd 1>out.log 2>err.log")).toEqual(["/proj/out.log", "/proj/err.log"]);
  });

  test("finds a redirection that has no command", () => {
    expect(targets("> empty.txt")).toEqual(["/proj/empty.txt"]);
  });

  test("finds cat heredocs written to a file and ignores the body", () => {
    expect(targets("cat > src/a.ts <<'EOF'\necho x > not-a-target.txt\nEOF")).toEqual(["/proj/src/a.ts"]);
  });

  test("ignores descriptor duplication, /dev sinks and quoted operators", () => {
    expect(targets("npm test 2>&1")).toEqual([]);
    expect(targets("cmd >&2")).toEqual([]);
    expect(targets("cmd > /dev/null 2>&1")).toEqual([]);
    expect(targets("cmd &> /dev/null")).toEqual([]);
    expect(targets("cmd > /dev/stdout")).toEqual([]);
    expect(targets("cmd 2> /dev/stderr")).toEqual([]);
    expect(targets('grep ">" src/a.ts')).toEqual([]);
    expect(targets("awk '$1 > 3' data.txt")).toEqual([]);
    expect(targets("echo a\\>b")).toEqual([]);
  });

  test("handles quoted targets with spaces", () => {
    expect(targets('echo hi > "my file.txt"')).toEqual(["/proj/my file.txt"]);
  });

  test("skips variable, substitution and glob targets", () => {
    expect(targets('echo hi > "$F"')).toEqual([]);
    expect(targets("echo hi > $(mktemp)")).toEqual([]);
    expect(targets("echo hi > `mktemp`")).toEqual([]);
    expect(targets("echo hi > out*.txt")).toEqual([]);
  });

  test("keeps absolute targets as they are, including scratch dirs, and expands ~", () => {
    expect(targets("grep -rn x src > /tmp/out")).toEqual(["/tmp/out"]);
    expect(targets("echo hi > ~/x.txt")).toEqual([join(homedir(), "x.txt")]);
  });
});

describe("write targets: commands", () => {
  test("tee, with and without -a", () => {
    expect(targets("echo x | tee a.txt b.txt")).toEqual(["/proj/a.txt", "/proj/b.txt"]);
    expect(targets("echo x | tee -a log.txt")).toEqual(["/proj/log.txt"]);
    expect(targets("echo x | tee")).toEqual([]);
  });

  test("sed in place: -i, -i.bak, --in-place, clustered flags, BSD empty suffix", () => {
    expect(targets("sed -i 's/a/b/' src/a.ts src/b.ts")).toEqual(["/proj/src/a.ts", "/proj/src/b.ts"]);
    expect(targets("sed -i.bak 's/a/b/' src/a.ts")).toEqual(["/proj/src/a.ts"]);
    expect(targets("sed --in-place 's/a/b/' src/a.ts")).toEqual(["/proj/src/a.ts"]);
    expect(targets("sed -ni 's/a/b/p' src/a.ts")).toEqual(["/proj/src/a.ts"]);
    expect(targets("sed -i '' 's/a/b/' src/a.ts")).toEqual(["/proj/src/a.ts"]);
    expect(targets("sed -i -e 's/a/b/' src/a.ts")).toEqual(["/proj/src/a.ts"]);
  });

  test("sed without in-place only reads", () => {
    expect(targets("sed 's/a/b/' src/a.ts")).toEqual([]);
    expect(targets("sed -n -e 's/i/x/p' src/a.ts")).toEqual([]);
    expect(targets("sed -n '/in/p' src/a.ts")).toEqual([]);
  });

  test("cp, install and ln write their destination; mv also takes its sources away", () => {
    expect(targets("cp a.txt b.txt")).toEqual(["/proj/b.txt"]);
    expect(targets("cp -r src dist")).toEqual(["/proj/dist"]);
    expect(targets("mv a.txt src/b.txt")).toEqual(["/proj/a.txt", "/proj/src/b.txt"]);
    expect(targets("install -m 755 tool bin/tool")).toEqual(["/proj/bin/tool"]);
    expect(targets("ln -s ../a.txt link.txt")).toEqual(["/proj/link.txt"]);
    expect(targets("cp a.txt b.txt dir/")).toEqual(["/proj/dir"]);
  });

  test("honours -t / --target-directory", () => {
    expect(targets("cp -t out a.txt b.txt")).toEqual(["/proj/out"]);
    expect(targets("mv --target-directory=out a.txt")).toEqual(["/proj/a.txt", "/proj/out"]);
    expect(targets("cp --target-directory out a.txt")).toEqual(["/proj/out"]);
  });

  test("rm and the downloads of curl and wget write too", () => {
    expect(targets("rm -rf build old.txt")).toEqual(["/proj/build", "/proj/old.txt"]);
    expect(targets("curl -o dl.bin https://example.com/x")).toEqual(["/proj/dl.bin"]);
    expect(targets("wget -O dl.bin https://example.com/x")).toEqual(["/proj/dl.bin"]);
  });

  test("touch, mkdir and truncate", () => {
    expect(targets("touch a.txt b.txt")).toEqual(["/proj/a.txt", "/proj/b.txt"]);
    expect(targets("mkdir -p src/new/deep")).toEqual(["/proj/src/new/deep"]);
    expect(targets("truncate -s 0 a.log b.log")).toEqual(["/proj/a.log", "/proj/b.log"]);
    expect(targets("truncate --size=0 a.log")).toEqual(["/proj/a.log"]);
    expect(targets("truncate -r ref.log a.log")).toEqual(["/proj/a.log"]);
  });

  test("truncate after a cd is not guessed at: the working-tree comparison covers it", () => {
    expect(targets("cd src && truncate -s 0 a.log")).toEqual([]);
    expect(targets("cd src && truncate -s 0 /abs/a.log")).toEqual(["/abs/a.log"]);
  });

  test("looks through wrappers and shell -c scripts", () => {
    expect(targets("sudo tee a.txt")).toEqual(["/proj/a.txt"]);
    expect(targets("env FOO=1 cp a b")).toEqual(["/proj/b"]);
    expect(targets("bash -c 'echo x > a.txt'")).toEqual(["/proj/a.txt"]);
    expect(targets("sudo truncate -s 0 a.log")).toEqual(["/proj/a.log"]);
  });

  test("collects targets across separators", () => {
    expect([...targets("touch a && echo x > b; cp c d")].sort()).toEqual(["/proj/a", "/proj/b", "/proj/d"]);
    expect(targets("if true; then echo x > a; fi")).toEqual(["/proj/a"]);
  });

  test("does not flag commands that only read", () => {
    expect(targets("npm test")).toEqual([]);
    expect(targets("git status")).toEqual([]);
    expect(targets("cat src/a.ts | grep foo")).toEqual([]);
    expect(targets("ls -la")).toEqual([]);
    expect(targets("cp")).toEqual([]);
  });

  test("an input redirection is not a write, even when the command writes elsewhere", () => {
    expect(targets("wc -l < in.txt")).toEqual([]);
    expect(targets("tee a.txt < in.txt")).toEqual(["/proj/a.txt"]);
    expect(targets("cat <in.txt > out.txt")).toEqual(["/proj/out.txt"]);
  });

  test("skips unresolvable arguments", () => {
    expect(targets('cp a "$DEST"')).toEqual([]);
    expect(targets("touch src/*.ts")).toEqual([]);
    expect(targets("tee $(pwd)/x")).toEqual([]);
  });
});

describe("write targets: working directory", () => {
  test("resolves against a literal cd prefix", () => {
    expect(targets("cd src && echo x > a.ts")).toEqual(["/proj/src/a.ts"]);
    expect(targets("cd /other && touch a")).toEqual(["/other/a"]);
    expect(targets("cd src; cd .. && touch a")).toEqual(["/proj/a"]);
  });

  test("uses the given cwd when there is no cd", () => {
    expect(targets("touch a", "/proj/sub")).toEqual(["/proj/sub/a"]);
  });

  test("drops relative targets after an unresolvable cd, keeps absolute ones", () => {
    expect(targets('cd "$DIR" && touch a /abs/b')).toEqual(["/abs/b"]);
    expect(targets("cd && touch a").every((path) => path.startsWith(homedir()))).toBe(true);
  });
});

describe("write targets: shell syntax that is not a redirection", () => {
  test("ignores > inside arithmetic and [[ ]] comparisons", () => {
    expect(targets("if (( $# > 1 )); then echo many; fi")).toEqual([]);
    expect(targets("n=3; (( n > 100 )) && echo long")).toEqual([]);
    expect(targets("echo $(( 3 > 2 ))")).toEqual([]);
    expect(targets("[[ a > b ]] && echo yes")).toEqual([]);
  });

  test("keeps a real redirect after an arithmetic or [[ ]] test", () => {
    expect(targets("(( x > 1 )) && echo y > README.md")).toEqual(["/proj/README.md"]);
    expect(targets("[[ a > b ]] && echo y > README.md")).toEqual(["/proj/README.md"]);
  });
});

describe("writesOutsideSurfaces", () => {
  const surfaces = ["src/a.ts", "tests"];
  const violations = (command: string, cwd: string = CWD) => writesOutsideSurfaces(command, cwd, CWD, surfaces);

  test("allows writes inside the surfaces", () => {
    expect(violations("echo x > src/a.ts")).toEqual([]);
    expect(violations("sed -i 's/a/b/' tests/x.test.ts")).toEqual([]);
    expect(violations("cd tests && touch new.test.ts")).toEqual([]);
    expect(violations("cp README.md tests/copy.md")).toEqual([]);
  });

  test("reports project paths outside the surfaces, relative to the root", () => {
    expect(violations("cat > src/b.ts <<'E'\nx\nE")).toEqual(["src/b.ts"]);
    expect(violations("echo x > src/b.ts")).toEqual(["src/b.ts"]);
    expect(violations("cp tests/a.ts README.md")).toEqual(["README.md"]);
    expect(violations("touch a b", "/proj/src")).toEqual(["src/a", "src/b"]);
    expect(violations("echo x > ../sibling/file", "/proj/src")).toEqual(["sibling/file"]);
    expect(violations("echo x > ../../outside/file", "/proj/src")).toEqual([]);
    expect(violations("truncate -s 0 src/b.ts")).toEqual(["src/b.ts"]);
    expect(violations("tee src/b.ts < in.txt")).toEqual(["src/b.ts"]);
  });

  test("a copy into a folder is judged by the name it lands on", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-bashwrites-")));
    try {
      mkdirSync(join(root, "tests"));
      mkdirSync(join(root, "src"));
      expect(writesOutsideSurfaces("cp README.md tests/", root, root, ["tests"])).toEqual([]);
      expect(writesOutsideSurfaces("cp README.md src/", root, root, ["src/a.ts"])).toEqual(["src/README.md"]);
      // Into a folder, onto a name the surfaces list exactly: the folder itself is not the write.
      expect(writesOutsideSurfaces("cp README.md src/", root, root, ["src/README.md"])).toEqual([]);
      // Not a folder: the destination is the file.
      expect(writesOutsideSurfaces("cp README.md src/new.ts", root, root, ["src/README.md"])).toEqual(["src/new.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leaves targets outside the project root alone, including scratch dirs", () => {
    expect(violations("grep -rn x src > /tmp/out")).toEqual([]);
    expect(violations("echo x > /tmp/scratch/a.txt && cp /tmp/a /tmp/b")).toEqual([]);
    expect(violations("cd /elsewhere && touch a")).toEqual([]);
  });

  test("does not report the project root itself", () => {
    expect(violations("mkdir -p .")).toEqual([]);
  });

  test("skips unresolvable targets", () => {
    expect(violations('echo x > "$F"')).toEqual([]);
  });

  test("a symlink inside the project that leads outside it is outside; one that leads out of the surfaces is a violation", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-bashwrites-")));
    try {
      mkdirSync(join(root, "src"));
      mkdirSync(join(root, "other"));
      symlinkSync(join(root, "other"), join(root, "src", "link"));
      expect(writesOutsideSurfaces("echo x > src/link/f.txt", root, root, ["src"])).toEqual(["other/f.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
