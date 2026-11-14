import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "./storage";
import type { ChatMessage } from "./chat-types";

const message = (id: string, role: ChatMessage["role"], text: string): ChatMessage => ({
  id,
  role,
  parts: [{ type: "text", text }],
});

const conversation = [message("m1", "user", "hello"), message("m2", "assistant", "hi"), message("m3", "user", "more")];

afterEach(() => {
  setSystemTime();
});

describe("renameSession", () => {
  test("changes the title and keeps everything else", () => {
    const storage = openStorage(":memory:");
    const session = storage.createSession({ title: "Old", cwd: "/work", engine: "pi" });
    storage.saveMessages(session.id, conversation, "pi-1");

    expect(storage.renameSession(session.id, "  New title  ")).toBe(true);

    const renamed = storage.getSession(session.id)!;
    expect(renamed.title).toBe("New title");
    expect(renamed.messages).toEqual(conversation);
    expect(renamed.engineSessionRef).toBe("pi-1");
    expect(renamed.engine).toBe("pi");
  });

  test("does not move the session in the recent list", () => {
    const storage = openStorage(":memory:");
    setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const first = storage.createSession({ title: "First", cwd: "/work" });
    setSystemTime(new Date("2030-01-02T00:00:00Z"));
    storage.createSession({ title: "Second", cwd: "/work" });

    setSystemTime(new Date("2030-01-03T00:00:00Z"));
    storage.renameSession(first.id, "Renamed");

    expect(storage.getSession(first.id)?.updatedAt).toEqual(new Date("2030-01-01T00:00:00Z"));
    expect(storage.listSessions().map((s) => s.title)).toEqual(["Second", "Renamed"]);
  });

  test("returns false for an unknown session or a blank title", () => {
    const storage = openStorage(":memory:");
    const session = storage.createSession({ title: "Keep", cwd: "/work" });

    expect(storage.renameSession("missing", "Title")).toBe(false);
    expect(storage.renameSession(session.id, "   ")).toBe(false);
    expect(storage.getSession(session.id)?.title).toBe("Keep");
  });
});

describe("deleteSession", () => {
  test("removes only that session", () => {
    const storage = openStorage(":memory:");
    const doomed = storage.createSession({ title: "Doomed", cwd: "/work" });
    const kept = storage.createSession({ title: "Kept", cwd: "/work" });
    storage.saveMessages(kept.id, conversation, "claude-1");

    expect(storage.deleteSession(doomed.id)).toBe(true);

    expect(storage.getSession(doomed.id)).toBeNull();
    expect(storage.listSessions().map((s) => s.id)).toEqual([kept.id]);
    expect(storage.getSession(kept.id)?.messages).toEqual(conversation);
  });

  test("returns false for an unknown id and changes nothing", () => {
    const storage = openStorage(":memory:");
    const session = storage.createSession({ title: "Kept", cwd: "/work" });

    expect(storage.deleteSession("missing")).toBe(false);

    expect(storage.listSessions()).toHaveLength(1);
    expect(storage.getSession(session.id)).not.toBeNull();
  });

  test("leaves trust, permission rules and command caches alone", () => {
    const storage = openStorage(":memory:");
    const session = storage.createSession({ title: "Doomed", cwd: "/work" });
    storage.setProjectTrust("/work", "trusted", [{ path: ".pi", shown: "a", content: "b" }]);
    storage.addPermissionRule({ cwd: "/work", toolName: "bash", command: "ls" });
    storage.saveClaudeCommands([{ name: "review", description: "Review", argumentHint: "" }]);
    storage.saveCommands("pi", [{ name: "pi-cmd", description: "Pi", argumentHint: "" }]);

    storage.deleteSession(session.id);

    expect(storage.getProjectTrust("/work")).toBe("trusted");
    expect(storage.getProjectReview("/work")).toEqual([{ path: ".pi", shown: "a", content: "b" }]);
    expect(storage.hasPermissionRule({ cwd: "/work", toolName: "bash", command: "ls" })).toBe(true);
    expect(storage.getClaudeCommands().map((c) => c.name)).toEqual(["review"]);
    expect(storage.getCommands("pi").map((c) => c.name)).toEqual(["pi-cmd"]);
  });
});

describe("forkSession", () => {
  test("copies cwd, engine and messages into a new session titled as a fork", () => {
    const storage = openStorage(":memory:");
    const source = storage.createSession({ title: "Chat", cwd: "/work", engine: "pi" });
    storage.saveMessages(source.id, conversation, "pi-ref");

    const fork = storage.forkSession(source.id);

    expect(fork.id).not.toBe(source.id);
    expect(fork.title).toBe("Chat (fork)");
    expect(fork.cwd).toBe("/work");
    expect(fork.engine).toBe("pi");
    expect(fork.messages).toEqual(conversation);
    expect(storage.getSession(fork.id)).toEqual(fork);
  });

  test("does not carry the engine resume ref, for either engine (A2)", () => {
    const storage = openStorage(":memory:");
    for (const engine of ["claude", "pi"]) {
      const source = storage.createSession({ title: "Chat", cwd: "/work", engine });
      storage.saveMessages(source.id, conversation, `${engine}-ref`);

      const fork = storage.forkSession(source.id);

      expect(fork.engineSessionRef).toBeNull();
      expect(storage.getSession(fork.id)?.engineSessionRef).toBeNull();
      expect(storage.getSession(source.id)?.engineSessionRef).toBe(`${engine}-ref`);
    }
  });

  test("stops at the given message, inclusive", () => {
    const storage = openStorage(":memory:");
    const source = storage.createSession({ title: "Chat", cwd: "/work" });
    storage.saveMessages(source.id, conversation);

    const fork = storage.forkSession(source.id, { uptoMessageId: "m2" });

    expect(fork.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  test("leaves the source untouched and the two sessions independent", () => {
    const storage = openStorage(":memory:");
    const source = storage.createSession({ title: "Chat", cwd: "/work" });
    storage.saveMessages(source.id, conversation, "ref");
    const before = storage.getSession(source.id);

    const fork = storage.forkSession(source.id, { uptoMessageId: "m1" });
    storage.saveMessages(fork.id, [...fork.messages, message("m9", "assistant", "only in fork")]);

    expect(storage.getSession(source.id)).toEqual(before);
    expect(storage.listSessions()).toHaveLength(2);
  });

  test("throws for an unknown session or an unknown message and creates nothing", () => {
    const storage = openStorage(":memory:");
    const source = storage.createSession({ title: "Chat", cwd: "/work" });
    storage.saveMessages(source.id, conversation);

    expect(() => storage.forkSession("missing")).toThrow("Unknown session: missing");
    expect(() => storage.forkSession(source.id, { uptoMessageId: "nope" })).toThrow("Unknown message: nope");
    expect(storage.listSessions()).toHaveLength(1);
  });
});

describe("persistence", () => {
  test("rename, fork and delete survive reopening the database file", () => {
    const dir = mkdtempSync(join(tmpdir(), "marcsh-sessions-"));
    const path = join(dir, "marcsh.db");
    try {
      const first = openStorage(path);
      const a = first.createSession({ title: "A", cwd: "/work" });
      const b = first.createSession({ title: "B", cwd: "/work" });
      first.saveMessages(a.id, conversation, "ref");
      first.renameSession(a.id, "A2");
      const fork = first.forkSession(a.id);
      first.deleteSession(b.id);

      const reopened = openStorage(path);
      expect(reopened.getSession(a.id)?.title).toBe("A2");
      expect(reopened.getSession(fork.id)?.engineSessionRef).toBeNull();
      expect(reopened.getSession(b.id)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
