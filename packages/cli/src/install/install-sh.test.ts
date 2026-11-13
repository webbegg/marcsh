import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// install.sh against a fake release: a tarball built here and served from 127.0.0.1, a temp HOME, and a PATH whose
// first entry holds a fake `bun`, `uname` and `curl`. Nothing here touches the real ~/.marcsh, ~/.local/bin or ~/.zshrc,
// and nothing leaves the machine (the fake curl answers Bun's installer URL itself).
// Every test has its own sandbox and its own server, so the tests run concurrently. The script starts a few dozen
// processes per run; the timeout leaves room for a machine where starting a process is slow.
// The script's atomic switch uses macOS `mv -h`, so these tests run on macOS only.

setDefaultTimeout(60_000);

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
const installSh = join(repoRoot, "install.sh");
const buildScript = join(repoRoot, "scripts", "build-release.ts");
const BUN_INSTALL_URL = "https://bun.sh/install";

let scratch: string;
const servers: ReturnType<typeof Bun.serve>[] = [];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "marcsh-install-test-"));
});

afterAll(() => {
  for (const server of servers) void server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

let counter = 0;
function freshDir(prefix: string): string {
  const dir = join(scratch, `${prefix}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A hung child must fail its test, not the whole suite: every spawn is killed after this long (the test timeout is 60 s).
const KILL = { timeout: 50_000, killSignal: "SIGKILL" } as const;

function sh(command: string[]): void {
  const result = Bun.spawnSync(command, { env: { ...process.env, COPYFILE_DISABLE: "1" }, ...KILL });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
}

// ---- fake release -------------------------------------------------------------------------------------------------

type Release = { tarball: Uint8Array; sha256File: string };

function withChecksum(tarball: Uint8Array): Release {
  const hex = new Bun.CryptoHasher("sha256").update(tarball).digest("hex");
  return { tarball, sha256File: `${hex}  marcsh.tar.gz\n` };
}

const releases = new Map<string, Release>();

/** A release laid out as the build produces it (top folder marcsh/), with a launcher that prints its version. */
function makeRelease(version: string, { loose = false } = {}): Release {
  const key = loose ? `${version}+loose` : version;
  const known = releases.get(key);
  if (known) return known;
  const stage = freshDir("stage");
  const cli = join(stage, "marcsh", "packages", "cli");
  mkdirSync(join(cli, "bin"), { recursive: true });
  writeFileSync(join(stage, "marcsh", "package.json"), '{ "name": "marcsh", "workspaces": ["packages/*"] }\n');
  writeFileSync(join(stage, "marcsh", "bun.lock"), "{}\n");
  writeFileSync(join(cli, "package.json"), `{\n  "name": "@marcsh/cli",\n  "version": "${version}"\n}\n`);
  writeFileSync(join(cli, "bin", "marcsh"), `#!/bin/sh\necho "marcsh ${version}"\n`);
  chmodSync(join(cli, "bin", "marcsh"), 0o755);
  // `loose`: every file and folder is writable by everyone, as a tarball made under a permissive umask can be.
  if (loose) sh(["/bin/chmod", "-R", "777", join(stage, "marcsh")]);
  const out = join(freshDir("tar"), "marcsh.tar.gz");
  sh(["/usr/bin/tar", "-czf", out, "-C", stage, "marcsh"]);
  const release = withChecksum(readFileSync(out));
  releases.set(key, release);
  return release;
}

/** A tarball with hostile entries. `build` fills `work` and `outside` and returns the paths to hand to tar, as written. */
function makeHostileRelease(build: (work: string, outside: string) => string[]): Release {
  const root = freshDir("hostile");
  const work = join(root, "work");
  const outside = join(root, "outside");
  mkdirSync(join(work, "marcsh", "packages", "cli"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(work, "marcsh", "packages", "cli", "package.json"), '{ "version": "0.1.0" }\n');
  const entries = build(work, outside);
  const out = join(root, "hostile.tar.gz");
  // -P keeps "..", and absolute names, as given.
  sh(["/usr/bin/tar", "-czPf", out, "-C", work, ...entries]);
  return withChecksum(readFileSync(out));
}

// ---- sandbox ------------------------------------------------------------------------------------------------------

type RunResult = { code: number; stdout: string; stderr: string };
type RunOptions = {
  env?: Record<string, string>;
  /** Pipe this script text into `bash -s -- <args>` instead of running the file. */
  pipe?: string;
  path?: string;
  /** Start the installer under this umask (for example "000"). */
  umask?: string;
};

/**
 * A temp HOME, a fakebin directory and a release server of its own. `bun: false` leaves Bun off the PATH (the fake
 * is kept in `bunSrc`).
 */
function makeSandbox({ bun = true } = {}) {
  const root = freshDir("sandbox");
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  const fakebin = join(root, "fakebin");
  const bunLog = join(root, "bun.log");
  const curlLog = join(root, "curl.log");
  const curlArgsLog = join(root, "curl-args.log");
  const bunSrc = join(root, "bunsrc", "bun");
  for (const dir of [home, tmp, fakebin, join(root, "bunsrc")]) mkdirSync(dir);

  const script = (path: string, body: string) => {
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o755);
  };
  // Reads stdin like the real `bun install` could: if the installer let it have the script's stdin, a piped run would break.
  script(
    bunSrc,
    `if [ "\${1:-}" = "--version" ]; then echo "\${FAKE_BUN_VERSION:-1.4.4}"; exit 0; fi
echo "$(pwd -P)|$*" >> "$FAKE_BUN_LOG"
cat > /dev/null
mkdir -p node_modules
if [ -n "\${FAKE_BUN_KILL_INSTALLER:-}" ]; then
  # SIGKILL the installer itself (a crash). Bun's parent is a subshell of the installer: climb to the top install.sh.
  top=$PPID
  while :; do
    up=$(ps -o ppid= -p "$top" | tr -d ' ')
    case "$(ps -o command= -p "$up" 2>/dev/null)" in *bash*install.sh*) top=$up ;; *) break ;; esac
  done
  kill -KILL "$top"
  exit 0
fi
# FAKE_BUN_WAIT_FILE: stay in bun install until the test creates this file (gives up after 30 s).
n=0
while [ -n "\${FAKE_BUN_WAIT_FILE:-}" ] && [ ! -e "$FAKE_BUN_WAIT_FILE" ] && [ "$n" -lt 600 ]; do sleep 0.05; n=$((n + 1)); done
sleep "\${FAKE_BUN_SLEEP:-0}"
exit "\${FAKE_BUN_INSTALL_EXIT:-0}"`,
  );
  if (bun) copyFileSync(bunSrc, join(fakebin, "bun"));
  script(
    join(fakebin, "uname"),
    `case "\${1:-}" in
  -s) echo "\${FAKE_UNAME_S:-Darwin}" ;;
  -m) echo "\${FAKE_UNAME_M:-arm64}" ;;
  *) exec /usr/bin/uname "$@" ;;
esac`,
  );
  // Bun's installer URL is answered here (a script that drops the fake bun in ~/.bun/bin); everything else is real curl.
  script(
    join(fakebin, "curl"),
    `echo "$*" >> "$FAKE_CURL_ARGS_LOG"
for arg in "$@"; do
  if [ "$arg" = "${BUN_INSTALL_URL}" ]; then
    echo "$arg" >> "$FAKE_CURL_LOG"
    if [ -n "\${FAKE_BUN_INSTALLER_FAIL:-}" ]; then exit 22; fi
    echo 'mkdir -p "$HOME/.bun/bin" && cp "'"$FAKE_BUN_SRC"'" "$HOME/.bun/bin/bun"'
    exit 0
  fi
done
if [ -n "\${FAKE_CURL_FAIL:-}" ]; then echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; fi
exec /usr/bin/curl "$@"`,
  );

  const routes = new Map<string, Uint8Array>();
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      const body = routes.get(path);
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    },
  });
  servers.push(server);

  return {
    root,
    home,
    tmp,
    fakebin,
    bunLog,
    curlLog,
    /** Every curl call's arguments, one line each. */
    curlArgsLog,
    bunSrc,
    /** The port of the release server. */
    port: server.port,
    /** The paths the script asked the server for. */
    requests,

    /** Serves `release` as the latest release, or as the one for `version` ("0.1.5", without the v). */
    publish(release: Release, version?: string): void {
      const dir = version === undefined ? "/latest/download" : `/download/v${version}`;
      routes.set(`${dir}/marcsh.tar.gz`, release.tarball);
      routes.set(`${dir}/marcsh.tar.gz.sha256`, new TextEncoder().encode(release.sha256File));
    },

    /** Runs the installer to the end. */
    async run(args: string[], options: RunOptions = {}): Promise<RunResult> {
      return this.start(args, options).done;
    },

    /** Starts the installer and returns its process (to signal it) and the promise of its result. */
    start(args: string[], options: RunOptions = {}) {
      const env: Record<string, string> = {
        HOME: home,
        PATH: options.path ?? `${fakebin}:/usr/bin:/bin`,
        TMPDIR: tmp,
        MARCSH_INSTALL_BASE_URL: `http://127.0.0.1:${server.port}`,
        FAKE_BUN_LOG: bunLog,
        FAKE_CURL_LOG: curlLog,
        FAKE_CURL_ARGS_LOG: curlArgsLog,
        FAKE_BUN_SRC: bunSrc,
        ...options.env,
      };
      const command =
        options.pipe === undefined ? ["/bin/bash", installSh, ...args] : ["/bin/bash", "-s", "--", ...args];
      const proc = Bun.spawn(
        options.umask === undefined
          ? command
          : ["/bin/sh", "-c", 'umask "$1"; shift; exec "$@"', "sh", options.umask, ...command],
        {
          env,
          stdin: options.pipe === undefined ? "ignore" : Buffer.from(options.pipe),
          stdout: "pipe",
          stderr: "pipe",
          ...KILL,
        },
      );
      const done = (async (): Promise<RunResult> => {
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { code, stdout, stderr };
      })();
      return { proc, done };
    },

    /** Publishes `version` as the latest release and runs the installer with no flags. */
    async install(version: string, options: RunOptions = {}): Promise<RunResult> {
      this.publish(makeRelease(version));
      return this.run([], options);
    },
  };
}
type Sandbox = ReturnType<typeof makeSandbox>;

