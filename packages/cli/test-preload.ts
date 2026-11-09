// Runs before every test file (bunfig.toml): no test may read or write the user's real ~/.marcsh, which holds
// their pi login (agent dir), sessions (DB) and settings (preferences). Each test process gets its own temp dir.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "marcsh-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

process.env.MARCSH_AGENT_DIR = join(root, "agent");
process.env.MARCSH_DB_PATH ||= join(root, "marcsh.db");
process.env.MARCSH_PREFERENCES_PATH ||= join(root, "preferences.json");
