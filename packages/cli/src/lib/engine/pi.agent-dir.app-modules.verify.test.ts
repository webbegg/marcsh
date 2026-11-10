// S5: loading every app module first (as the running app does) must not import pi ahead of createPiEngine,
// so pi's tools dir (fd/rg) and getAgentDir() follow ~/.marcsh/agent even with PI_CODING_AGENT_DIR set.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const child = `
import { join } from "node:path";
const src = join(import.meta.dir, "..", "..");
const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync(src)].filter((f) => !/\\.test\\.|^index\\.tsx$/.test(f)).sort();
for (const f of files) await import(join(src, f));
const { engines } = await import("./index.ts");
const { createPiEngine } = await import("./pi.ts");
engines.get("pi");
const pi = await import("@earendil-works/pi-coding-agent");
const { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const faux = fauxProvider({ models: [{ id: "faux-1" }] });
const modelRuntime = await pi.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
modelRuntime.registerNativeProvider(faux.provider);
const cwd = process.env.PROBE_CWD;
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("find", { pattern: "*.ts", path: cwd }, { id: "f1" }), fauxToolCall("grep", { pattern: "x", path: cwd }, { id: "g1" })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxText("done")]),
]);
const errors = [];
await createPiEngine({ modelRuntime }).startTurn(
  { prompt: "go", cwd, mode: "build", model: "faux/faux-1", signal: new AbortController().signal },
  { emit: (e) => e.type === "error" && errors.push(e.message), askPermission: async () => "deny", askQuestions: async () => null },
).done;
console.log(JSON.stringify({ agentDir: pi.getAgentDir(), errors }));
`;

// The test preload's MARCSH_AGENT_DIR must not reach the child, which checks the default ~/.marcsh/agent.
const { MARCSH_AGENT_DIR: _agentDirOverride, ...parentEnv } = process.env;

test("with every app module loaded first, fd/rg and getAgentDir() resolve under ~/.marcsh/agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-dir-app-"));
  const home = join(root, "home");
  const decoy = join(root, "decoy");
  const marcshAgent = join(home, ".marcsh", "agent");
  for (const [base, tag] of [[decoy, "decoy"], [marcshAgent, "marcsh"], [join(home, ".pi", "agent"), "pi"]] as const) {
    mkdirSync(join(base, "bin"), { recursive: true });
    for (const tool of ["fd", "rg"]) {
      writeFileSync(join(base, "bin", tool), `#!/bin/sh\necho ran > ${JSON.stringify(join(root, `${tag}-${tool}`))}\n`);
      chmodSync(join(base, "bin", tool), 0o755);
    }
  }
  writeFileSync(join(marcshAgent, "settings.json"), JSON.stringify({ defaultTools: ["read", "find", "grep"] }));
  mkdirSync(join(home, "project"));
  writeFileSync(join(home, "project", "a.ts"), "x\n");

  const proc = Bun.spawn([process.execPath, "-e", child], {
    cwd: import.meta.dir,
    env: { ...parentEnv, HOME: home, TMPDIR: root, PROBE_CWD: join(home, "project"), PI_CODING_AGENT_DIR: decoy },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(JSON.parse(out.trim().split("\n").at(-1)!)).toEqual({ agentDir: marcshAgent, errors: [] });
  expect(["marcsh-fd", "marcsh-rg", "decoy-fd", "decoy-rg", "pi-fd", "pi-rg"].map((m) => existsSync(join(root, m)))).toEqual([true, true, false, false, false, false]);
}, 30000);
