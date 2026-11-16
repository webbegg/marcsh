import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MAX_AGENT_BYTES } from "./agent-file";

/** A command name: the file name without `.md`. */
export const COMMAND_NAME = /^[a-z0-9][a-z0-9\-_:]*$/;

/** Where a project's own commands are: `<project>/.marcsh/commands`. */
export const PROJECT_COMMANDS_DIR = join(".marcsh", "commands");

/** A file that can be a command: its name (without `.md`), its file name and where it is. */
export type CommandFile = { name: string; file: string; path: string };

/**
 * The files in `dir` that marcsh reads as commands, sorted by file name: `<name>.md` with a valid name, a regular file of at most
 * `MAX_AGENT_BYTES`. With `followLinks` false (a project's or a pack's folder, third-party content) a symlink is not a file, so a link
 * cannot pull in a file from elsewhere. Whether the body is empty is the reader's check.
 *
 * Both the command loader and the project trust review list a project's commands with this, so what trust covers is what loads.
 * `onEntry` is told every candidate path before it is looked at (the trust review records them to notice a later change).
 */
export function commandFiles(dir: string, followLinks: boolean, onEntry?: (path: string) => void): CommandFile[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const found: CommandFile[] = [];
  for (const file of files) {
    const name = file.slice(0, -".md".length);
    if (!COMMAND_NAME.test(name)) continue;
    const path = join(dir, file);
    onEntry?.(path);
    try {
      const info = followLinks ? statSync(path) : lstatSync(path);
      if (info.isFile() && info.size <= MAX_AGENT_BYTES) found.push({ name, file, path });
    } catch {
      // An unreadable file is not a command.
    }
  }
  return found;
}
