export type CopyMethod = "pbcopy" | "osc52";

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
 * Copies `text` to the clipboard: `pbcopy` on macOS, otherwise (or when `pbcopy` fails) an OSC 52 sequence written to the terminal,
 * which works over SSH where the terminal supports it. Says which way it went; OSC 52 cannot tell whether the terminal honoured it.
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
