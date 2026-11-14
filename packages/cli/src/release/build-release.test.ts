import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
const script = join(repoRoot, "scripts", "build-release.ts");

// The hooks run whole builds and git; on a loaded machine that takes longer than Bun's 5 s.
setDefaultTimeout(60_000);

describe("scripts/build-release.ts", () => {
  let out: string;
  let listing: string[];
  let verbose: string[];
  let build: ReturnType<typeof Bun.spawnSync>;

  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "marcsh-release-"));
    build = Bun.spawnSync([process.execPath, script, "--out", out], { cwd: repoRoot });
    const tarball = join(out, "marcsh.tar.gz");
    listing = Bun.spawnSync(["tar", "-tzf", tarball]).stdout.toString().split("\n").filter(Boolean);
    verbose = Bun.spawnSync(["tar", "-tvzf", tarball]).stdout.toString().split("\n").filter(Boolean);
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  test("succeeds and writes the tarball and its checksum", () => {
    expect(build.exitCode).toBe(0);
    expect(listing.length).toBeGreaterThan(0);
  });

  test("puts everything under marcsh/ and ships the launcher executable", () => {
    expect(listing.every((path) => path.startsWith("marcsh/"))).toBe(true);
    expect(listing).toContain("marcsh/package.json");
    expect(listing).toContain("marcsh/bun.lock");
    expect(listing).toContain("marcsh/packages/cli/package.json");
    expect(listing).toContain("marcsh/packages/cli/src/index.tsx");

    const launcher = verbose.find((line) => line.endsWith("marcsh/packages/cli/bin/marcsh"));
    expect(launcher).toBeDefined();
    // `-rwxr-xr-x ...`: the owner can execute it.
    expect(launcher!.slice(0, 10)).toMatch(/^-..x/);
  });

  test("ships no tests, test preloads, bunfig.toml, node_modules, docs or CI files", () => {
    expect(listing.filter((path) => /\.test\.tsx?$/.test(path))).toEqual([]);
    expect(listing.filter((path) => /test-preload/.test(path))).toEqual([]);
    expect(listing.filter((path) => /bunfig\.toml$/.test(path))).toEqual([]);
    expect(listing.filter((path) => path.includes("node_modules"))).toEqual([]);
    expect(listing.filter((path) => /^marcsh\/(docs|scripts|\.github)\//.test(path))).toEqual([]);
    expect(listing).not.toContain("marcsh/README.md");
  });

  test("ships no test-only helper or fixture", () => {
    expect(listing.filter((path) => /(^|\/)test-[^/]*$/.test(path))).toEqual([]);
    expect(listing.filter((path) => /(^|\/)fixtures\//.test(path))).toEqual([]);
    expect(listing).toContain("marcsh/packages/cli/src/lib/engine/pi-trust.ts");
  });

  test("writes a .sha256 in `shasum -a 256` format that matches the tarball", () => {
    const line = readFileSync(join(out, "marcsh.tar.gz.sha256"), "utf8");
    expect(line).toMatch(/^[0-9a-f]{64} {2}marcsh\.tar\.gz\n$/);

    const shasum = Bun.spawnSync(["shasum", "-a", "256", "marcsh.tar.gz"], { cwd: out });
    expect(shasum.exitCode).toBe(0);
    expect(line).toBe(shasum.stdout.toString());
  });

  test("leaves only the two release files: no temp file from the atomic write", () => {
    expect(readdirSync(out).sort()).toEqual(["marcsh.tar.gz", "marcsh.tar.gz.sha256"]);
  });

  test("builds the same tarball twice", () => {
    const again = mkdtempSync(join(tmpdir(), "marcsh-release-"));
    try {
      const run = Bun.spawnSync([process.execPath, script, "--out", again], { cwd: repoRoot });
      expect(run.exitCode).toBe(0);
      expect(readFileSync(join(again, "marcsh.tar.gz.sha256"), "utf8")).toBe(
        readFileSync(join(out, "marcsh.tar.gz.sha256"), "utf8"),
      );
    } finally {
      rmSync(again, { recursive: true, force: true });
    }
  });
});

describe("scripts/build-release.ts when the build fails", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "marcsh-release-fail-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("a failing step exits 1 with a message, removes its staging folder and writes no release file", () => {
    const fakebin = join(root, "fakebin");
    const tmp = join(root, "tmp");
    const out = join(root, "out");
    mkdirSync(fakebin);
    mkdirSync(tmp);
    writeFileSync(join(fakebin, "gzip"), "#!/bin/sh\necho 'gzip: forced failure' >&2\nexit 1\n");
    chmodSync(join(fakebin, "gzip"), 0o755);

    const run = Bun.spawnSync([process.execPath, script, "--out", out], {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${fakebin}:${process.env.PATH}`, TMPDIR: tmp },
      timeout: 120_000,
      killSignal: "SIGKILL",
    });

    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain("build-release: ");
    expect(run.stderr.toString()).toContain("forced failure");
    expect(readdirSync(tmp)).toEqual([]); // the staging folder is gone
    expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
  });

  test("a bad argument exits 1 with a message", () => {
    const run = Bun.spawnSync([process.execPath, script, "--nope"], { cwd: repoRoot, timeout: 60_000, killSignal: "SIGKILL" });

    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain('build-release: unknown argument "--nope"');
  });
});

// The archive holds what is committed at HEAD, not what the working tree happens to hold: a local build with uncommitted
// edits must not ship them. Each test builds in a repository of its own, made here, with a copy of the build script.
describe("scripts/build-release.ts reads the files from HEAD", () => {
  let root: string;
  let outDir: string;
  let listing: string[];
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  };
  const build = () =>
    Bun.spawnSync([process.execPath, join(root, "scripts", "build-release.ts"), "--out", outDir], { cwd: root });
  const unpack = () => {
    const dir = mkdtempSync(join(tmpdir(), "marcsh-release-unpacked-"));
    Bun.spawnSync(["tar", "-xzf", join(outDir, "marcsh.tar.gz"), "-C", dir]);
    return dir;
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "marcsh-release-repo-"));
    outDir = `${root}-out`;
    write("scripts/build-release.ts", readFileSync(script, "utf8"));
    write("packages/cli/src/release/select-files.ts", readFileSync(join(repoRoot, "packages/cli/src/release/select-files.ts"), "utf8"));
    write("package.json", '{ "name": "fixture" }\n');
    write("bun.lock", "{}\n");
    write("packages/cli/package.json", '{ "version": "0.1.0" }\n');
    write("packages/cli/bin/marcsh", "#!/bin/sh\necho committed\n");
    chmodSync(join(root, "packages/cli/bin/marcsh"), 0o755);
    write("packages/cli/src/index.tsx", "committed\n");
    write("packages/cli/src/gone.ts", "committed gone\n");
    write("packages/cli/src/staged.ts", "committed staged\n");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");

    // Uncommitted changes of every kind.
    write("packages/cli/src/index.tsx", "UNCOMMITTED EDIT\n"); // edited, not staged
    write("packages/cli/src/staged.ts", "STAGED EDIT\n");
    git("add", "packages/cli/src/staged.ts"); // edited and staged
    unlinkSync(join(root, "packages/cli/src/gone.ts")); // deleted in the working tree
    write("packages/cli/src/added.ts", "NEVER COMMITTED\n");
    git("add", "packages/cli/src/added.ts"); // staged, new
    write("packages/cli/src/untracked.ts", "UNTRACKED\n");
    chmodSync(join(root, "packages/cli/bin/marcsh"), 0o644); // mode changed in the working tree

    const built = build();
    expect(built.stderr.toString()).toBe("");
    expect(built.exitCode).toBe(0);
    listing = Bun.spawnSync(["tar", "-tzf", join(outDir, "marcsh.tar.gz")]).stdout.toString().split("\n").filter(Boolean);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  test("an uncommitted or staged edit to a tracked file does not appear in the archive", () => {
    const dir = unpack();
    try {
      expect(read("packages/cli/src/index.tsx")).toBe("UNCOMMITTED EDIT\n"); // the working tree really has it
      expect(readFileSync(join(dir, "marcsh/packages/cli/src/index.tsx"), "utf8")).toBe("committed\n");
      expect(readFileSync(join(dir, "marcsh/packages/cli/src/staged.ts"), "utf8")).toBe("committed staged\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file deleted in the working tree is still shipped, and a file that was never committed is not", () => {
    const dir = unpack();
    try {
      expect(readFileSync(join(dir, "marcsh/packages/cli/src/gone.ts"), "utf8")).toBe("committed gone\n");
      expect(listing).not.toContain("marcsh/packages/cli/src/added.ts");
      expect(listing).not.toContain("marcsh/packages/cli/src/untracked.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps the committed modes whatever the working tree says", () => {
    const dir = unpack();
    try {
      const launcher = statSync(join(dir, "marcsh/packages/cli/bin/marcsh")).mode & 0o777;
      expect(launcher).toBe(0o755);
      expect(statSync(join(dir, "marcsh/packages/cli/src/index.tsx")).mode & 0o777).toBe(0o644);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gives the same tarball again, with only the files that are selected", () => {
    const first = readFileSync(join(outDir, "marcsh.tar.gz"));
    expect(build().exitCode).toBe(0);
    expect(readFileSync(join(outDir, "marcsh.tar.gz")).equals(first)).toBe(true);
    expect(listing.slice().sort()).toEqual([
      "marcsh/bun.lock",
      "marcsh/package.json",
      "marcsh/packages/cli/bin/marcsh",
      "marcsh/packages/cli/package.json",
      "marcsh/packages/cli/src/gone.ts",
      "marcsh/packages/cli/src/index.tsx",
      "marcsh/packages/cli/src/release/select-files.ts",
      "marcsh/packages/cli/src/staged.ts",
    ]);
  });
});
