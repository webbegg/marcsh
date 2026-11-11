import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PackError, fetchPack, hasLeftover, listPacks, lockProblem, removePack } from "./packs";

setDefaultTimeout(60_000);

let work: string;
let root: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "marcsh-t8-verify-"));
  root = join(work, "packs");
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const lockWith = (...ids: string[]) =>
  writeFileSync(
    join(root, "packs.json"),
    JSON.stringify({ packs: ids.map((id) => ({ id, url: `file:///x/${id}`, commit: "a".repeat(40), installedAt: "t" })) }),
  );
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("removing a leftover never reaches past <root>/<owner>/<repo> [S10, R4-002]", () => {
  test("a leftover that is a link to another pack removes the link only", async () => {
    mkdirSync(join(root, "acme/other/src"), { recursive: true });
    writeFileSync(join(root, "acme/other/src/keep.md"), "keep");
    lockWith("acme/other");
    symlinkSync(join(root, "acme/other"), join(root, "acme/flows"));
    expect(await removePack("acme/flows", { root })).toEqual({ status: "removed-leftover" });
    expect(readFileSync(join(root, "acme/other/src/keep.md"), "utf8")).toBe("keep");
    expect(listPacks({ root }).map((p) => p.id)).toEqual(["acme/other"]);
  });

  test("a leftover that is a link to the packs root removes the link only", async () => {
    mkdirSync(join(root, "zed"));
    symlinkSync(root, join(root, "zed/root"));
    writeFileSync(join(root, "marker"), "m");
    expect(await removePack("zed/root", { root })).toEqual({ status: "removed-leftover" });
    expect(readFileSync(join(root, "marker"), "utf8")).toBe("m");
  });

  // On a case-insensitive file system (macOS default) the other spelling names the installed pack's folder.
  test("another spelling of an installed pack's id is not a leftover", async () => {
    mkdirSync(join(root, "acme/flows/src"), { recursive: true });
    lockWith("acme/flows");
    const caseInsensitive = existsSync(join(root, "ACME/FLOWS"));
    if (!caseInsensitive) return;
    expect(hasLeftover("ACME/FLOWS", { root })).toBe(false);
    await expect(removePack("ACME/FLOWS", { root })).rejects.toThrow(PackError);
    expect(existsSync(join(root, "acme/flows/src"))).toBe(true);
    expect(listPacks({ root }).map((p) => p.id)).toEqual(["acme/flows"]);
  });
});

describe("lockProblem [S10, R4-003]", () => {
  test("null for a readable lockfile with entries", () => {
    lockWith("acme/flows");
    expect(lockProblem(root)).toBeNull();
  });

  test("names the cause without the content for an empty file, a directory and an unreadable file", () => {
    writeFileSync(join(root, "packs.json"), "");
    expect(lockProblem(root)).toBe("not valid JSON");
    rmSync(join(root, "packs.json"));
    mkdirSync(join(root, "packs.json"));
    expect(lockProblem(root)).toBe("read error EISDIR");
    rmSync(join(root, "packs.json"), { recursive: true });
    writeFileSync(join(root, "packs.json"), '{"packs": ["SECRET"');
    chmodSync(join(root, "packs.json"), 0);
    try {
      if (process.getuid?.() !== 0) expect(lockProblem(root)).toBe("read error EACCES");
    } finally {
      chmodSync(join(root, "packs.json"), 0o644);
    }
  });
});

// A helper git started keeps its pipes open: the timeout must kill it too, and not wait for the pipes to close.
describe("a fetch that times out stops what git started [S10, R4-005]", () => {
  test("the timeout kills git's process group and settles promptly", async () => {
    const bin = join(work, "bin");
    const pidFile = join(work, "helper.pid");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = fetch ]; then sleep 60 & echo $! > '${pidFile}'; wait; exit 0; fi; done\nexit 0\n`);
    chmodSync(join(bin, "git"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    const started = Date.now();
    try {
      await expect(fetchPack({ url: "file:///nowhere/acme/flows", root, timeoutMs: 1000 })).rejects.toThrow("timed out");
    } finally {
      process.env.PATH = savedPath;
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        // SIGKILL is sent when the call settles; the helper is gone once the system has reaped it.
        for (let waited = 0; alive(pid) && waited < 2000; waited += 50) await Bun.sleep(50);
        const helperAlive = alive(pid);
        if (helperAlive) process.kill(pid, "SIGKILL");
        expect(helperAlive).toBe(false);
      }
    }
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(readdirSync(join(root, ".staging"))).toEqual([]);
  }, 90_000);
});