// ---- observations -------------------------------------------------------------------------------------------------

/** Every path under `dir` (links with their target), sorted: lets a test compare "nothing changed". */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((rel) => {
      const full = join(dir, rel);
      return lstatSync(full).isSymbolicLink() ? `${rel} -> ${readlinkSync(full)}` : rel;
    })
    .sort();
}

const appDir = (sb: Sandbox) => join(sb.home, ".marcsh", "app");
const binLink = (sb: Sandbox) => join(sb.home, ".local", "bin", "marcsh");
const installed = (sb: Sandbox) =>
  readdirSync(appDir(sb))
    .filter((name) => name !== "current")
    .sort();
const bunCalls = (sb: Sandbox) => (existsSync(sb.bunLog) ? readFileSync(sb.bunLog, "utf8").trim().split("\n") : []);
const mode = (path: string) => statSync(path).mode & 0o777;
const onPath = (sb: Sandbox) => `${sb.fakebin}:${sb.home}/.local/bin:/usr/bin:/bin`;
const currentLink = (sb: Sandbox) => join(appDir(sb), "current");
const lockDir = (sb: Sandbox) => join(appDir(sb), ".install.lock");
const curlCalls = (sb: Sandbox) =>
  existsSync(sb.curlArgsLog) ? readFileSync(sb.curlArgsLog, "utf8").trim().split("\n") : [];

const launcherOutput = (sb: Sandbox) => Bun.spawnSync([binLink(sb)], KILL).stdout.toString();
/** What an interrupted install leaves in the app folder: staging folders and set-aside copies. */
const leftovers = (sb: Sandbox) =>
  readdirSync(appDir(sb)).filter((name) => name.startsWith(".stage.") || name.startsWith(".replaced."));
const BUN_INSTALL_ARGS = "install --frozen-lockfile --production --ignore-scripts";
/** The log line of a `bun install` that ran in a staging folder of the app folder. */
const stagedInstall = (sb: Sandbox) =>
  new RegExp(`^${realpathSync(appDir(sb)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.stage\\.\\d+\\|${BUN_INSTALL_ARGS}$`);
/** The installer prints one warning about a non-default MARCSH_INSTALL_BASE_URL; the sandbox always sets one. */
const withoutBaseWarning = (stderr: string) =>
  stderr
    .split("\n")
    .filter((line) => !line.includes("MARCSH_INSTALL_BASE_URL"))
    .join("\n");
/** The flags that keep a stalled download from hanging forever. */
const STALL_FLAGS = ["--retry-connrefused", "--speed-time 30", "--speed-limit 1024"];

