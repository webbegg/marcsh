import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bun caches os.homedir() at startup, so the default agentDir is checked in a child process with its own HOME.
const child = `
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createPiEngine } from "./pi.ts";
const faux = fauxProvider({ models: [{ id: "faux-1" }] });
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
modelRuntime.registerNativeProvider(faux.provider);
faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
const events = [];
const turn = createPiEngine({ modelRuntime }).startTurn(
  { prompt: "hello", cwd: process.env.PROBE_CWD, mode: "build", model: "faux/faux-1", signal: new AbortController().signal },
  { emit: (e) => events.push(e), askPermission: async () => "deny", askQuestions: async () => null },
);
await turn.done;
console.log(JSON.stringify({
  errors: events.filter((e) => e.type === "error").map((e) => e.message),
  refs: events.filter((e) => e.type === "session").map((e) => e.ref),
}));
`;

// pi's find tool runs the `fd` it finds in its tools directory (`getAgentDir()/bin`, where pi downloads it).
// The child creates the engine before pi's modules load, as the app does, and then lets a faux model call find.
const findChild = `
import { createPiEngine } from "./pi.ts";
createPiEngine();
const { getAgentDir, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const faux = fauxProvider({ models: [{ id: "faux-1" }] });
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
modelRuntime.registerNativeProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("find", { pattern: "*.ts" }, { id: "f1" })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxText("done")]),
]);
const events = [];
const turn = createPiEngine({ modelRuntime }).startTurn(
  { prompt: "find", cwd: process.env.PROBE_CWD, mode: "build", model: "faux/faux-1", signal: new AbortController().signal },
  { emit: (e) => events.push(e), askPermission: async () => "deny", askQuestions: async () => null },
);
await turn.done;
console.log(JSON.stringify({ agentDir: getAgentDir(), errors: events.filter((e) => e.type === "error").map((e) => e.message) }));
`;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "marcsh-pi-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function seedExtension(agentDir: string, marker: string) {
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(
    join(agentDir, "extensions", `${marker}.ts`),
    `import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(join(home, marker))}, "1"); }\n`,
  );
}

// S5: without an explicit agentDir, pi lives in ~/.marcsh/agent and never loads ~/.pi/agent.
test("the default pi engine keeps sessions and extensions in ~/.marcsh/agent and ignores ~/.pi/agent", async () => {
  seedExtension(join(home, ".pi", "agent"), "pi-extension-loaded");
  seedExtension(join(home, ".marcsh", "agent"), "marcsh-extension-loaded");
  const cwd = join(home, "project");
  mkdirSync(cwd);

  const proc = Bun.spawn([process.execPath, "-e", child], {
    cwd: import.meta.dir,
    env: { ...process.env, HOME: home, PROBE_CWD: cwd },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

  expect({ code, err }).toEqual({ code: 0, err: "" });
  const { errors, refs } = JSON.parse(out.trim().split("\n").at(-1)!);
  expect(errors).toEqual([]);
  expect(refs).toHaveLength(1);
  expect(refs[0].startsWith(join(home, ".marcsh", "agent", "sessions"))).toBe(true);
  expect(existsSync(join(home, "marcsh-extension-loaded"))).toBe(true);
  expect(existsSync(join(home, "pi-extension-loaded"))).toBe(false);
  expect(readdirSync(join(home, ".pi", "agent"))).toEqual(["extensions"]);
});

function seedFd(agentDir: string, marker: string) {
  mkdirSync(join(agentDir, "bin"), { recursive: true });
  const fd = join(agentDir, "bin", "fd");
  writeFileSync(fd, `#!/bin/sh\necho ran > ${JSON.stringify(join(home, marker))}\n`);
  chmodSync(fd, 0o755);
}

// S5: pi's other getAgentDir() readers, such as the tools directory it downloads fd and rg into, follow the
// marcsh agent dir, even when the shell points PI_CODING_AGENT_DIR at the user's own pi install.
test("pi's tools directory and getAgentDir() resolve under ~/.marcsh/agent, not ~/.pi/agent", async () => {
  seedFd(join(home, ".pi", "agent"), "pi-fd-ran");
  seedFd(join(home, ".marcsh", "agent"), "marcsh-fd-ran");
  // find is not one of pi's default tools.
  writeFileSync(join(home, ".marcsh", "agent", "settings.json"), JSON.stringify({ defaultTools: ["read", "find"] }));
  const cwd = join(home, "project");
  mkdirSync(cwd);

  const proc = Bun.spawn([process.execPath, "-e", findChild], {
    cwd: import.meta.dir,
    env: { ...process.env, HOME: home, PROBE_CWD: cwd, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

  expect({ code, err }).toEqual({ code: 0, err: "" });
  const { agentDir, errors } = JSON.parse(out.trim().split("\n").at(-1)!);
  expect(agentDir).toBe(join(home, ".marcsh", "agent"));
  expect(errors).toEqual([]);
  expect(existsSync(join(home, "marcsh-fd-ran"))).toBe(true);
  expect(existsSync(join(home, "pi-fd-ran"))).toBe(false);
});
