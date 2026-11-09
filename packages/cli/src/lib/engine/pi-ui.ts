import type { ExtensionUIContext, ExtensionUIDialogOptions, Theme } from "@earendil-works/pi-coding-agent";
import type { TurnHost } from "./types";

export const CUSTOM_UI_NOTICE = "This extension needs pi's own terminal UI, which marcsh does not support";

export type PiUiOptions = {
  host: TurnHost;
  /** Aborts when the turn ends: every open ask is then cancelled. */
  signal: AbortSignal;
  /** pi's theme object, which extensions read while styling text. */
  theme: Theme;
};

/**
 * Runs one ask with a signal that aborts when the turn ends, when the extension's own signal aborts, or when
 * its timeout runs out. An ask that is already cancelled never reaches the host (the host cannot see an
 * abort that happened before it listened).
 */
async function ask<T>(
  turnEnded: AbortSignal,
  opts: ExtensionUIDialogOptions | undefined,
  cancelled: T,
  run: ((signal: AbortSignal) => Promise<T>) | undefined,
): Promise<T> {
  if (!run || turnEnded.aborted || opts?.signal?.aborted) return cancelled;

  const controller = new AbortController();
  const cancel = () => controller.abort();
  turnEnded.addEventListener("abort", cancel, { once: true });
  opts?.signal?.addEventListener("abort", cancel, { once: true });
  const timer = opts?.timeout ? setTimeout(cancel, opts.timeout) : undefined;
  try {
    return await run(controller.signal);
  } catch {
    return cancelled;
  } finally {
    clearTimeout(timer);
    turnEnded.removeEventListener("abort", cancel);
    opts?.signal?.removeEventListener("abort", cancel);
  }
}

/**
 * pi's `ExtensionUIContext` for a marcsh turn. The dialogs (`select`, `confirm`, `input`, `editor`) and
 * `notify` go to the host, which shows them in marcsh's own prompts and toasts. Everything that needs pi's
 * terminal UI (components, widgets, footer, header, themes, raw input) is accepted and ignored, and
 * `custom()` tells the user once per turn that it is not supported.
 */
export function createPiUiContext({ host, signal, theme }: PiUiOptions): ExtensionUIContext {
  let editorText = "";
  let toolsExpanded = false;
  let customNoticeShown = false;

  return {
    select: (title, options, opts) =>
      ask(signal, opts, undefined, host.select && ((s) => host.select!(title, options, s))),
    confirm: (title, message, opts) =>
      ask(signal, opts, false, host.confirm && ((s) => host.confirm!(title, message, s))),
    input: (title, placeholder, opts) =>
      ask(signal, opts, undefined, host.input && ((s) => host.input!(title, placeholder, s))),
    editor: (title, prefill) =>
      ask(signal, undefined, undefined, host.editor && ((s) => host.editor!(title, prefill, s))),
    notify: (message, type = "info") => host.notify?.(message, type),

    async custom() {
      if (!customNoticeShown) {
        customNoticeShown = true;
        host.notify?.(CUSTOM_UI_NOTICE, "warning");
      }
      // pi's contract has no cancelled value for a component; its own RPC mode answers the same way.
      return undefined as never;
    },

    onTerminalInput: () => () => {},
    setStatus() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget() {},
    setFooter() {},
    setHeader() {},
    setTitle() {},
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent: () => undefined,

    // marcsh has its own input box; these only remember what an extension set.
    setEditorText(text) {
      editorText = text;
    },
    getEditorText: () => editorText,
    pasteToEditor(text) {
      editorText = text;
    },

    theme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "marcsh does not switch pi themes" }),

    getToolsExpanded: () => toolsExpanded,
    setToolsExpanded(expanded) {
      toolsExpanded = expanded;
    },
  };
}
