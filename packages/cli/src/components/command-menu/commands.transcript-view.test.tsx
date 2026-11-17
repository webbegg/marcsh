import { afterEach, describe, expect, test } from "bun:test";

process.env.MARCSH_DB_PATH = ":memory:";

const { COMMANDS, COMMAND_NAMES } = await import("./commands");
const { transcriptView } = await import("../../providers/transcript-view");
const { defaultKeybinds, resolveKey } = await import("../../lib/keybinds");

afterEach(() => transcriptView.reset());

const command = (name: string) => COMMANDS.find((candidate) => candidate.name === name)!;
function run(name: string, session: unknown = {}) {
  const toasts: { variant?: string; message: string }[] = [];
  const ctx = { args: "", session, toast: { show: (toast: { variant?: string; message: string }) => toasts.push(toast) } };
  void command(name).action!(ctx as never);
  return toasts;
}

describe("/details", () => {
  test("is a command of the open session", () => {
    expect(command("details")).toMatchObject({ value: "/details", scope: "session" });
    expect(COMMAND_NAMES).toContain("details");
  });

  test("toggles the full tool output and says the new state", () => {
    expect(transcriptView.get().details).toBe(false);
    const first = run("details");
    expect(transcriptView.get().details).toBe(true);
    expect(first).toHaveLength(1);
    expect(first[0]!.message).toMatch(/shown in full/);
    const second = run("details");
    expect(transcriptView.get().details).toBe(false);
    expect(second[0]!.message).toMatch(/collapsed/);
  });

  test("leaves the thinking switch alone", () => {
    run("details");
    expect(transcriptView.get().thinking).toBe(false);
  });

  test("on the home screen says it works inside a session and changes nothing", () => {
    const toasts = run("details", null);
    expect(toasts[0]!.message).toBe("/details works inside a session. Open one first.");
    expect(transcriptView.get().details).toBe(false);
  });
});

describe("/thinking", () => {
  test("toggles the full thinking and says the new state", () => {
    expect(command("thinking")).toMatchObject({ value: "/thinking", scope: "session" });
    const first = run("thinking");
    expect(transcriptView.get()).toEqual({ details: false, thinking: true });
    expect(first[0]!.message).toMatch(/shown in full/);
    const second = run("thinking");
    expect(transcriptView.get().thinking).toBe(false);
    expect(second[0]!.message).toMatch(/collapsed/);
  });
});

describe("the default keys of the real command list", () => {
  test("<leader>o runs /details and <leader>h runs /thinking", () => {
    const keybinds = defaultKeybinds(COMMAND_NAMES);
    expect(resolveKey(keybinds, { name: "o" }, true)).toEqual({ action: "command", name: "details" });
    expect(resolveKey(keybinds, { name: "h" }, true)).toEqual({ action: "command", name: "thinking" });
  });
});
