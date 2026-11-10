import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createPiUiContext, CUSTOM_UI_NOTICE } from "./pi-ui";
import type { NoticeLevel, TurnHost } from "./types";

const theme = { name: "fake-theme" } as unknown as Theme;

type Call = { kind: string; args: unknown[]; signal?: AbortSignal };

// A host that records each UI ask and answers it with `answers`; asks without an answer stay open until aborted.
function setup(answers: Partial<Record<"select" | "confirm" | "input" | "editor", unknown>> = {}, withUi = true) {
  const calls: Call[] = [];
  const notices: { message: string; level: NoticeLevel }[] = [];
  const turn = new AbortController();
  const ask = (kind: keyof typeof answers, cancelled: unknown) => (...args: unknown[]) => {
    const signal = args.pop() as AbortSignal;
    calls.push({ kind, args, signal });
    if (kind in answers) return Promise.resolve(answers[kind]);
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve(cancelled), { once: true }));
  };
  const host = {
    emit: () => {},
    askPermission: async () => "deny",
    askQuestions: async () => null,
    ...(withUi
      ? {
          select: ask("select", undefined),
          confirm: ask("confirm", false),
          input: ask("input", undefined),
          editor: ask("editor", undefined),
          notify: (message: string, level: NoticeLevel) => notices.push({ message, level }),
        }
      : {}),
  } as TurnHost;
  const ui = createPiUiContext({ host, signal: turn.signal, theme });
  return { ui, calls, notices, turn };
}

describe("the dialogs go to the host", () => {
  test("select passes the title and options and returns the pick", async () => {
    const { ui, calls } = setup({ select: "Green" });

    expect(await ui.select("Pick a color", ["Red", "Green"])).toBe("Green");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["Pick a color", ["Red", "Green"]]);
  });

  test("confirm passes the title and message and returns the answer", async () => {
    const { ui, calls } = setup({ confirm: true });

    expect(await ui.confirm("Delete?", "This removes the file")).toBe(true);
    expect(calls[0]!.args).toEqual(["Delete?", "This removes the file"]);
  });

  test("input passes the title and placeholder and returns the text", async () => {
    const { ui, calls } = setup({ input: "my-feature" });

    expect(await ui.input("Name", "kebab-case")).toBe("my-feature");
    expect(calls[0]!.args).toEqual(["Name", "kebab-case"]);
  });

  test("editor passes the title and prefill and returns the edited text", async () => {
    const { ui, calls } = setup({ editor: "line 1\nline 2" });

    expect(await ui.editor("Edit", "line 1")).toBe("line 1\nline 2");
    expect(calls[0]!.args).toEqual(["Edit", "line 1"]);
  });

  test("a cancelled ask gives pi its cancelled value", async () => {
    const { ui } = setup({ select: undefined, confirm: false, input: undefined, editor: undefined });

    expect(await ui.select("t", ["a"])).toBeUndefined();
    expect(await ui.confirm("t", "m")).toBe(false);
    expect(await ui.input("t")).toBeUndefined();
    expect(await ui.editor("t")).toBeUndefined();
  });

  test("a host without dialogs cancels every ask", async () => {
    const { ui } = setup({}, false);

    expect(await ui.select("t", ["a"])).toBeUndefined();
    expect(await ui.confirm("t", "m")).toBe(false);
    expect(await ui.input("t")).toBeUndefined();
    expect(await ui.editor("t")).toBeUndefined();
    expect(() => ui.notify("hello")).not.toThrow();
  });
});

