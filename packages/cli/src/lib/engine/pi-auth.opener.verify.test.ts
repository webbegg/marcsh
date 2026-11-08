// S12: the platform browser opener gets the URL as one argument (no shell), runs from "/", only for http(s),
// and a missing launcher is ignored. A fake launcher on PATH records its argv.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const child = `
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { runLogin } from "./pi-auth.ts";
const faux = fauxProvider({ provider: "v-url", models: [{ id: "m" }] });
const urls = JSON.parse(process.env.URLS);
const provider = { ...faux.provider, id: "v-url", name: "U", auth: { oauth: { name: "U",
  login: async (i) => { for (const url of urls) i.notify({ type: "auth_url", url }); return { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 1e6 }; },
  refresh: async (c) => c, toAuth: async (c) => ({ apiKey: c.access }) } } };
const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
runtime.registerNativeProvider(provider);
const outcome = await runLogin(runtime, { id: "v-url", authType: "oauth" }, { notify() {}, prompt: async () => "" });
await new Promise((r) => setTimeout(r, 400));
console.log(JSON.stringify(outcome));
`;

const launcher = process.platform === "darwin" ? "open" : "xdg-open";

test.skipIf(process.platform === "win32")("URLs reach the launcher as single arguments, never through a shell", async () => {
  const root = mkdtempSync(join(tmpdir(), "verify-opener-"));
  try {
    const bin = join(root, "bin");
    const log = join(root, "argv.txt");
    mkdirSync(bin);
    writeFileSync(join(bin, launcher), `#!/bin/sh\nfor a in "$@"; do printf 'ARG:%s\\n' "$a" >> ${JSON.stringify(log)}; done\nprintf 'CWD:%s\\n' "$(pwd)" >> ${JSON.stringify(log)}\n`);
    chmodSync(join(bin, launcher), 0o755);
    const pwn = join(root, "pwn");
    const urls = [`https://x.test/a;touch ${pwn}1`, `https://x.test/$(touch ${pwn}2)`, "https://x.test/`touch " + pwn + "3`", "file:///etc/passwd", "--help", "javascript:alert(1)"];
    const proc = Bun.spawn([process.execPath, "-e", child], {
      cwd: import.meta.dir,
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, URLS: JSON.stringify(urls) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(out).toContain('{"status":"success"}');
    const lines = readFileSync(log, "utf8").trim().split("\n");
    const args = lines.filter((l) => l.startsWith("ARG:")).map((l) => l.slice(4));
    expect(args).toHaveLength(3);
    for (const arg of args) expect(arg.startsWith("https://x.test/")).toBe(true);
    expect(lines.filter((l) => l.startsWith("CWD:"))).toEqual(["CWD:/", "CWD:/", "CWD:/"]);
    expect([1, 2, 3].map((n) => existsSync(`${pwn}${n}`))).toEqual([false, false, false]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test.skipIf(process.platform === "win32")("a missing launcher is ignored and the login still succeeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "verify-opener-none-"));
  try {
    const proc = Bun.spawn([process.execPath, "-e", child], {
      cwd: import.meta.dir,
      env: { ...process.env, PATH: join(root, "empty"), URLS: JSON.stringify(["https://x.test/ok"]) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(out).toContain('{"status":"success"}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
