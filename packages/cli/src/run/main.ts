import type { RunArgs } from "../cli-args";
import { installQuitSignals } from "../lib/quit";
import { runHeadless } from "./run";

/** `marcsh run` as the process runs it: reads standard input when it is not a terminal, and turns Ctrl+C into an aborted, saved turn (exit 130). */
export async function runCommand(args: RunArgs): Promise<number> {
  const stdin = process.stdin.isTTY ? undefined : await Bun.stdin.text();
  // There is no screen to tear down: SIGINT, SIGTERM and SIGHUP stop the running turn, wait for it to be saved, and exit 128 + the signal.
  const removeSignals = installQuitSignals({ destroy() {} });
  try {
    const { kind: _kind, ...options } = args;
    return await runHeadless({ ...options, stdin });
  } finally {
    removeSignals();
  }
}
