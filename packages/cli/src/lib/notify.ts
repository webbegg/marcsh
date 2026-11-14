import { spawn as spawnChild } from "node:child_process";
import { getNotifyMode, type NotifyMode } from "./preferences";

export type NotifyDeps = {
  platform?: string;
  /** Where the bell goes: the terminal. */
  write?: (text: string) => void;
  /** Starts `command` (program first) and does not wait for it; throws when it cannot start. */
  spawn?: (command: string[]) => void;
};

const BELL = "\x07";
const MAX_TEXT = 200;

/** `text` as the inside of an AppleScript string literal: line breaks and other control characters become spaces, `\` and `"` are escaped. */
export function appleScriptString(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .slice(0, MAX_TEXT)
    .replace(/[\\"]/g, (char) => `\\${char}`);
}

let defaultDeps: NotifyDeps = {};

/** Replaces the terminal and process the notifier uses unless a call gives its own (`undefined` restores them); for tests, which must never ring a bell or start osascript. */
export function setNotifyDeps(deps: NotifyDeps | undefined) {
  defaultDeps = deps ?? {};
}

function startDetached(command: string[]) {
  const [program, ...args] = command;
  const child = spawnChild(program!, args, { stdio: "ignore", detached: true });
  // A program that is missing reports it here, later; there is nothing to do about it.
  child.on("error", () => {});
  child.unref();
}

/**
 * Tells the user a turn finished (`text` says which one): the terminal bell, a macOS notification through `osascript` (the bell
 * elsewhere, or when it cannot start), or nothing. The mode is the `notify` preference unless one is given.
 */
export function notifyTurnDone(text: string, mode: NotifyMode = getNotifyMode(), deps: NotifyDeps = defaultDeps) {
  const { platform = process.platform, write = (bell) => void process.stdout.write(bell), spawn = startDetached } = deps;
  if (mode === "off") return;
  if (mode === "system" && platform === "darwin") {
    try {
      spawn(["osascript", "-e", `display notification "${appleScriptString(text)}" with title "marcsh"`]);
      return;
    } catch {
      // osascript could not start: the bell still tells the user.
    }
  }
  write(BELL);
}
