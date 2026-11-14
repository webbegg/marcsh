import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "../lib/storage";

// The commands through the real launcher: routing from the command line, exit codes, and the files they touch. HOME, the database,
// the agent dir and the preferences all live in a temp dir, so no real ~/.marcsh is read or written.

const bin = join(import.meta.dir, "..", "..", "bin", "marcsh");

let dir: string;
let dbPath: string;
let agentDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-cli-proc-"));
  mkdirSync(join(dir, "home"));
  mkdirSync(join(dir, "work"));
  dbPath = join(dir, "marcsh.db");
  agentDir = join(dir, "agent");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function marcsh(args: string[], env: Record<string, string> = {}) {
  const run = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", bin, ...args], {
    cwd: join(dir, "work"),
    env: {
      ...process.env,
      HOME: join(dir, "home"),
      MARCSH_DB_PATH: dbPath,
      MARCSH_AGENT_DIR: agentDir,
      MARCSH_PREFERENCES_PATH: join(dir, "preferences.json"),
      ...env,
    },
    stdin: new Blob([""]),
    timeout: 30_000,
  });
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function seed(title: string, text = "hello") {
  const storage = openStorage(dbPath);
  const session = storage.createSession({ title, cwd: "/w", engine: "claude" });
  storage.saveMessages(session.id, [
    { id: "m1", role: "user", parts: [{ type: "text", text }], metadata: { model: "opus" } },
    { id: "m2", role: "assistant", parts: [{ type: "text", text: "ok" }], metadata: { model: "opus", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 } } },
  ]);
  return session.id;
}

describe("session", () => {
  test("list, export and delete", () => {
    const id = seed("My chat");

    const list = marcsh(["session", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(id);
    expect(list.stdout).toContain("My chat");

    expect(JSON.parse(marcsh(["session", "list", "--json"]).stdout)).toMatchObject([{ id, title: "My chat" }]);

    const exported = marcsh(["session", "export", id]);
    expect(exported.code).toBe(0);
    expect(exported.stdout).toStartWith("# My chat\n");

    const file = join(dir, "work", "chat.json");
    expect(marcsh(["session", "export", id, "--format", "json", "-o", file]).code).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8")).session.id).toBe(id);
    expect(marcsh(["session", "export", id, "-o", file]).code).toBe(1);

    expect(marcsh(["session", "delete", id]).code).toBe(0);
    const again = marcsh(["session", "delete", id]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain(`marcsh: no session with id "${id}"`);
    expect(marcsh(["session", "list"]).stdout).toBe("No sessions.\n");
  });

  test("a big transcript through a pipe arrives whole", () => {
    const id = seed("Big", "x".repeat(3 * 1024 * 1024));
    const exported = marcsh(["session", "export", id]);
    expect(exported.code).toBe(0);
    expect(exported.stdout.length).toBeGreaterThan(3 * 1024 * 1024);
    expect(exported.stdout.endsWith("ok\n")).toBe(true);
  });

  test("a mistake is exit 2 with the usage", () => {
    for (const args of [["session"], ["session", "delete"], ["session", "export", "x", "--format", "xml"], ["session", "list", "--force"]]) {
      const run = marcsh(args);
      expect(run.code).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("Usage: marcsh");
    }
  });
});

describe("stats", () => {
  test("prints the table and the json", () => {
    seed("a");
    const table = marcsh(["stats"]);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain("opus");
    expect(table.stdout).toContain("$0.50");

    const json = JSON.parse(marcsh(["stats", "--days", "7", "--json"]).stdout);
    expect(json).toMatchObject({ days: 7, totals: { sessions: 1, inputTokens: 10, outputTokens: 5, costUsd: 0.5 } });
  });
});

describe("mcp", () => {
  test("add writes the agent dir's mcp.json and list shows it", () => {
    const add = marcsh(["mcp", "add", "fs", "--", "npx", "-y", "--flag", "server"]);
    expect(add.code).toBe(0);
    expect(JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"))).toEqual({ mcpServers: { fs: { command: "npx", args: ["-y", "--flag", "server"] } } });

    const list = marcsh(["mcp", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("fs  npx -y --flag server");

    expect(marcsh(["mcp", "add", "fs", "--", "other"]).code).toBe(1);
    expect(marcsh(["mcp", "add", "fs", "--force", "--", "other"]).code).toBe(0);
  });
});

describe("models", () => {
  test("--engine claude lists the aliases without loading pi", () => {
    const run = marcsh(["models", "--engine", "claude"]);
    expect(run).toMatchObject({ code: 0, stdout: "opus\nsonnet\nhaiku\n" });
    expect(existsSync(agentDir)).toBe(false);
  });
});

describe("upgrade", () => {
  test("downloads from MARCSH_INSTALLER_URL and runs it with --version", async () => {
    const record = join(dir, "record");
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(`#!/usr/bin/env bash\nprintf '%s' "$MARCSH_VERSION" > "$FAKE_OUT"\nexit 3\n`),
    });
    try {
      const url = `http://127.0.0.1:${server.port}/install.sh`;
      const run = await Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", bin, "upgrade", "--version", "v1.2.3"], {
        cwd: join(dir, "work"),
        env: { ...process.env, HOME: join(dir, "home"), MARCSH_INSTALLER_URL: url, FAKE_OUT: record },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await run.exited).toBe(3);
      expect(await new Response(run.stdout).text()).toStartWith(`Downloading the installer from ${url}\n`);
      expect(readFileSync(record, "utf8")).toBe("1.2.3");
    } finally {
      await server.stop(true);
    }
  });
});

describe("help", () => {
  test("each command has its own --help, and --help lists the commands", () => {
    for (const command of ["session", "models", "mcp", "stats", "upgrade"]) {
      const run = marcsh([command, "--help"]);
      expect(run.code).toBe(0);
      expect(run.stdout).toStartWith(`Usage: marcsh ${command}`);
      expect(existsSync(dbPath)).toBe(false);
    }
    const all = marcsh(["--help"]).stdout;
    for (const command of ["session", "models", "mcp", "stats", "upgrade"]) expect(all).toContain(`marcsh ${command}`);
  });

  test("upgrade --version still means the version to install, and a bad value is exit 2", () => {
    const run = marcsh(["upgrade", "--version", "latest"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('invalid --version "latest"');
  });
});
