import {
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  decodePasteBytes,
  type ClipboardService as CoreClipboardService,
  type RendererClipboardBoundary,
} from "@opentui/core";

// The reading and writing over OpenTUI's clipboard follow opencode's packages/tui/src/clipboard.ts (MIT); see THIRD_PARTY_NOTICES.md.

/** How a copy went: this machine's clipboard (OpenTUI's or `pbcopy`), or an OSC 52 sequence the terminal may or may not honour. */
export type CopyMethod = "host" | "pbcopy" | "osc52";

/** What a clipboard read gives: a PNG image (OpenTUI converts other image formats where it can) or text. */
export type ClipboardContent = { mime: "image/png"; bytes: Uint8Array } | { mime: "text/plain"; text: string };

/** The app's clipboard: one per process, given to the screens by `ClipboardProvider`. */
export type ClipboardService = {
  /** Nothing for an empty clipboard; rejects with a short reason when it cannot be read. */
  read(): Promise<ClipboardContent | undefined>;
  /** Rejects when the text could go nowhere. */
  write(text: string): Promise<{ method: CopyMethod }>;
};

export type OwnedClipboardService = ClipboardService & { dispose(): Promise<void> };

export type ClipboardDeps = {
  platform?: string;
  /** Runs `command`, feeds it `input` on stdin and resolves with its exit code; rejects when it cannot start. */
  spawn?: (command: string[], input: string) => Promise<number>;
  /** Where the OSC 52 sequence goes: the terminal. */
  write?: (sequence: string) => void;
};

/** The terminal escape that asks the terminal to put `text` on the system clipboard. */
export const osc52 = (text: string): string => `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;

async function spawnWithInput(command: string[], input: string): Promise<number> {
  const child = Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  child.stdin.write(input);
  await child.stdin.end();
  return child.exited;
}

/**
 * Copies `text` to the clipboard without OpenTUI: `pbcopy` on macOS, otherwise (or when `pbcopy` fails) an OSC 52 sequence written to
 * the terminal, which works over SSH where the terminal supports it. Says which way it went; OSC 52 cannot tell whether the terminal
 * honoured it. The app's clipboard falls back to this when none of its own routes took the text.
 */
export async function copyToClipboard(text: string, deps: ClipboardDeps = {}): Promise<{ method: CopyMethod }> {
  const { platform = process.platform, spawn = spawnWithInput, write = (sequence) => void process.stdout.write(sequence) } = deps;

  if (platform === "darwin") {
    try {
      if ((await spawn(["pbcopy"], text)) === 0) return { method: "pbcopy" };
    } catch {
      // pbcopy is missing or could not start: the terminal can still do it.
    }
  }

  write(osc52(text));
  return { method: "osc52" };
}

const NOT_AVAILABLE = "Clipboard not available here";

type ServiceOptions = {
  /** Whether the renderer has detected the terminal yet. Until it has, OpenTUI counts it as remote and would skip this machine's clipboard. */
  capabilitiesKnown?: () => boolean;
  /** Where a copy goes when no route took it. */
  fallback?: (text: string) => Promise<{ method: CopyMethod }>;
};

/** The app's clipboard over an OpenTUI clipboard service: reads prefer a PNG, then text; writes go to every route there is. */
export function clipboardService(core: CoreClipboardService, options: ServiceOptions = {}): OwnedClipboardService {
  const { capabilitiesKnown = () => true, fallback = (text: string) => copyToClipboard(text) } = options;
  return {
    async read() {
      const result = await core.read({ preferredTypes: ["image/png", "text/plain"], selection: "clipboard" });
      switch (result.status) {
        case "read": {
          const { mimeType, bytes } = result.representation;
          if (mimeType === "image/png") return { mime: "image/png", bytes };
          if (mimeType === "text/plain") return bytes.length === 0 ? undefined : { mime: "text/plain", text: decodePasteBytes(bytes) };
          throw new Error(`Unexpected clipboard type: ${mimeType}`);
        }
        case "empty":
        case "cancelled":
          return undefined;
        case "unsupported":
          throw new Error(NOT_AVAILABLE);
        case "timed-out":
          throw new Error("Clipboard read timed out");
        case "limit-exceeded":
          throw new Error("Clipboard content is too large");
        case "failed":
          throw result.error;
      }
    },
    async write(text) {
      // OpenTUI rejects NUL before any route; a clipboard's text cannot hold it.
      const clean = text.replaceAll("\0", "");
      const result = await core.writeText(clean, { destination: "all-available", selection: "clipboard", allowRemoteHost: !capabilitiesKnown() });
      if (result.host.status === "written") return { method: "host" };
      if (result.terminal.status === "attempted") return { method: "osc52" };
      return fallback(clean);
    },
    dispose: () => core.dispose(),
  };
}

/** The clipboard where OpenTUI's is not there (tests, a native library that failed to load): no reads, copies the old way. */
export const legacyClipboard: OwnedClipboardService = {
  read: async () => {
    throw new Error(NOT_AVAILABLE);
  },
  write: (text) => copyToClipboard(text),
  dispose: async () => {},
};

/**
 * The process's clipboard: this machine's (OpenTUI's native one: macOS, Wayland or X11) and the terminal's (OSC 52). OpenTUI allows one
 * native clipboard per process: create it once, with the renderer, and dispose of it on exit.
 */
export function createAppClipboard(renderer: RendererClipboardBoundary): OwnedClipboardService {
  try {
    const core = createClipboard({ host: createHostClipboard(), terminal: createRendererClipboardAdapter(renderer) });
    return clipboardService(core, { capabilitiesKnown: () => renderer.capabilities !== null });
  } catch {
    return legacyClipboard;
  }
}
