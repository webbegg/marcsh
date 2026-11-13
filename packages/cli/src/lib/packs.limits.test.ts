import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_DOWNLOAD_BYTES, fetchPack, installPack, listPacks, updatePack } from "./packs";

// Every test runs real git processes (fixture repos, fetches), which can take seconds on a busy machine.
setDefaultTimeout(60_000);

const AGENT = "---\nname: Reviewer\ndescription: Reviews\n---\nReview.";
const MB = 1024 * 1024;

// How long the stand-in git below keeps running after it has written its 3 MB.
const STAND_IN_SLEEP_SECONDS = 60;

/** Polls until `check` holds, for at most `timeoutMs`; throws when it never does. Waits for an outcome without a fixed sleep. */
const waitFor = async (check: () => boolean, timeoutMs = 10_000) => {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error("condition never became true");
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** The gaps between ticks of a 10 ms timer while `work` runs; started after the clock so its synchronous start is measured too. */
async function tickGaps(work: () => Promise<unknown>) {
  const gaps: number[] = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
  }, 10);
  try {
    await work();
    gaps.push(performance.now() - last);
  } finally {
    clearInterval(timer);
  }
  return gaps;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();

let work: string;
let fixtures: string;
let root: string;
let urlBase: string;

function commitFiles(repo: string, files: Record<string, string | Buffer>) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "c");
}

function makeRepo(id: string, files: Record<string, string | Buffer>) {
  const repo = join(fixtures, id);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  commitFiles(repo, files);
  return repo;
}

const options = (extra: { limits?: { maxDownloadBytes?: number } } = {}) => ({ confirm: async () => true, root, urlBase, ...extra });

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "marcsh-packs-limits-"));
  fixtures = join(work, "fixtures");
  root = join(work, "packs");
  urlBase = `file://${fixtures}`;
});

afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("the size of a download [S17]", () => {
  test("the cap is 100 MB", () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(100 * MB);
  });

  test("a download over the cap is rejected, and nothing is left behind", async () => {
    // Random bytes do not compress: the pack git downloads is as big as the file.
    makeRepo("acme/flows", { "agents/reviewer.md": AGENT, "assets/blob.bin": randomBytes(3 * MB) });
    await expect(installPack("acme/flows", options({ limits: { maxDownloadBytes: MB } }))).rejects.toThrow(
      "Pack rejected: the download is larger than marcsh accepts (over 1 MB)",
    );
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
    expect(existsSync(join(root, "packs.json"))).toBe(false);
    expect(listPacks({ root })).toEqual([]);
  });

  test("a download under the cap installs as before", async () => {
    makeRepo("acme/flows", { "agents/reviewer.md": AGENT, "assets/blob.bin": randomBytes(3 * MB) });
    expect((await installPack("acme/flows", options({ limits: { maxDownloadBytes: 20 * MB } }))).status).toBe("installed");
    expect(listPacks({ root }).map((pack) => pack.id)).toEqual(["acme/flows"]);
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
  });

  test("an update whose download is over the cap is rejected and keeps the old install", async () => {
    const repo = makeRepo("acme/flows", { "agents/reviewer.md": AGENT });
    await installPack("acme/flows", options());
    const installed = listPacks({ root })[0]!;
    commitFiles(repo, { "assets/blob.bin": randomBytes(3 * MB) });
    await expect(updatePack("acme/flows", { ...options({ limits: { maxDownloadBytes: MB } }) })).rejects.toThrow(/the download is larger than marcsh accepts/);
    expect(listPacks({ root })).toEqual([installed]);
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
  });

  // A stand-in git whose fetch writes 3 MB and then keeps running, as a slow download does: the cap must stop it while it runs.
  test("the cap stops git while it is still downloading", async () => {
    const bin = join(work, "bin");
    const pidFile = join(work, "git.pid");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nfor a in "$@"; do if [ "$a" = fetch ]; then echo $$ > '${pidFile}'; head -c 3145728 /dev/zero > blob; sleep ${STAND_IN_SLEEP_SECONDS} & wait; exit 0; fi; done\nexit 0\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    const started = Date.now();
    try {
      await expect(fetchPack({ url: "file:///nowhere/acme/flows", root, limits: { maxDownloadBytes: MB } })).rejects.toThrow(
        "Pack rejected: the download is larger than marcsh accepts (over 1 MB)",
      );
    } finally {
      process.env.PATH = savedPath;
    }
    // Stopped while git was still running: well before its sleep would have ended (the bound is half of it, so a loaded machine does not trip it).
    expect(Date.now() - started).toBeLessThan((STAND_IN_SLEEP_SECONDS * 1000) / 2);
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await waitFor(() => !alive());
    } finally {
      if (alive()) process.kill(pid, "SIGKILL");
    }
  });
});

describe("the scan does not block the UI [S17]", () => {
  test("a timer keeps firing while a pack of 2,000 small files is installed", async () => {
    const files: Record<string, string> = { "agents/reviewer.md": AGENT };
    for (let i = 0; i < 2000; i++) files[`skills/group${i % 20}/s${i}.md`] = `---\nname: s${i}\ndescription: Skill ${i}\n---\nBody of skill ${i}.\n`;
    makeRepo("acme/flows", files);

    // The timer's own jitter on this machine right now: an idle loop's worst gap. The scan must add less than 200 ms to it, so the check
    // measures the scan (which once held the loop for 571 ms) and not how busy the machine is. Capped so one spike can't hide that block.
    const jitter = Math.min(100, Math.max(...(await tickGaps(() => Bun.sleep(300)))));
    let status = "";
    const gaps = await tickGaps(async () => {
      status = (await installPack("acme/flows", options())).status;
    });
    expect(status).toBe("installed");
    expect(gaps.length).toBeGreaterThan(20);
    expect(Math.max(...gaps)).toBeLessThan(200 + jitter);
  });
});
