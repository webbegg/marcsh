// Runs before every test file (bunfig.toml, in the repo root and in packages/cli): no test may read or write the user's
// real ~/.marcsh, which holds their pi login (agent dir), sessions (DB), settings (preferences) and own agents and packs. Each test process gets
// its own temp dir. The paths are set whatever the shell exports, so a test run never depends on the shell it started from;
// a test that needs a specific path sets it itself, after this runs.
// Why unconditional: an exported MARCSH_DB_PATH (e.g. the real one) would otherwise be kept and written to.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "marcsh-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

process.env.MARCSH_AGENT_DIR = join(root, "agent");
process.env.MARCSH_DB_PATH = join(root, "marcsh.db");
process.env.MARCSH_PREFERENCES_PATH = join(root, "preferences.json");
process.env.MARCSH_AGENTS_DIR = join(root, "agents");
process.env.MARCSH_PACKS_DIR = join(root, "packs");
process.env.MARCSH_SNAPSHOTS_DIR = join(root, "snapshots");
// Turns take no project snapshots (undo/redo) unless a test turns them on: each would snapshot the test's working folder.
process.env.MARCSH_SNAPSHOTS = "off";
// Packs come from https://github.com unless a test sets a file:// base itself.
delete process.env.MARCSH_PACK_URL_BASE;

// The turn-done bell (notify preference, default `bell`) goes to process.stdout; any test that finishes a turn would ring the terminal
// running the suite and put a stray BEL byte in its log. The bell alone is dropped; everything else passes through. A test that checks
// the bell injects its own writer (setNotifyDeps), and one that captures stdout wraps this function and still sees every other chunk.
const writeStdout = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
  chunk === "\x07" ? true : (writeStdout as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