async function waitFor(what: string, condition: () => boolean, deadlineMs = 10_000): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** A process that stays alive for the test, for a lock to name as its owner. Kill it when done. */
function startSleeper() {
  return Bun.spawn(["/bin/sleep", "120"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", ...KILL });
}
/** The pid of a process that has already exited. */
const deadPid = () => Bun.spawnSync(["/usr/bin/true"], KILL).pid;
function writeLock(sb: Sandbox, pid?: string): void {
  mkdirSync(lockDir(sb), { recursive: true });
  if (pid !== undefined) writeFileSync(join(lockDir(sb), "pid"), `${pid}\n`);
}

/** Puts an executable script first on the sandbox's PATH. */
function fakeTool(sb: Sandbox, name: string, body: string): void {
  writeFileSync(join(sb.fakebin, name), `#!/bin/bash\n${body}\n`);
  chmodSync(join(sb.fakebin, name), 0o755);
}

describe.skipIf(process.platform !== "darwin")("install.sh", () => {
  describe.concurrent("install", () => {
    test("a fresh install unpacks, runs bun install in the version folder, and links marcsh", async () => {
      const sb = makeSandbox();
      const result = await sb.install("0.1.0");

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Installed marcsh 0.1.0");
      expect(result.stdout).toContain("Checksum verified");
      expect(result.stdout).not.toContain("\x1b"); // not a terminal: no colors
      expect(sb.requests).toEqual(["/latest/download/marcsh.tar.gz", "/latest/download/marcsh.tar.gz.sha256"]);

      const dest = join(appDir(sb), "0.1.0");
      expect(existsSync(join(dest, "package.json"))).toBe(true);
      expect(existsSync(join(dest, "bun.lock"))).toBe(true);
      expect(installed(sb)).toEqual(["0.1.0"]);
      expect(realpathSync(join(appDir(sb), "current"))).toBe(realpathSync(dest));
      expect(readlinkSync(binLink(sb))).toBe(join(appDir(sb), "current", "packages", "cli", "bin", "marcsh"));
      expect(launcherOutput(sb)).toBe("marcsh 0.1.0\n");

      // bun install runs in a staging folder of the app folder, which only afterwards becomes the version folder.
      expect(bunCalls(sb)).toEqual([expect.stringMatching(stagedInstall(sb))]);
      expect(existsSync(join(dest, "node_modules"))).toBe(true);
      expect(leftovers(sb)).toEqual([]);
      expect(mode(join(sb.home, ".marcsh"))).toBe(0o700);
      expect(readdirSync(sb.tmp)).toEqual([]); // the temp dir is cleaned up
    });

    test("an existing ~/.marcsh keeps its mode and its other contents", async () => {
      const sb = makeSandbox();
      mkdirSync(join(sb.home, ".marcsh"));
      chmodSync(join(sb.home, ".marcsh"), 0o755);
      writeFileSync(join(sb.home, ".marcsh", "marcsh.db"), "sessions");

      const result = await sb.install("0.1.0");
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("writable by group or others");
      expect(mode(join(sb.home, ".marcsh"))).toBe(0o755);
      expect(readFileSync(join(sb.home, ".marcsh", "marcsh.db"), "utf8")).toBe("sessions");
    });

    test("updating keeps exactly one previous version and removes older ones", async () => {
      const sb = makeSandbox();
      for (const version of ["0.1.0", "0.2.0", "0.3.0"]) expect((await sb.install(version)).code).toBe(0);

      expect(installed(sb)).toEqual(["0.2.0", "0.3.0"]);
      expect(readlinkSync(join(appDir(sb), "current"))).toBe("0.3.0");
      expect(launcherOutput(sb)).toBe("marcsh 0.3.0\n");
      expect(bunCalls(sb)).toHaveLength(3);
    });

    test("re-running the installed version reinstalls it cleanly and keeps the rollback version", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");
      await sb.install("0.2.0");
      writeFileSync(join(appDir(sb), "0.2.0", "stale.txt"), "left over");

      const result = await sb.install("0.2.0");

      expect(result.code).toBe(0);
      expect(installed(sb)).toEqual(["0.1.0", "0.2.0"]);
      expect(existsSync(join(appDir(sb), "0.2.0", "stale.txt"))).toBe(false);
      expect(readlinkSync(join(appDir(sb), "current"))).toBe("0.2.0");
      expect(tree(appDir(sb)).filter((p) => p.includes(".replaced") || p.includes(".stage") || p.includes(".tmp"))).toEqual([]);
    });

    test("does not claim a rollback version that is not on disk", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");
      rmSync(join(appDir(sb), "0.1.0"), { recursive: true }); // `current` now points at nothing

      const result = await sb.install("0.2.0");

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Installed marcsh 0.2.0");
      expect(result.stdout).not.toContain("kept for rollback");
      expect(installed(sb)).toEqual(["0.2.0"]);
    });

    test("releases the lock after a successful and after a failed install", async () => {
      const sb = makeSandbox();
      expect((await sb.install("0.1.0")).code).toBe(0);
      expect(existsSync(lockDir(sb))).toBe(false);
      expect((await sb.install("0.2.0", { env: { FAKE_BUN_INSTALL_EXIT: "1" } })).code).toBe(1);
      expect(existsSync(lockDir(sb))).toBe(false);
    });

    test("a second install started while one runs is refused, and the first one's result stands", async () => {
      const sb = makeSandbox();
      expect((await sb.install("0.1.0")).code).toBe(0);
      const gate = join(sb.root, "gate");
      const first = sb.install("0.2.0", { env: { FAKE_BUN_WAIT_FILE: gate, FAKE_BUN_INSTALL_EXIT: "1" } });
      // The first run holds the lock from here on, and sits in bun install until the gate file exists.
      await waitFor("the first install to take the lock", () => existsSync(lockDir(sb)));
      const second = await sb.install("0.2.0");
      writeFileSync(gate, "");
      expect(second.code).toBe(1);
      expect(second.stderr).toContain("Another install is running"); // the lock names the first run, which is alive
      expect((await first).code).toBe(1);
      expect(readlinkSync(currentLink(sb))).toBe("0.1.0");
      expect(existsSync(lockDir(sb))).toBe(false);
    });

    test("installs the archive the real build script produces", async () => {
      const out = freshDir("real-build");
      const build = Bun.spawn([process.execPath, buildScript, "--out", out], {
        cwd: repoRoot,
        stdout: "ignore",
        stderr: "pipe",
        ...KILL,
      });
      const [buildStderr, buildCode] = await Promise.all([new Response(build.stderr).text(), build.exited]);
      expect({ code: buildCode, stderr: buildCode === 0 ? "" : buildStderr }).toEqual({ code: 0, stderr: "" });
      const version: string = JSON.parse(
        readFileSync(join(repoRoot, "packages", "cli", "package.json"), "utf8"),
      ).version;
      const sb = makeSandbox();
      sb.publish({
        tarball: readFileSync(join(out, "marcsh.tar.gz")),
        sha256File: readFileSync(join(out, "marcsh.tar.gz.sha256"), "utf8"),
      });

      const result = await sb.run([]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Installed marcsh ${version}`);
      expect(installed(sb)).toEqual([version]);
      expect(readlinkSync(currentLink(sb))).toBe(version);
      const launcher = join(appDir(sb), version, "packages", "cli", "bin", "marcsh");
      expect(mode(launcher) & 0o100).toBe(0o100);
      expect(readlinkSync(binLink(sb))).toBe(join(currentLink(sb), "packages", "cli", "bin", "marcsh"));
      expect(bunCalls(sb)).toEqual([expect.stringMatching(stagedInstall(sb))]);
    });

    test("a prerelease version installs", async () => {
      const sb = makeSandbox();
      expect((await sb.install("0.2.0-beta.1")).code).toBe(0);
      expect(installed(sb)).toEqual(["0.2.0-beta.1"]);
    });

    test("MARCSH_VERSION downloads that release", async () => {
      const sb = makeSandbox();
      sb.publish(makeRelease("0.2.0"));
      sb.publish(makeRelease("0.1.5"), "0.1.5");

      const result = await sb.run([], { env: { MARCSH_VERSION: "0.1.5" } });

      expect(result.code).toBe(0);
      expect(sb.requests).toEqual(["/download/v0.1.5/marcsh.tar.gz", "/download/v0.1.5/marcsh.tar.gz.sha256"]);
      expect(installed(sb)).toEqual(["0.1.5"]);
    });

    test("MARCSH_VERSION that the tarball's package.json does not match aborts and changes nothing", async () => {
      const sb = makeSandbox();
      sb.publish(makeRelease("0.3.0"), "0.2.0"); // the release v0.2.0 holds a 0.3.0 build

      const result = await sb.run([], { env: { MARCSH_VERSION: "0.2.0" } });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("0.2.0");
      expect(result.stderr).toContain("0.3.0");
      expect(result.stderr).toContain("Nothing was changed");
      expect(result.stdout).not.toContain("Installed marcsh");
      expect(tree(sb.home)).toEqual([]);
      expect(bunCalls(sb)).toEqual([]);
      expect(readdirSync(sb.tmp)).toEqual([]);
    });

    test("a mismatched MARCSH_VERSION leaves an existing install as it was", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");
      const before = tree(sb.home);
      sb.publish(makeRelease("0.3.0"), "0.2.0");

      const result = await sb.run([], { env: { MARCSH_VERSION: "0.2.0" } });

      expect(result.code).toBe(1);
      expect(tree(sb.home)).toEqual(before);
      expect(readlinkSync(currentLink(sb))).toBe("0.1.0");
    });

    test.concurrent.each(["latest", "v0.1.0", "1.2", "1.2.3/../x", "1.2.3; touch pwned", "1.2.3-"])(
      "MARCSH_VERSION=%p is rejected before anything happens",
      async (value) => {
        const sb = makeSandbox();
        sb.publish(makeRelease("0.1.0"));

        const result = await sb.run([], { env: { MARCSH_VERSION: value } });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("MARCSH_VERSION must look like 0.1.0");
        expect(sb.requests).toEqual([]);
        expect(tree(sb.home)).toEqual([]);
      },
    );

    test("a version with no release fails with the missing URL and changes nothing", async () => {
      const sb = makeSandbox();
      const result = await sb.run([], { env: { MARCSH_VERSION: "9.9.9" } });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Download failed");
      expect(result.stderr).toContain("/download/v9.9.9/marcsh.tar.gz");
      expect(tree(sb.home)).toEqual([]);
      expect(readdirSync(sb.tmp)).toEqual([]);
    });
  });

  describe.concurrent("safety", () => {
    test("a checksum mismatch aborts and changes nothing", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");
      const before = tree(sb.home);
      const bunCallsBefore = bunCalls(sb);
      sb.publish({ ...makeRelease("0.2.0"), sha256File: `${"0".repeat(64)}  marcsh.tar.gz\n` });

      const result = await sb.run([]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Checksum mismatch");
      expect(result.stderr).toContain("Nothing was changed");
      expect(result.stderr).toContain("published at the same moment");
      expect(result.stderr).toContain("run the installer again");
      expect(tree(sb.home)).toEqual(before);
      expect(bunCalls(sb)).toEqual(bunCallsBefore);
      expect(readdirSync(sb.tmp)).toEqual([]);
    });

    test.concurrent.each([
      "http://example.invalid",
      "http://example.invalid:8080/releases",
      "http://127.0.0.1.example.invalid",
      "http://localhost.example.invalid",
      "http://127.0.0.1@example.invalid",
      "ftp://example.invalid",
    ])("the base URL %p is refused before any request", async (base) => {
      const sb = makeSandbox();
      sb.publish(makeRelease("0.1.0"));

      const result = await sb.run([], { env: { MARCSH_INSTALL_BASE_URL: base } });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("MARCSH_INSTALL_BASE_URL must start with https://");
      expect(curlCalls(sb)).toEqual([]);
      expect(sb.requests).toEqual([]);
      expect(tree(sb.home)).toEqual([]);
    });

    test("plain http is accepted for localhost too", async () => {
      const sb = makeSandbox();
      sb.publish(makeRelease("0.1.0"));

      const result = await sb.run([], { env: { MARCSH_INSTALL_BASE_URL: `http://localhost:${sb.port}/` } });

      expect(result.code).toBe(0);
    });

    test("downloads allow only https (loopback http for tests), TLS 1.2+, retry and a connect timeout", async () => {
      const sb = makeSandbox({ bun: false });
      sb.publish(makeRelease("0.1.0"));

      expect((await sb.run(["--with-bun"])).code).toBe(0);

      const calls = curlCalls(sb);
      const bunCall = calls.find((line) => line.includes(BUN_INSTALL_URL)) ?? "";
      for (const flag of ["--proto =https", "--proto-redir =https", "--tlsv1.2", "--retry 3", "--connect-timeout 20", ...STALL_FLAGS]) {
        expect(bunCall).toContain(flag);
      }
      const releaseCalls = calls.filter((line) => line.includes("/latest/download/"));
      expect(releaseCalls).toHaveLength(2);
      for (const line of releaseCalls) {
        const flags = ["--proto =http,https", "--proto-redir =https", "--tlsv1.2", "--retry 3", "--connect-timeout 20"];
        for (const flag of [...flags, ...STALL_FLAGS]) {
          expect(line).toContain(flag);
        }
        expect(line).not.toContain("--max-time");
      }
    });

    test("a GNU-style mv first on PATH (no -h) does not break the atomic switch", async () => {
      const sb = makeSandbox();
      fakeTool(
        sb,
        "mv",
        `for arg in "$@"; do case "$arg" in -*h*) echo "mv: invalid option -- 'h'" >&2; exit 64 ;; esac; done\nexec /bin/mv "$@"`,
      );

      const first = await sb.install("0.1.0");
      const second = await sb.install("0.2.0");

      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(readlinkSync(currentLink(sb))).toBe("0.2.0");
      expect(launcherOutput(sb)).toBe("marcsh 0.2.0\n");
    });

    test.concurrent.each(["directory", "file"])(
      "a real %s at ~/.marcsh/app/current stops the install before anything changes",
      async (kind) => {
        const sb = makeSandbox();
        sb.publish(makeRelease("0.1.0"));
        mkdirSync(appDir(sb), { recursive: true });
        if (kind === "directory") {
          mkdirSync(currentLink(sb));
          writeFileSync(join(currentLink(sb), "mine.txt"), "my files");
        } else {
          writeFileSync(currentLink(sb), "mine");
        }
        const before = tree(sb.home);

        const result = await sb.run([]);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("is not a link");
        expect(result.stderr).toContain(currentLink(sb));
        expect(result.stdout).not.toContain("Installed marcsh");
        expect(tree(sb.home)).toEqual(before);
        expect(bunCalls(sb)).toEqual([]);
        expect(readdirSync(sb.tmp)).toEqual([]);
      },
    );

    test("a lock held by a running installer makes the installer refuse, and the lock stays", async () => {
      const sb = makeSandbox();
      sb.publish(makeRelease("0.1.0"));
      const owner = startSleeper();
      try {
        writeLock(sb, String(owner.pid));
        const before = tree(sb.home);

        const result = await sb.run([]);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("Another install is running");
        expect(result.stderr).toContain(String(owner.pid));
        expect(result.stderr).toContain(lockDir(sb));
        expect(tree(sb.home)).toEqual(before);
        expect(existsSync(lockDir(sb))).toBe(true);
        expect(bunCalls(sb)).toEqual([]);
        expect(readdirSync(sb.tmp)).toEqual([]);
      } finally {
        owner.kill("SIGKILL");
      }
    });

    test("a failure while removing the replaced copy never deletes the live version", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");
      writeFileSync(join(appDir(sb), "0.1.0", "stale.txt"), "left over");
      // Removing the set-aside copy fails (as if interrupted); everything else removes normally.
      fakeTool(
        sb,
        "rm",
        `for arg in "$@"; do case "$arg" in */.replaced.*) if [ -e "$arg" ]; then exit 1; fi ;; esac; done\nexec /bin/rm "$@"`,
      );

      await sb.install("0.1.0");

      // The new copy is live: no stale file, and `current` still resolves to it.
      expect(existsSync(join(appDir(sb), "0.1.0", "package.json"))).toBe(true);
      expect(existsSync(join(appDir(sb), "0.1.0", "stale.txt"))).toBe(false);
      expect(readlinkSync(currentLink(sb))).toBe("0.1.0");
      expect(launcherOutput(sb)).toBe("marcsh 0.1.0\n");

      // The next run sweeps the copy the failed removal left behind.
      rmSync(join(sb.fakebin, "rm"));
      expect(leftovers(sb).length).toBe(1);
      expect((await sb.install("0.1.0")).code).toBe(0);
      expect(leftovers(sb)).toEqual([]);
    });

    test("a checksum mismatch on a first install leaves HOME empty", async () => {
      const sb = makeSandbox();
      sb.publish({ ...makeRelease("0.1.0"), sha256File: `${"a".repeat(64)}  marcsh.tar.gz\n` });

      const result = await sb.run([]);

      expect(result.code).toBe(1);
      expect(tree(sb.home)).toEqual([]);
    });

    test("a checksum file that is not a checksum aborts", async () => {
      const sb = makeSandbox();
      sb.publish({ ...makeRelease("0.1.0"), sha256File: "<html>not found</html>\n" });

      const result = await sb.run([]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("not a SHA-256 checksum");
      expect(tree(sb.home)).toEqual([]);
    });

    test.concurrent.each([
      ["a  *marcsh.tar.gz name (the binary marker)", (hex: string) => `${hex} *marcsh.tar.gz\n`],
      ["no trailing newline", (hex: string) => `${hex}  marcsh.tar.gz`],
      ["upper-case hex", (hex: string) => `${hex.toUpperCase()}  marcsh.tar.gz\n`],
    ])("a checksum file with %s is accepted", async (_name, format) => {
      const sb = makeSandbox();
      const release = makeRelease("0.1.0");
      sb.publish({ ...release, sha256File: format(release.sha256File.slice(0, 64)) });

      const result = await sb.run([]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Checksum verified");
    });

    test.concurrent.each([
      ["another file name", (hex: string) => `${hex}  evil.tar.gz\n`],
      ["a path in the name", (hex: string) => `${hex}  dist/marcsh.tar.gz\n`],
      ["a different name after the marker", (hex: string) => `${hex} *evil.tar.gz\n`],
      ["no file name", (hex: string) => `${hex}\n`],
      ["one space", (hex: string) => `${hex} marcsh.tar.gz\n`],
      ["three spaces", (hex: string) => `${hex}   marcsh.tar.gz\n`],
      ["extra text after the name", (hex: string) => `${hex}  marcsh.tar.gz extra\n`],
      ["a second line", (hex: string) => `${hex}  marcsh.tar.gz\n${hex}  marcsh.tar.gz\n`],
      ["a blank line after", (hex: string) => `${hex}  marcsh.tar.gz\n\n`],
      ["a line before", (hex: string) => `\n${hex}  marcsh.tar.gz\n`],
      ["CRLF line endings", (hex: string) => `${hex}  marcsh.tar.gz\r\n`],
      ["63 hex digits", (hex: string) => `${hex.slice(1)}  marcsh.tar.gz\n`],
    ])("a checksum file with %s is rejected, even with the right hash", async (_name, format) => {
      const sb = makeSandbox();
      const release = makeRelease("0.1.0");
      sb.publish({ ...release, sha256File: format(release.sha256File.slice(0, 64)) });

      const result = await sb.run([]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("not a SHA-256 checksum for marcsh.tar.gz");
      expect(result.stderr).toContain("Nothing was changed");
      expect(tree(sb.home)).toEqual([]);
      expect(bunCalls(sb)).toEqual([]);
      expect(readdirSync(sb.tmp)).toEqual([]);
    });

    test("a checksum file with CRLF line endings is rejected with a hint about them", async () => {
      const sb = makeSandbox();
      const release = makeRelease("0.1.0");
      sb.publish({ ...release, sha256File: `${release.sha256File.slice(0, 64)}  marcsh.tar.gz\r\n` });

      const result = await sb.run([]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Windows line endings");
    });

    test("a failed bun install leaves the previous version active", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");
      const before = tree(sb.home);

      const result = await sb.install("0.2.0", { env: { FAKE_BUN_INSTALL_EXIT: "1" } });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("bun install failed");
      expect(tree(sb.home)).toEqual(before);
      expect(readlinkSync(join(appDir(sb), "current"))).toBe("0.1.0");
      expect(launcherOutput(sb)).toBe("marcsh 0.1.0\n");
      expect(readdirSync(sb.tmp)).toEqual([]);
    });

    test("a failed reinstall of the current version puts the old copy back", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");
      writeFileSync(join(appDir(sb), "0.1.0", "marker.txt"), "still here");

      const result = await sb.install("0.1.0", { env: { FAKE_BUN_INSTALL_EXIT: "1" } });

      expect(result.code).toBe(1);
      expect(readFileSync(join(appDir(sb), "0.1.0", "marker.txt"), "utf8")).toBe("still here");
      expect(readlinkSync(join(appDir(sb), "current"))).toBe("0.1.0");
      expect(installed(sb)).toEqual(["0.1.0"]);
    });

    test("a failed first install leaves no version, no current and no link", async () => {
      const sb = makeSandbox();
      const result = await sb.install("0.1.0", { env: { FAKE_BUN_INSTALL_EXIT: "1" } });

      expect(result.code).toBe(1);
      expect(installed(sb)).toEqual([]);
      expect(existsSync(join(appDir(sb), "current"))).toBe(false);
      expect(existsSync(join(sb.home, ".local"))).toBe(false);
    });

    test.concurrent.each([
      [
        "a .. entry",
        (work: string) => {
          writeFileSync(join(work, "..", "evil.txt"), "x");
          return ["marcsh", "../evil.txt"];
        },
      ],
      [
        "an absolute entry",
        (_work: string, outside: string) => {
          writeFileSync(join(outside, "abs.txt"), "x");
          return ["marcsh", join(outside, "abs.txt")];
        },
      ],
      [
        "a .. inside marcsh/",
        (work: string) => {
          writeFileSync(join(work, "escape.txt"), "x");
          return ["marcsh", "marcsh/../escape.txt"];
        },
      ],
      [
        "an entry outside marcsh/",
        (work: string) => {
          writeFileSync(join(work, "other.txt"), "x");
          return ["marcsh", "other.txt"];
        },
      ],
      [
        "a symlink",
        (work: string) => {
          symlinkSync("/etc", join(work, "marcsh", "link"));
          return ["marcsh"];
        },
      ],
    ])("a tarball with %s is rejected before unpacking", async (_name, build) => {
      const sb = makeSandbox();
      sb.publish(makeHostileRelease(build));

      const result = await sb.run([]);

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/Unsafe path|outside marcsh\/|link or special file/);
      expect(result.stderr).toContain("Nothing was changed");
      expect(tree(sb.home)).toEqual([]);
      expect(bunCalls(sb)).toEqual([]);
      expect(readdirSync(sb.tmp)).toEqual([]);
    });

    test("a tarball whose version is not a version is rejected before HOME is touched", async () => {
      const sb = makeSandbox();
      sb.publish(makeRelease("../../x"));

      const result = await sb.run([]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Could not read a valid version");
      expect(tree(sb.home)).toEqual([]);
    });

    test("a tarball without the launcher is rejected before HOME is touched", async () => {
      const sb = makeSandbox();
      sb.publish(makeHostileRelease(() => ["marcsh"]));

      const result = await sb.run([]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("has no marcsh/packages/cli/bin/marcsh");
      expect(tree(sb.home)).toEqual([]);
    });
  });

  describe.concurrent("interrupted installs", () => {
    test("a SIGKILL during a same-version reinstall leaves the working copy, and the next run cleans up", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");
      writeFileSync(join(appDir(sb), "0.1.0", "old.txt"), "the working copy");

      const killed = await sb.install("0.1.0", { env: { FAKE_BUN_KILL_INSTALLER: "1" } });

      expect(killed.code).not.toBe(0);
      expect(killed.stdout).not.toContain("Installed marcsh");
      expect(bunCalls(sb)).toHaveLength(2); // the killed run did reach bun install
      // The old copy never stopped being the live one: `current` resolves to it, complete, and it still runs.
      expect(readFileSync(join(appDir(sb), "0.1.0", "old.txt"), "utf8")).toBe("the working copy");
      expect(existsSync(join(appDir(sb), "0.1.0", "node_modules"))).toBe(true);
      expect(readlinkSync(currentLink(sb))).toBe("0.1.0");
      expect(launcherOutput(sb)).toBe("marcsh 0.1.0\n");
      // What a crash leaves: the half-built staging folder and the lock.
      expect(leftovers(sb)).toHaveLength(1);
      expect(existsSync(lockDir(sb))).toBe(true);

      const again = await sb.install("0.1.0");

      expect(again.code).toBe(0);
      expect(again.stdout).toContain("stale install lock");
      expect(leftovers(sb)).toEqual([]);
      expect(existsSync(lockDir(sb))).toBe(false);
      expect(installed(sb)).toEqual(["0.1.0"]);
      expect(existsSync(join(appDir(sb), "0.1.0", "old.txt"))).toBe(false); // reinstalled cleanly
      expect(launcherOutput(sb)).toBe("marcsh 0.1.0\n");
    });

    test("a copy set aside by a crash is put back when its version folder is gone", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");
      // The state a crash between the two moves of a reinstall leaves: the working copy aside, nothing in its place.
      renameSync(join(appDir(sb), "0.1.0"), join(appDir(sb), ".replaced.4242"));
      mkdirSync(join(appDir(sb), ".stage.4242"));

      const result = await sb.install("0.2.0");

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("Restored marcsh 0.1.0");
      expect(installed(sb)).toEqual(["0.1.0", "0.2.0"]); // restored, and kept as the rollback version
      expect(existsSync(join(appDir(sb), "0.1.0", "node_modules"))).toBe(true);
    });

    test("a copy set aside by a crash replaces a version folder that was never finished", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");
      renameSync(join(appDir(sb), "0.1.0"), join(appDir(sb), ".replaced.4242"));
      mkdirSync(join(appDir(sb), "0.1.0")); // no node_modules: bun install never finished here
      writeFileSync(join(appDir(sb), "0.1.0", "half.txt"), "half installed");

      const result = await sb.install("0.2.0");

      expect(result.code).toBe(0);
      expect(installed(sb)).toEqual(["0.1.0", "0.2.0"]);
      expect(existsSync(join(appDir(sb), "0.1.0", "half.txt"))).toBe(false);
      expect(existsSync(join(appDir(sb), "0.1.0", "node_modules"))).toBe(true);
    });

    test("a copy set aside by a crash is just removed when the new version folder is complete", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");
      cpSync(join(appDir(sb), "0.1.0"), join(appDir(sb), ".replaced.4242"), { recursive: true });
      writeFileSync(join(appDir(sb), ".replaced.4242", "aside.txt"), "the old copy");

      const result = await sb.install("0.2.0");

      expect(result.code).toBe(0);
      expect(installed(sb)).toEqual(["0.1.0", "0.2.0"]);
      expect(existsSync(join(appDir(sb), "0.1.0", "aside.txt"))).toBe(false);
    });

    test("closing the terminal (SIGHUP) mid-install puts everything back and releases the lock", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");
      writeFileSync(join(appDir(sb), "0.1.0", "old.txt"), "the working copy");

      const gate = join(sb.root, "gate");
      const run = sb.start([], { env: { FAKE_BUN_WAIT_FILE: gate } });
      await waitFor("bun install to start", () => bunCalls(sb).length === 2 && leftovers(sb).length > 0);
      run.proc.kill("SIGHUP"); // bash runs its trap once the bun it is waiting for returns
      writeFileSync(gate, "");
      const result = await run.done;

      expect(result.code).toBe(129);
      expect(leftovers(sb)).toEqual([]);
      expect(existsSync(lockDir(sb))).toBe(false);
      expect(readFileSync(join(appDir(sb), "0.1.0", "old.txt"), "utf8")).toBe("the working copy");
      expect(launcherOutput(sb)).toBe("marcsh 0.1.0\n");
      expect(readdirSync(sb.tmp)).toEqual([]);
    });

    test("a failure removing an old version warns and does not stop the install", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");
      await sb.install("0.2.0");
      fakeTool(sb, "rm", `for arg in "$@"; do case "$arg" in */app/0.1.0) exit 1 ;; esac; done\nexec /bin/rm "$@"`);

      const result = await sb.install("0.3.0");

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("Could not remove the old version");
      expect(result.stdout).toContain("Installed marcsh 0.3.0");
      expect(readlinkSync(currentLink(sb))).toBe("0.3.0");
      expect(launcherOutput(sb)).toBe("marcsh 0.3.0\n");
      expect(installed(sb)).toEqual(["0.1.0", "0.2.0", "0.3.0"]); // the old one stayed; the next run prunes it
    });
  });

  describe.concurrent("lock", () => {
    test.each([
      ["no pid file", undefined],
      ["an empty pid file", ""],
      ["a pid file that is not a number", "not-a-pid"],
      ["the pid of a process that is gone", "dead"],
    ])("a lock with %s is reclaimed with a notice", async (_name, content) => {
      const sb = makeSandbox();
      sb.publish(makeRelease("0.1.0"));
      writeLock(sb, content === "dead" ? String(deadPid()) : content);

      const result = await sb.run([]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("stale install lock");
      expect(result.stdout).toContain("Installed marcsh 0.1.0");
      expect(existsSync(lockDir(sb))).toBe(false);
    });

    test("the lock names the installer that holds it, and is gone afterwards", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");
      sb.publish(makeRelease("0.1.0"));
      const gate = join(sb.root, "gate");
      const run = sb.start([], { env: { FAKE_BUN_WAIT_FILE: gate } });
      await waitFor("the lock owner", () => existsSync(join(lockDir(sb), "pid")));
      expect(readFileSync(join(lockDir(sb), "pid"), "utf8").trim()).toBe(String(run.proc.pid));
      writeFileSync(gate, "");
      expect((await run.done).code).toBe(0);
      expect(existsSync(lockDir(sb))).toBe(false);
    });

    test("--uninstall refuses while an installer holds the lock, and removes nothing", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");
      const owner = startSleeper();
      try {
        writeLock(sb, String(owner.pid));
        const before = tree(sb.home);

        const result = await sb.run(["--uninstall"]);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("Another install is running");
        expect(tree(sb.home)).toEqual(before);
        expect(launcherOutput(sb)).toBe("marcsh 0.1.0\n");
      } finally {
        owner.kill("SIGKILL");
      }
    });

    test("--uninstall reclaims a stale lock and removes the app", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");
      writeLock(sb, String(deadPid()));

      const result = await sb.run(["--uninstall"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("stale install lock");
      expect(existsSync(appDir(sb))).toBe(false);
      expect(existsSync(binLink(sb))).toBe(false);
    });
  });

  describe.concurrent("download base URL", () => {
    test("credentials in the base URL are redacted in a refusal", async () => {
      const sb = makeSandbox();
      const result = await sb.run([], { env: { MARCSH_INSTALL_BASE_URL: "http://deploy:s3cret@example.invalid/releases" } });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("http://***@example.invalid/releases");
      for (const secret of ["s3cret", "deploy"]) expect(result.stdout + result.stderr).not.toContain(secret);
    });

    test("credentials in the base URL are redacted in every message, and a non-default base is warned about once", async () => {
      const sb = makeSandbox();
      const result = await sb.run([], {
        env: { MARCSH_INSTALL_BASE_URL: "https://deploy:s3cret@example.invalid/releases", FAKE_CURL_FAIL: "1" },
      });

      expect(result.code).toBe(1);
      const all = result.stdout + result.stderr;
      for (const secret of ["s3cret", "deploy"]) expect(all).not.toContain(secret);
      expect(result.stdout).toContain("Downloading https://***@example.invalid/releases/latest/download/marcsh.tar.gz");
      expect(result.stderr).toContain("Download failed: https://***@example.invalid/releases/latest/download/marcsh.tar.gz");
      const warnings = result.stderr.split("\n").filter((line) => line.includes("MARCSH_INSTALL_BASE_URL"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("https://***@example.invalid/releases");
    });

    test("a non-default base URL is warned about, with the URL", async () => {
      const sb = makeSandbox();
      sb.publish(makeRelease("0.1.0"));

      const result = await sb.run([], { path: onPath(sb) });

      expect(result.code).toBe(0);
      const warnings = result.stderr.split("\n").filter((line) => line.startsWith("warning:"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("MARCSH_INSTALL_BASE_URL");
      expect(warnings[0]).toContain(`http://127.0.0.1:${sb.port}`);
    });

    test("the default base URL (also when the variable is empty) is not warned about", async () => {
      const sb = makeSandbox();
      // FAKE_CURL_FAIL: nothing leaves the machine; the run stops at the download.
      const result = await sb.run([], { env: { MARCSH_INSTALL_BASE_URL: "", FAKE_CURL_FAIL: "1" } });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("https://github.com/webbegg/marcsh/releases/latest/download/marcsh.tar.gz");
      expect(result.stderr).not.toContain("MARCSH_INSTALL_BASE_URL");
    });
  });

  describe.concurrent("permissions", () => {
    test("under a permissive umask the app folder and the unpacked tree are still not writable by others", async () => {
      const sb = makeSandbox();
      sb.publish(makeRelease("0.1.0", { loose: true }));

      const result = await sb.run([], { umask: "000" });

      expect(result.code).toBe(0);
      expect(mode(join(sb.home, ".marcsh"))).toBe(0o700);
      const app = appDir(sb);
      const writableByOthers = [app, ...readdirSync(app, { recursive: true }).map((rel) => join(app, String(rel)))]
        .filter((path) => !lstatSync(path).isSymbolicLink() && (lstatSync(path).mode & 0o022) !== 0)
        .map((path) => path.slice(app.length));
      expect(writableByOthers).toEqual([]);
      expect(mode(join(app, "0.1.0", "packages", "cli", "bin", "marcsh")) & 0o100).toBe(0o100); // still executable
      expect(launcherOutput(sb)).toBe("marcsh 0.1.0\n");
      expect(lstatSync(join(sb.home, ".local", "bin")).mode & 0o022).toBe(0);
    });

    test.each([0o775, 0o757])("an existing ~/.marcsh with mode %o is warned about and left as it is", async (m) => {
      const sb = makeSandbox();
      mkdirSync(join(sb.home, ".marcsh"));
      chmodSync(join(sb.home, ".marcsh"), m);

      const result = await sb.install("0.1.0");

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("~/.marcsh is writable by group or others");
      expect(mode(join(sb.home, ".marcsh"))).toBe(m);
    });
  });

  describe.concurrent("requirements", () => {
    test.concurrent.each([
      ["Linux", "Linux", "x86_64"],
      ["an unknown OS", "FreeBSD", "arm64"],
    ])("%s is refused", async (_name, os, arch) => {
      const sb = makeSandbox();
      sb.publish(makeRelease("0.1.0"));

      const result = await sb.run([], { env: { FAKE_UNAME_S: os, FAKE_UNAME_M: arch } });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`macOS only (this is ${os})`);
      expect(sb.requests).toEqual([]);
      expect(tree(sb.home)).toEqual([]);
    });

    test("an unsupported Mac architecture is refused", async () => {
      const sb = makeSandbox();
      sb.publish(makeRelease("0.1.0"));

      const result = await sb.run([], { env: { FAKE_UNAME_M: "ppc" } });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Unsupported Mac architecture: ppc");
      expect(tree(sb.home)).toEqual([]);
    });

    test("an Intel Mac (x86_64) is accepted", async () => {
      const sb = makeSandbox();
      expect((await sb.install("0.1.0", { env: { FAKE_UNAME_M: "x86_64" } })).code).toBe(0);
    });

    test("a missing Bun prints Bun's official install command and exits", async () => {
      const sb = makeSandbox({ bun: false });
      sb.publish(makeRelease("0.1.0"));

      const result = await sb.run([]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Bun was not found");
      expect(result.stderr).toContain(`curl -fsSL ${BUN_INSTALL_URL} | bash`);
      expect(result.stderr).toContain("--with-bun");
      expect(sb.requests).toEqual([]);
      expect(tree(sb.home)).toEqual([]);
    });

    test("a Bun older than 1.4 is refused with its version", async () => {
      const sb = makeSandbox();
      sb.publish(makeRelease("0.1.0"));

      const result = await sb.run([], { env: { FAKE_BUN_VERSION: "1.3.12" } });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Bun 1.4 or newer");
      expect(result.stderr).toContain("found Bun 1.3.12");
      expect(sb.requests).toEqual([]);
    });

    test.concurrent.each(["1.4.0", "1.10.2", "2.0.0"])("Bun %s is accepted", async (version) => {
      const sb = makeSandbox();
      expect((await sb.install("0.1.0", { env: { FAKE_BUN_VERSION: version } })).code).toBe(0);
    });

    test.concurrent.each(["0.9.9", "1.0.0", "1.3.99"])("Bun %s is refused", async (version) => {
      const sb = makeSandbox();
      expect((await sb.install("0.1.0", { env: { FAKE_BUN_VERSION: version } })).code).toBe(1);
    });

    test("a Bun in ~/.bun/bin is used when none is on PATH, with a note about PATH", async () => {
      const sb = makeSandbox({ bun: false });
      mkdirSync(join(sb.home, ".bun", "bin"), { recursive: true });
      copyFileSync(sb.bunSrc, join(sb.home, ".bun", "bin", "bun"));
      chmodSync(join(sb.home, ".bun", "bin", "bun"), 0o755);

      const result = await sb.install("0.1.0");

      expect(result.code).toBe(0);
      expect(bunCalls(sb)).toHaveLength(1);
      expect(result.stderr).toContain("'bun' on your PATH");
    });

    test("--with-bun runs Bun's official installer when Bun is missing", async () => {
      const sb = makeSandbox({ bun: false });
      sb.publish(makeRelease("0.1.0"));

      const result = await sb.run(["--with-bun"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Installing Bun with its official installer");
      expect(readFileSync(sb.curlLog, "utf8")).toBe(`${BUN_INSTALL_URL}\n`);
      expect(existsSync(join(sb.home, ".bun", "bin", "bun"))).toBe(true);
      expect(installed(sb)).toEqual(["0.1.0"]);
    });

    test("--with-bun leaves a good Bun alone", async () => {
      const sb = makeSandbox();
      sb.publish(makeRelease("0.1.0"));

      const result = await sb.run(["--with-bun"]);

      expect(result.code).toBe(0);
      expect(existsSync(sb.curlLog)).toBe(false);
    });

    test("--with-bun reports a failing Bun installer and changes nothing", async () => {
      const sb = makeSandbox({ bun: false });
      sb.publish(makeRelease("0.1.0"));

      const result = await sb.run(["--with-bun"], { env: { FAKE_BUN_INSTALLER_FAIL: "1" } });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Bun's installer failed");
      expect(tree(sb.home)).toEqual([]);
    });
  });

  describe.concurrent("PATH", () => {
    test("says how to add ~/.local/bin when it is not on PATH, and leaves ~/.zshrc alone", async () => {
      const sb = makeSandbox();
      const result = await sb.install("0.1.0");

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("~/.local/bin is not on your PATH");
      expect(result.stderr).toContain('export PATH="$HOME/.local/bin:$PATH"');
      expect(existsSync(join(sb.home, ".zshrc"))).toBe(false);
    });

    test("says nothing about PATH when ~/.local/bin is already on it", async () => {
      const sb = makeSandbox();
      const result = await sb.install("0.1.0", { path: onPath(sb) });

      expect(result.code).toBe(0);
      expect(withoutBaseWarning(result.stderr)).toBe("");
    });

    test.concurrent.each([["/"], ["//"]])("a PATH entry ~/.local/bin%s counts as on PATH", async (slashes) => {
      const sb = makeSandbox();
      const path = `${sb.fakebin}:${sb.home}/.local/bin${slashes}:/usr/bin:/bin`;
      const result = await sb.install("0.1.0", { path });

      expect(result.code).toBe(0);
      expect(withoutBaseWarning(result.stderr)).toBe("");
    });

    test("a PATH entry ~/.local/bin/ counts as on PATH when it is the last or the only other entry", async () => {
      const sb = makeSandbox();
      const result = await sb.install("0.1.0", { path: `${sb.fakebin}:/usr/bin:/bin:${sb.home}/.local/bin/` });

      expect(result.code).toBe(0);
      expect(withoutBaseWarning(result.stderr)).toBe("");
    });

    test("--modify-path leaves ~/.zshrc alone when PATH has ~/.local/bin/ with a trailing slash", async () => {
      const sb = makeSandbox();
      sb.publish(makeRelease("0.1.0"));

      const result = await sb.run(["--modify-path"], { path: `${sb.fakebin}:${sb.home}/.local/bin/:/usr/bin:/bin` });

      expect(result.code).toBe(0);
      expect(existsSync(join(sb.home, ".zshrc"))).toBe(false);
    });

    test.concurrent.each([["bin2"], ["bin/sub"], ["binx/"]])(
      "a PATH entry ~/.local/%s is not ~/.local/bin: the warning stays",
      async (entry) => {
        const sb = makeSandbox();
        const result = await sb.install("0.1.0", { path: `${sb.fakebin}:${sb.home}/.local/${entry}:/usr/bin:/bin` });

        expect(result.code).toBe(0);
        expect(result.stderr).toContain("~/.local/bin is not on your PATH");
      },
    );

    test("--modify-path adds one marked line to ~/.zshrc, once", async () => {
      const sb = makeSandbox();
      writeFileSync(join(sb.home, ".zshrc"), "alias ll='ls -l'"); // no trailing newline
      sb.publish(makeRelease("0.1.0"));

      const first = await sb.run(["--modify-path"]);
      const second = await sb.run(["--modify-path"]);

      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(readFileSync(join(sb.home, ".zshrc"), "utf8")).toBe(
        "alias ll='ls -l'\nexport PATH=\"$HOME/.local/bin:$PATH\" # marcsh installer\n",
      );
      expect(first.stderr).not.toContain("is not on your PATH");
      expect(second.stdout).toContain("already has the marcsh PATH line");
    });

    test("--modify-path creates ~/.zshrc when there is none", async () => {
      const sb = makeSandbox();
      sb.publish(makeRelease("0.1.0"));

      expect((await sb.run(["--modify-path"])).code).toBe(0);
      expect(readFileSync(join(sb.home, ".zshrc"), "utf8")).toBe('export PATH="$HOME/.local/bin:$PATH" # marcsh installer\n');
    });

    test("--modify-path does not touch ~/.zshrc when ~/.local/bin is already on PATH", async () => {
      const sb = makeSandbox();
      sb.publish(makeRelease("0.1.0"));

      const result = await sb.run(["--modify-path"], { path: onPath(sb) });

      expect(result.code).toBe(0);
      expect(existsSync(join(sb.home, ".zshrc"))).toBe(false);
    });

    test("a file that is already ~/.local/bin/marcsh is not replaced", async () => {
      const sb = makeSandbox();
      mkdirSync(join(sb.home, ".local", "bin"), { recursive: true });
      writeFileSync(binLink(sb), "mine");

      const result = await sb.install("0.1.0");

      expect(result.code).toBe(0);
      expect(result.stderr).toContain("was left alone");
      expect(readFileSync(binLink(sb), "utf8")).toBe("mine");
      expect(result.stdout).toContain("not linked");
      expect(result.stdout).toContain(`Run it with:  ${join(currentLink(sb), "packages", "cli", "bin", "marcsh")}`);
      expect(result.stdout).not.toContain("Run it with:  marcsh\n");
    });

    test("a link to something that is not a marcsh install is not replaced", async () => {
      const sb = makeSandbox();
      mkdirSync(join(sb.home, ".local", "bin"), { recursive: true });
      symlinkSync("/usr/bin/true", binLink(sb));

      const result = await sb.install("0.1.0");

      expect(result.code).toBe(0);
      expect(readlinkSync(binLink(sb))).toBe("/usr/bin/true");
      expect(result.stderr).toContain("was left alone");
      expect(result.stderr).toContain("/usr/bin/true");
      expect(result.stderr).toContain("ln -sf");
      expect(result.stdout).toContain("Installed marcsh 0.1.0");
      expect(result.stdout).toContain("not linked");
      expect(result.stdout).toContain(`Run it with:  ${join(currentLink(sb), "packages", "cli", "bin", "marcsh")}`);
      expect(result.stdout).not.toContain("Run it with:  marcsh\n");
    });

    test("a link from an earlier install is replaced, and the success text says to run marcsh", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");

      const result = await sb.install("0.2.0");

      expect(result.stdout).toContain("Run it with:  marcsh\n");
      expect(result.stdout).not.toContain("not linked");
    });
  });

  describe.concurrent("--uninstall", () => {
    test("removes the app and the link and keeps the other ~/.marcsh data", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");
      await sb.install("0.2.0");
      mkdirSync(join(sb.home, ".marcsh", "agent"), { recursive: true });
      writeFileSync(join(sb.home, ".marcsh", "agent", "auth.json"), "login");
      writeFileSync(join(sb.home, ".marcsh", "marcsh.db"), "sessions");

      const result = await sb.run(["--uninstall"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Removed ~/.marcsh/app");
      expect(existsSync(appDir(sb))).toBe(false);
      expect(existsSync(binLink(sb))).toBe(false);
      expect(lstatSync(join(sb.home, ".local", "bin")).isDirectory()).toBe(true);
      expect(tree(join(sb.home, ".marcsh"))).toEqual(["agent", "agent/auth.json", "marcsh.db"]);
      expect(sb.requests).toHaveLength(4); // the two installs, nothing for the uninstall
    });

    test("does not need macOS or Bun", async () => {
      const sb = makeSandbox();
      await sb.install("0.1.0");

      const result = await sb.run(["--uninstall"], { path: "/usr/bin:/bin", env: { FAKE_UNAME_S: "Linux" } });

      expect(result.code).toBe(0);
      expect(existsSync(appDir(sb))).toBe(false);
    });

    test("when nothing is installed it says so and creates nothing", async () => {
      const sb = makeSandbox();
      const result = await sb.run(["--uninstall"]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("nothing to remove");
      expect(tree(sb.home)).toEqual([]);
    });

    test("leaves a ~/.local/bin/marcsh that is not its own link, and a PATH line in ~/.zshrc", async () => {
      const sb = makeSandbox();
      mkdirSync(join(sb.home, ".local", "bin"), { recursive: true });
      symlinkSync("/usr/bin/true", binLink(sb));
      writeFileSync(join(sb.home, ".zshrc"), 'export PATH="$HOME/.local/bin:$PATH" # marcsh installer\n');

      const result = await sb.run(["--uninstall"]);

      expect(result.code).toBe(0);
      expect(readlinkSync(binLink(sb))).toBe("/usr/bin/true");
      expect(result.stdout).toContain("~/.zshrc still has the PATH line");
      expect(readFileSync(join(sb.home, ".zshrc"), "utf8")).toContain("# marcsh installer");
    });
  });

  describe.concurrent("options", () => {
    test("an unknown option prints the usage and exits 2, before anything happens", async () => {
      const sb = makeSandbox();
      sb.publish(makeRelease("0.1.0"));

      const result = await sb.run(["--modify-path", "--nope"]);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("unknown option: --nope");
      expect(result.stderr).toContain("Usage: install.sh");
      expect(sb.requests).toEqual([]);
      expect(tree(sb.home)).toEqual([]);
    });

    test.concurrent.each([
      ["--uninstall", "--modify-path"],
      ["--uninstall", "--with-bun"],
      ["--with-bun", "--uninstall"],
    ])("%s with %s is refused with exit 2 before anything happens", async (first, second) => {
      const sb = makeSandbox();
      await sb.install("0.1.0");
      const before = tree(sb.home);
      const requests = sb.requests.length;
      const result = await sb.run([first, second]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Usage: install.sh");
      expect(tree(sb.home)).toEqual(before);
      expect(sb.requests).toHaveLength(requests);
    });

    test.concurrent.each(["--help", "-h"])("%s lists the options and exits 0", async (flag) => {
      const sb = makeSandbox();
      const result = await sb.run([flag]);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Usage: install.sh");
      for (const option of ["--with-bun", "--modify-path", "--uninstall", "MARCSH_VERSION", "MARCSH_INSTALL_BASE_URL"]) {
        expect(result.stdout).toContain(option);
      }
      expect(tree(sb.home)).toEqual([]);
    });
  });

  describe.concurrent("piped into bash", () => {
    test("`bash -s -- --modify-path` reads the flags and the script from stdin", async () => {
      const sb = makeSandbox();
      sb.publish(makeRelease("0.1.0"));

      const result = await sb.run(["--modify-path"], { pipe: readFileSync(installSh, "utf8") });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Installed marcsh 0.1.0");
      expect(readFileSync(join(sb.home, ".zshrc"), "utf8")).toContain("# marcsh installer");
      expect(bunCalls(sb)).toHaveLength(1); // bun read its stdin and the rest of the script was still intact
    });

    test("an unknown flag still exits 2 when piped", async () => {
      const sb = makeSandbox();
      const result = await sb.run(["--nope"], { pipe: readFileSync(installSh, "utf8") });
      expect(result.code).toBe(2);
    });

    test("a script cut off partway runs nothing and creates nothing", async () => {
      const lines = readFileSync(installSh, "utf8").split("\n");
      expect(lines.at(-2)).toBe('{ main "$@"; }');
      // Eight cut points through the file, and the one that matters most: everything except the last line, `{ main "$@"; }`.
      const cuts = Array.from({ length: 8 }, (_, i) => Math.floor((lines.length * (i + 1)) / 9));
      cuts.push(lines.length - 2);

      const outcomes = await Promise.all(
        cuts.map(async (cut) => {
          const sb = makeSandbox();
          sb.publish(makeRelease("0.1.0"));
          const result = await sb.run(["--modify-path"], { pipe: lines.slice(0, cut).join("\n") });
          return { cut, code: result.code, home: tree(sb.home), requests: sb.requests, tmp: readdirSync(sb.tmp), bun: bunCalls(sb) };
        }),
      );

      for (const outcome of outcomes) {
        expect({ ...outcome, code: undefined }).toEqual({ cut: outcome.cut, code: undefined, home: [], requests: [], tmp: [], bun: [] });
      }
      // Cut right before the call: all functions defined, nothing called, a clean exit.
      expect(outcomes.at(-1)?.code).toBe(0);
    });

    test("a download cut at any byte of a top-level word runs nothing", async () => {
      const text = readFileSync(installSh);
      const offsets: number[] = [];
      let pos = 0;
      for (const line of text.toString("utf8").split("\n")) {
        const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line)?.[0];
        if (word) for (let i = 1; i <= Math.min(word.length + 1, line.length); i++) offsets.push(pos + i);
        pos += Buffer.byteLength(line) + 1;
      }
      expect(offsets.length).toBeGreaterThan(0);
      const outcomes = await Promise.all(
        offsets.map(async (n) => {
          const sb = makeSandbox();
          sb.publish(makeRelease("0.1.0"));
          await sb.run(["--uninstall"], { pipe: text.subarray(0, n).toString("utf8") });
          return {
            n,
            cutAfter: text.subarray(Math.max(0, n - 10), n).toString(),
            home: tree(sb.home),
            requests: sb.requests,
            bun: bunCalls(sb),
          };
        }),
      );
      for (const o of outcomes) expect(o).toEqual({ ...o, home: [], requests: [], bun: [] });
    });

    // A stronger form of "a truncated download runs nothing": cut the script at many bytes. A cut either leaves a syntax
    // error or, once the whole body has arrived, only defines functions; it never prints, calls bun, asks the server for
    // anything or touches HOME. By default it cuts every byte of the last 256 bytes (where the call to main is) and every
    // 61st byte before, to keep the suite fast; the test above covers every cut a command could start at.
    // MARCSH_CUT_EVERY_BYTE=1 cuts at every byte, which takes minutes.
    // Workers each own a sandbox and reuse it, checking after every run, so a failure still names the offset.
    test("a download cut at (nearly) every byte runs nothing", async () => {
      const text = readFileSync(installSh);
      const lastLine = '{ main "$@"; }\n';
      expect(text.toString("utf8").endsWith(lastLine)).toBe(true);
      // Cutting only the final newline leaves the whole call, which is a complete download, so stop short of it.
      const last = text.length - 2;
      const everyByte = process.env.MARCSH_CUT_EVERY_BYTE === "1";
      const offsets: number[] = [];
      for (let n = 1; n <= last; n++) {
        if (everyByte || n > text.length - 256 || n % 61 === 0) offsets.push(n);
      }
      const workers = 8;
      const failures: unknown[] = [];
      await Promise.all(
        Array.from({ length: workers }, async (_, worker) => {
          const sb = makeSandbox();
          sb.publish(makeRelease("0.1.0"));
          for (const n of offsets.filter((_, i) => i % workers === worker)) {
            const result = await sb.run(["--uninstall"], { pipe: text.subarray(0, n).toString("utf8") });
            const seen = { home: tree(sb.home), requests: sb.requests.length, bun: bunCalls(sb), stdout: result.stdout };
            if (seen.home.length || seen.requests || seen.bun.length || seen.stdout) {
              failures.push({ n, cutAfter: text.subarray(Math.max(0, n - 12), n).toString(), ...seen });
              return; // this sandbox is dirty now
            }
          }
        }),
      );
      expect(failures).toEqual([]);
    }, 600_000);

    test("no command in the script reads the stdin the script itself is piped through", async () => {
      const sb = makeSandbox();
      const stdinLog = join(sb.root, "stdin.log");
      // Each of these reads all of its stdin and records what it got, then does its real job. uname always does; the
      // others only when their last argument is an existing file or folder (they have an operand to read, so the script's
      // stdin is not theirs to take). An awk at the end of a pipeline has no such operand and is left alone.
      const swallow = `data=$(cat)
if [ -n "$data" ]; then echo "\${0##*/}: $data" >> "$FAKE_STDIN_LOG"; fi`;
      fakeTool(
        sb,
        "uname",
        `${swallow}
case "\${1:-}" in
  -s) echo "\${FAKE_UNAME_S:-Darwin}" ;;
  -m) echo "\${FAKE_UNAME_M:-arm64}" ;;
  *) exec /usr/bin/uname "$@" ;;
esac`,
      );
      for (const name of ["awk", "sed", "grep", "tail", "tar", "shasum"]) {
        fakeTool(sb, name, `if [ "$#" -gt 0 ] && [ -e "\${!#}" ]; then\n${swallow}\nfi\nexec /usr/bin/${name} "$@"`);
      }
      sb.publish(makeRelease("0.1.0"));
      writeFileSync(join(sb.home, ".zshrc"), "alias ll='ls -l'"); // no trailing newline: tail and grep run on it

      // Anything after the script is stdin that is still unread when the commands run.
      const result = await sb.run(["--modify-path"], {
        pipe: `${readFileSync(installSh, "utf8")}echo TRAILER_RAN\n`,
        env: { FAKE_STDIN_LOG: stdinLog },
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Installed marcsh 0.1.0");
      expect(existsSync(stdinLog) ? readFileSync(stdinLog, "utf8") : "").toBe("");
      expect(result.stdout).toContain("TRAILER_RAN");
    });
  });
});
