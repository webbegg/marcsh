import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionArgs } from "../cli-args";
import type { ChatMessage } from "../lib/chat-types";
import { openStorage, type Storage } from "../lib/storage";
import { sessionCommand } from "./session";

/** The arguments of one action, without the `kind` every command carries (`Omit` alone would merge the actions). */
type Without<T> = T extends unknown ? Omit<T, "kind"> : never;

let dir: string;
let storage: Storage;
let out: string;
let err: string;
const io = { stdout: (text: string) => void (out += text), stderr: (text: string) => void (err += text) };

const run = (args: Without<SessionArgs>) =>
  sessionCommand({ kind: "session", ...args } as SessionArgs, { storage, io, now: () => new Date(2026, 10, 13, 12) });

const messages: ChatMessage[] = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
  { id: "m2", role: "assistant", parts: [{ type: "text", text: "hi there" }], metadata: { model: "opus" } },
];

const seed = (title: string, cwd = "/work/a") => {
  const session = storage.createSession({ title, cwd, engine: "claude" });
  storage.saveMessages(session.id, messages);
  return session;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-cli-session-"));
  storage = openStorage(":memory:");
  out = "";
  err = "";
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("session list", () => {
  test("says so when there is no session", async () => {
    expect(await run({ action: "list", json: false })).toBe(0);
    expect(out).toBe("No sessions.\n");
  });

  test("prints id, last update, folder and title, newest first", async () => {
    const first = seed("First");
    await Bun.sleep(5);
    const second = seed("Second");

    expect(await run({ action: "list", json: false })).toBe(0);

    const rows = out.trimEnd().split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(second.id);
    expect(rows[0]).toContain("Second");
    expect(rows[0]).toContain("/work/a");
    expect(rows[1]).toContain(first.id);
  });

  test("a title cannot send terminal escapes", async () => {
    seed("evil\x1b]0;pwned\x07title");
    await run({ action: "list", json: false });
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\x07");
  });

  test("--json is an array with ISO dates", async () => {
    const session = seed("One");
    await run({ action: "list", json: true });
    expect(JSON.parse(out)).toEqual([
      {
        id: session.id,
        title: "One",
        cwd: "/work/a",
        createdAt: session.createdAt.toISOString(),
        updatedAt: storage.getSession(session.id)!.updatedAt.toISOString(),
      },
    ]);
  });

  test("--json of no session is an empty array", async () => {
    await run({ action: "list", json: true });
    expect(JSON.parse(out)).toEqual([]);
  });
});

describe("session delete", () => {
  test("deletes that session only", async () => {
    const keep = seed("Keep");
    const drop = seed("Drop");

    expect(await run({ action: "delete", id: drop.id })).toBe(0);

    expect(out).toBe(`Deleted session ${drop.id}\n`);
    expect(storage.getSession(drop.id)).toBeNull();
    expect(storage.getSession(keep.id)).not.toBeNull();
  });

  test("an unknown id exits 1 with a message and deletes nothing", async () => {
    const keep = seed("Keep");
    expect(await run({ action: "delete", id: "nope" })).toBe(1);
    expect(err).toBe('marcsh: no session with id "nope"\n');
    expect(out).toBe("");
    expect(storage.getSession(keep.id)).not.toBeNull();
  });
});

describe("session export", () => {
  test("prints the markdown transcript to stdout by default", async () => {
    const session = seed("Greeting");
    expect(await run({ action: "export", id: session.id, format: "md", force: false })).toBe(0);
    expect(out).toStartWith("# Greeting\n");
    expect(out).toContain("hi there");
    expect(err).toBe("");
  });

  test("--format json prints the json transcript", async () => {
    const session = seed("Greeting");
    await run({ action: "export", id: session.id, format: "json", force: false });
    const transcript = JSON.parse(out);
    expect(transcript.session.id).toBe(session.id);
    expect(transcript.messages).toHaveLength(2);
  });

  test("an unknown id exits 1", async () => {
    expect(await run({ action: "export", id: "nope", format: "md", force: false })).toBe(1);
    expect(err).toBe('marcsh: no session with id "nope"\n');
    expect(out).toBe("");
  });

  test("-o writes the file and prints only its path", async () => {
    const session = seed("Greeting");
    const file = join(dir, "out.md");
    expect(await run({ action: "export", id: session.id, format: "md", output: file, force: false })).toBe(0);
    expect(readFileSync(file, "utf8")).toStartWith("# Greeting\n");
    expect(out).toBe(`Wrote ${file}\n`);
  });

  test("-o refuses to replace a file unless --force", async () => {
    const session = seed("Greeting");
    const file = join(dir, "out.md");
    writeFileSync(file, "precious");

    expect(await run({ action: "export", id: session.id, format: "md", output: file, force: false })).toBe(1);
    expect(err).toBe(`marcsh: "${file}" already exists (use --force to replace it)\n`);
    expect(readFileSync(file, "utf8")).toBe("precious");

    err = "";
    expect(await run({ action: "export", id: session.id, format: "md", output: file, force: true })).toBe(0);
    expect(readFileSync(file, "utf8")).toStartWith("# Greeting\n");
    expect(err).toBe("");
  });

  test("-o naming a folder writes the default file name into it", async () => {
    const session = seed("Greeting");
    const folder = join(dir, "exports");
    mkdirSync(folder);
    expect(await run({ action: "export", id: session.id, format: "json", output: folder, force: false })).toBe(0);
    expect(readdirSync(folder)).toEqual([`marcsh-${session.id.slice(0, 8)}-2026-11-13.json`]);
  });

  test("an unwritable path exits 1 with the reason", async () => {
    const session = seed("Greeting");
    const file = join(dir, "missing", "out.md");
    expect(await run({ action: "export", id: session.id, format: "md", output: file, force: false })).toBe(1);
    expect(err).toStartWith(`marcsh: cannot write "${file}": `);
  });
});
