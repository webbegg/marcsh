// S5/S12: with the default agent dir, the dialog's sequence (device id, then logins, then a logout) keeps every
// credential in ~/.marcsh/agent/auth.json (0600), removes only the chosen provider, and never touches ~/.pi,
// a decoy PI_CODING_AGENT_DIR, or the project's .pi. Child process: Bun caches os.homedir().
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const child = `
import { createPiEngine } from "./pi.ts";
import { listLoginProviders, listStoredLogins, removeLogin, runLogin } from "./pi-auth.ts";
const engine = createPiEngine();
const deviceId = await engine.getDeviceId();
const runtime = await engine.getRuntime();
const ui = (key) => ({ notify() {}, prompt: async () => key });
const find = (id) => listLoginProviders(runtime).find((p) => p.id === id && p.authType === "api_key");
const results = [];
for (const id of ["anthropic", "openrouter", "groq"]) results.push((await runLogin(runtime, find(id), ui("key-" + id + "-0123456789"), { deviceId })).status);
const logout = await removeLogin(runtime, (await listStoredLogins(runtime)).find((l) => l.id === "openrouter"));
console.log(JSON.stringify({ results, logout: logout.status }));
`;

test("logins and a logout stay in ~/.marcsh/agent/auth.json (0600); ~/.pi, the decoy dir and the project .pi are untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "verify-agent-dir-"));
  try {
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(home);
    mkdirSync(project);
    const proc = Bun.spawn([process.execPath, "-e", child], {
      cwd: import.meta.dir,
      env: { ...process.env, HOME: home, TMPDIR: root, PI_CODING_AGENT_DIR: join(root, "decoy"), ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "", GROQ_API_KEY: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(out.trim().split("\n").at(-1)!)).toEqual({ results: ["success", "success", "success"], logout: "success" });

    const authPath = join(home, ".marcsh", "agent", "auth.json");
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    expect(Object.keys(auth).sort()).toEqual(["anthropic", "groq"]);
    expect(auth.anthropic).toEqual({ type: "api_key", key: "key-anthropic-0123456789" });
    expect(auth.groq).toEqual({ type: "api_key", key: "key-groq-0123456789" });
    expect([join(home, ".pi"), join(root, "decoy"), join(project, ".pi")].map(existsSync)).toEqual([false, false, false]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
