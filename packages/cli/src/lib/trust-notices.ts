import { canonical, type PartTrust } from "./engine/pi-trust";

/** A project with commands nobody decided about. */
export const PROJECT_COMMANDS_NOTICE = "This project has its own commands (.marcsh/commands): run /trust to use them.";
/** A project trusted before marcsh reviewed its commands and git settings (or before it kept reviews at all). */
export const TRUST_UPGRADE_NOTICE = "marcsh now also reviews project commands and git settings: run /trust to use them.";
export const COMMANDS_STALE_NOTICE = "This project's commands changed since you trusted them: run /trust to use them.";
export const GIT_STALE_NOTICE = "This project's git settings changed since you trusted them: run /trust to count its changed files.";

/** What was said already, per project: each notice once per project per run. */
const given = new Set<string>();

/**
 * What to tell the user when a part of the project's trust does not hold and the project has something in that part (the caller
 * checks that): one text per state, none for a part that holds or a project the user chose not to trust, and none for the git
 * count of an undecided project (marcsh never counts there). Null once the same text was given for the project in this run.
 */
export function trustNotice(cwd: string, part: "command" | "git", state: PartTrust): string | null {
  const text =
    state === "undecided"
      ? part === "command"
        ? PROJECT_COMMANDS_NOTICE
        : null
      : state === "unreviewed"
        ? TRUST_UPGRADE_NOTICE
        : state === "stale"
          ? part === "command"
            ? COMMANDS_STALE_NOTICE
            : GIT_STALE_NOTICE
          : null;
  if (text === null) return null;
  const key = `${canonical(cwd)}\0${text}`;
  if (given.has(key)) return null;
  given.add(key);
  return text;
}
