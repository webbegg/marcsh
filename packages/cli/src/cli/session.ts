import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionArgs } from "../cli-args";
import { formatRelativeTime } from "../lib/relative-time";
import { printable } from "../lib/safe-text";
import { getStorage, type Storage } from "../lib/storage";
import { defaultExportPath, renderTranscript } from "../lib/transcript";
import { EXIT, processIo, type Io } from "./io";

export type SessionDeps = { storage?: Pick<Storage, "listSessions" | "getSession" | "deleteSession">; io?: Io; now?: () => Date };


const isFolder = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** `marcsh session list|delete|export`: resolves with the exit code. */
export async function sessionCommand(args: SessionArgs, deps: SessionDeps = {}): Promise<number> {
  const { io = processIo, now = () => new Date() } = deps;
  const fail = (message: string) => {
    io.stderr(`marcsh: ${message}\n`);
    return EXIT.failed;
  };

  let storage: NonNullable<SessionDeps["storage"]>;
  try {
    storage = deps.storage ?? getStorage();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  switch (args.action) {
    case "list": {
      const sessions = storage.listSessions();
      if (args.json) {
        io.stdout(
          `${JSON.stringify(
            sessions.map(({ id, title, cwd, createdAt, updatedAt, engine, model, messageCount }) => ({
              id,
              title,
              cwd,
              createdAt: createdAt.toISOString(),
              updatedAt: updatedAt.toISOString(),
              engine,
              model,
              messageCount,
            })),
            null,
            2,
          )}\n`,
        );
      } else if (sessions.length === 0) {
        io.stdout("No sessions.\n");
      } else {
        // Titles and folders come from the model and the file system: nothing in them may reach the terminal as a control sequence.
        // The id stays the first column, so scripts that take it with `awk '{print $1}'` keep working.
        const at = now();
        for (const { id, title, cwd, updatedAt, engine, model, messageCount } of sessions) {
          const route = `${printable(engine)}/${model === null ? "—" : printable(model)}`;
          io.stdout(`${id}  ${formatRelativeTime(updatedAt, at)}  ${route}  ${messageCount} msgs  ${printable(cwd)}  ${printable(title)}\n`);
        }
      }
      return EXIT.ok;
    }

    case "delete": {
      if (!storage.deleteSession(args.id)) return fail(`no session with id "${args.id}"`);
      io.stdout(`Deleted session ${args.id}\n`);
      return EXIT.ok;
    }

    case "export": {
      const session = storage.getSession(args.id);
      if (!session) return fail(`no session with id "${args.id}"`);
      const text = renderTranscript(session, args.format);
      if (args.output === undefined) {
        io.stdout(text);
        return EXIT.ok;
      }

      const target = args.output.endsWith("/") || isFolder(args.output) ? join(args.output, defaultExportPath(session, args.format, now())) : args.output;
      try {
        // `wx` fails when the file is there, so the check and the write are one step.
        writeFileSync(target, text, { flag: args.force ? "w" : "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return fail(`"${target}" already exists (use --force to replace it)`);
        return fail(`cannot write "${target}": ${err instanceof Error ? err.message : String(err)}`);
      }
      io.stdout(`Wrote ${target}\n`);
      return EXIT.ok;
    }
  }
}
