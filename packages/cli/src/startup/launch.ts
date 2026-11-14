import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionSummary, Storage } from "../lib/storage";

/** A folder is known by its real path, so a symlink and its target are one folder. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The session of the folder `cwd` that was updated last (`--continue`), or undefined when it has none. */
export function latestSessionForCwd(sessions: readonly SessionSummary[], cwd: string): SessionSummary | undefined {
  const here = realPath(cwd);
  return sessions
    .filter((session) => realPath(session.cwd) === here)
    .reduce<SessionSummary | undefined>((latest, session) => (!latest || session.updatedAt > latest.updatedAt ? session : latest), undefined);
}

/** The folder to start in: `dir` as typed (relative to `cwd`), or `cwd` itself when none was given. */
export function resolveLaunchDir(dir: string | undefined, cwd: string): { ok: true; dir: string } | { ok: false; message: string } {
  if (dir === undefined) return { ok: true, dir: cwd };
  const path = resolve(cwd, dir);
  try {
    if (statSync(path).isDirectory()) return { ok: true, dir: path };
  } catch {}
  return { ok: false, message: `"${dir}" is not a directory` };
}

/** The memory router's starting point (`initialEntries` and `initialIndex`), or the reason the launch flags cannot be honoured. */
export type LaunchPlan = { ok: true; initialEntries: string[]; initialIndex: number } | { ok: false; message: string };

const HOME = "/";
const home: LaunchPlan = { ok: true, initialEntries: [HOME], initialIndex: 0 };

/**
 * Where the interface opens. A session opens over the home screen, so leaving it goes home as it does after the sessions dialog.
 * `--continue` with no session in `cwd` opens the home screen; `--session` with an id nobody has is an error.
 */
export function planLaunch(
  options: { continue: boolean; session?: string },
  storage: Pick<Storage, "listSessions" | "getSession">,
  cwd: string,
): LaunchPlan {
  const open = (id: string): LaunchPlan => ({ ok: true, initialEntries: [HOME, `/sessions/${encodeURIComponent(id)}`], initialIndex: 1 });

  if (options.session !== undefined) {
    return storage.getSession(options.session) ? open(options.session) : { ok: false, message: `no session with id "${options.session}"` };
  }
  if (options.continue) {
    const latest = latestSessionForCwd(storage.listSessions(), cwd);
    return latest ? open(latest.id) : home;
  }
  return home;
}
