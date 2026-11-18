import { writeSync } from "node:fs";

type ExitSource = { on: (event: "exit", handler: () => void) => unknown };

/**
 * A line to print once marcsh has left the screen. The renderer restores the terminal (it leaves the alternate screen, which
 * wipes what was printed there) in its own `exit` listener, and it shows what `console.*` prints in red inside the screen. So
 * the line is written straight to stderr from an `exit` listener added after the renderer's: call this after the renderer is
 * created. Returns the function that sets the line to print (or clears it).
 */
export function installExitNotice(
  proc: ExitSource = process,
  write: (text: string) => void = (text) => void writeSync(2, text),
): (line: string | undefined) => void {
  let line: string | undefined;
  proc.on("exit", () => {
    if (line === undefined) return;
    try {
      write(`${line}\n`);
    } catch {}
  });
  return (next) => {
    line = next;
  };
}