describe("cancellation", () => {
  test("the end of the turn aborts the signal each ask carries, and the ask resolves as cancelled", async () => {
    const { ui, calls, turn } = setup();

    const select = ui.select("t", ["a"]);
    const confirm = ui.confirm("t", "m");
    const input = ui.input("t");
    const editor = ui.editor("t");
    expect(calls.map((c) => c.signal!.aborted)).toEqual([false, false, false, false]);

    turn.abort();

    expect([await select, await confirm, await input, await editor]).toEqual([undefined, false, undefined, undefined]);
    expect(calls.map((c) => c.signal!.aborted)).toEqual([true, true, true, true]);
  });

  test("an ask after the turn ended is cancelled without reaching the host", async () => {
    const { ui, calls, turn } = setup({ select: "Red", confirm: true });
    turn.abort();

    expect(await ui.select("t", ["Red"])).toBeUndefined();
    expect(await ui.confirm("t", "m")).toBe(false);
    expect(await ui.input("t")).toBeUndefined();
    expect(await ui.editor("t")).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("the signal an extension passes in the options also cancels the ask", async () => {
    const { ui, calls } = setup();
    const extension = new AbortController();

    const select = ui.select("t", ["a"], { signal: extension.signal });
    expect(calls[0]!.signal!.aborted).toBe(false);
    extension.abort();

    expect(await select).toBeUndefined();
    expect(calls[0]!.signal!.aborted).toBe(true);
  });

  test("an extension signal that is already aborted cancels without reaching the host", async () => {
    const { ui, calls } = setup({ confirm: true });
    const extension = new AbortController();
    extension.abort();

    expect(await ui.confirm("t", "m", { signal: extension.signal })).toBe(false);
    expect(calls).toEqual([]);
  });

  test("the timeout an extension passes cancels the ask when it runs out", async () => {
    const { ui, calls } = setup();

    const input = ui.input("t", undefined, { timeout: 20 });

    expect(await input).toBeUndefined();
    expect(calls[0]!.signal!.aborted).toBe(true);
  });

  test("an answered ask leaves its timeout and extension signal without effect", async () => {
    const { ui, calls } = setup({ select: "a" });
    const extension = new AbortController();

    expect(await ui.select("t", ["a"], { signal: extension.signal, timeout: 20 })).toBe("a");
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(calls[0]!.signal!.aborted).toBe(false);
  });
});

describe("notify", () => {
  test("goes to the host with its level, info by default", () => {
    const { ui, notices } = setup();

    ui.notify("Saved");
    ui.notify("Careful", "warning");
    ui.notify("Broken", "error");

    expect(notices).toEqual([
      { message: "Saved", level: "info" },
      { message: "Careful", level: "warning" },
      { message: "Broken", level: "error" },
    ]);
  });
});

describe("custom components", () => {
  test("say once that pi's own terminal UI is not supported, and resolve as cancelled", async () => {
    const { ui, notices } = setup();
    let built = false;
    const factory = () => {
      built = true;
      return {} as never;
    };

    expect(await ui.custom(factory)).toBeUndefined();
    expect(await ui.custom(factory)).toBeUndefined();

    expect(built).toBe(false);
    expect(CUSTOM_UI_NOTICE).toBe("This extension needs pi's own terminal UI, which marcsh does not support");
    expect(notices).toEqual([{ message: CUSTOM_UI_NOTICE, level: "warning" }]);
  });
});

describe("the rest of the interface", () => {
  test("terminal-only setters and listeners are safe to call", () => {
    const { ui } = setup();

    expect(() => {
      ui.setStatus("key", "text");
      ui.setStatus("key", undefined);
      ui.setWorkingMessage("working");
      ui.setWorkingMessage();
      ui.setWorkingVisible(false);
      ui.setWorkingIndicator({ frames: [] });
      ui.setHiddenThinkingLabel("hidden");
      ui.setWidget("w", ["line"]);
      ui.setWidget("w", undefined);
      ui.setFooter(undefined);
      ui.setHeader(undefined);
      ui.setTitle("title");
      ui.addAutocompleteProvider((current) => current);
      ui.setEditorComponent(undefined);
    }).not.toThrow();
    expect(ui.onTerminalInput(() => undefined)()).toBeUndefined();
    expect(ui.getEditorComponent()).toBeUndefined();
  });

  test("the editor text is kept so an extension reads back what it set", () => {
    const { ui } = setup();

    expect(ui.getEditorText()).toBe("");
    ui.setEditorText("draft");
    expect(ui.getEditorText()).toBe("draft");
    ui.pasteToEditor("pasted");
    expect(ui.getEditorText()).toBe("pasted");
  });

  test("the tool output expansion flag is kept", () => {
    const { ui } = setup();

    expect(ui.getToolsExpanded()).toBe(false);
    ui.setToolsExpanded(true);
    expect(ui.getToolsExpanded()).toBe(true);
  });

  test("the theme is the one given; no other theme can be loaded or set", () => {
    const { ui } = setup();

    expect(ui.theme).toBe(theme);
    expect(ui.getAllThemes()).toEqual([]);
    expect(ui.getTheme("dark")).toBeUndefined();
    expect(ui.setTheme("dark")).toEqual({ success: false, error: "marcsh does not switch pi themes" });
  });
});
