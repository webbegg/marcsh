import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openStorage } from "./storage";
import { lastUsedModel } from "./models";

// From the tier 4 verification: a stored messages array whose elements are not all objects must not fail the whole list.
// `session list` and `/sessions` read it, and `stats`, `run -c` and `marcsh -c` read the plain list.
const withRawRow = (messages: string, check: (storage: ReturnType<typeof openStorage>, odd: string, kept: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "marcsh-list-elements-"));
  try {
    const path = join(dir, "marcsh.db");
    const storage = openStorage(path);
    const odd = storage.createSession({ title: "Odd", cwd: "/work" });
    const kept = storage.createSession({ title: "Kept", cwd: "/work" });
    storage.saveMessages(kept.id, [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }], metadata: { model: "opus" } }]);
    const raw = new Database(path);
    raw.query("UPDATE sessions SET messages = $m WHERE id = $id").run({ $m: messages, $id: odd.id });
    raw.close();
    check(storage, odd.id, kept.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("listSessionEntries with odd array elements", () => {
  test("a string, number, boolean, null or array element neither throws nor hides the other rows", () => {
    withRawRow('[{"id":"a","role":"user","parts":[],"metadata":{"model":"sonnet"}},"oops",3,true,null,[1]]', (storage, odd, kept) => {
      const list = storage.listSessionEntries();
      expect(list.find((s) => s.id === odd)).toMatchObject({ model: "sonnet", messageCount: 6 });
      expect(list.find((s) => s.id === kept)).toMatchObject({ model: "opus", messageCount: 1 });
      expect(storage.listSessions().map((s) => s.id).sort()).toEqual([odd, kept].sort());
    });
  });

  test("a string element first or alone is no different", () => {
    for (const messages of ['["oops"]', '["oops",{"metadata":{"model":"haiku"}}]']) {
      withRawRow(messages, (storage, odd) => {
        expect(() => storage.listSessionEntries()).not.toThrow();
        expect(storage.listSessionEntries().find((s) => s.id === odd)!.messageCount).toBe(JSON.parse(messages).length);
      });
    }
  });
});

describe("the listed model is the one a resumed session takes", () => {
  test("an empty model on the last message is skipped, as lastUsedModel skips it", () => {
    const messages = [{ metadata: { model: "opus" } }, { metadata: { model: "" } }];
    withRawRow(JSON.stringify(messages), (storage, odd) => {
      expect(storage.listSessionEntries().find((s) => s.id === odd)!.model).toBe(lastUsedModel(messages)!);
    });
  });

  test("a model that is not text is not listed (marcsh only writes text models)", () => {
    withRawRow(JSON.stringify([{ metadata: { model: "opus" } }, { metadata: { model: 5 } }]), (storage, odd) => {
      expect(storage.listSessionEntries().find((s) => s.id === odd)!.model).toBe("opus");
    });
  });
});
