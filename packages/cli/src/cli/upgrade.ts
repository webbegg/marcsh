import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpgradeArgs } from "../cli-args";
import { EXIT, processIo, type Io } from "./io";

/** The installer the README tells people to run. `MARCSH_INSTALLER_URL` replaces it (tests, mirrors). */
export const DEFAULT_INSTALLER_URL = "https://raw.githubusercontent.com/webbegg/marcsh/main/install.sh";

/** The installer is a few dozen KB; a response far beyond that is not it. */
const MAX_INSTALLER_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export type UpgradeDeps = {
  io?: Io;
  /** The environment: where `MARCSH_INSTALLER_URL` is read from and what the installer inherits. */
  env?: Record<string, string | undefined>;
  fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
};

/** https, or plain http only for this machine: the rule install.sh applies to its own download base. */
function allowedUrl(text: string): URL | undefined {
  if (!URL.canParse(text)) return undefined;
  const url = new URL(text);
  if (url.protocol === "https:") return url;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") ? url : undefined;
}

/** The address as it is safe to print: a user name and password in it are hidden. */
function shown(url: URL): string {
  return url.username || url.password ? `${url.protocol}//***@${url.host}${url.pathname}${url.search}` : url.href;
}

class DownloadError extends Error {}

/** The body of the response, refusing to read more than `MAX_INSTALLER_BYTES`. */
async function readLimited(response: Response): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  for (let part = await reader?.read(); part && !part.done; part = await reader!.read()) {
    size += part.value.byteLength;
    if (size > MAX_INSTALLER_BYTES) {
      await reader!.cancel();
      throw new DownloadError(`the installer is too large (over ${MAX_INSTALLER_BYTES / 1024 / 1024} MiB)`);
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `marcsh upgrade`: downloads the installer to a temp file, then runs `bash <file>` with this terminal. Nothing from the network
 * is piped into a shell: the file is complete and checked to be a script before bash starts, and it is removed afterwards.
 * Resolves with the installer's exit code (1 when it could not be run).
 */
export async function upgradeCommand(args: UpgradeArgs, deps: UpgradeDeps = {}): Promise<number> {
  const { io = processIo, env = process.env, fetch: get = fetch } = deps;
  const fail = (message: string) => {
    io.stderr(`marcsh: ${message}\n`);
    return EXIT.failed;
  };

  const address = env.MARCSH_INSTALLER_URL?.trim() || DEFAULT_INSTALLER_URL;
  const url = allowedUrl(address);
  if (!url) return fail("MARCSH_INSTALLER_URL must be an https:// address (plain http is allowed only for 127.0.0.1 and localhost)");

  io.stdout(`Downloading the installer from ${shown(url)}\n`);
  let script: string;
  try {
    const response = await get(url.href, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new DownloadError(`HTTP ${response.status}`);
    // A redirect must not lead anywhere the address itself could not.
    if (response.url && !allowedUrl(response.url)) throw new DownloadError(`redirected to ${shown(new URL(response.url))}`);
    script = await readLimited(response);
  } catch (err) {
    return fail(`cannot download the installer from ${shown(url)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!script.startsWith("#!")) return fail(`what ${shown(url)} returned does not look like a shell script, so it was not run`);

  const folder = mkdtempSync(join(tmpdir(), "marcsh-upgrade-"));
  try {
    const file = join(folder, "install.sh");
    writeFileSync(file, script, { mode: 0o600 });
    io.stdout("Running the installer\n");

    const childEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    if (args.version !== undefined) childEnv.MARCSH_VERSION = args.version;
    const child = Bun.spawn(["bash", file], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: childEnv });

    // Ctrl+C reaches the installer from the terminal itself; this process waits for it so the file is removed. A signal sent to
    // this process alone is passed on.
    const stop = () => void child.kill();
    const ignore = () => {};
    process.on("SIGINT", ignore);
    process.on("SIGTERM", stop);
    process.on("SIGHUP", stop);
    try {
      return (await child.exited) ?? EXIT.failed;
    } finally {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", stop);
      process.off("SIGHUP", stop);
    }
  } catch (err) {
    return fail(`cannot run the installer: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
