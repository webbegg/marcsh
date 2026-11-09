// S12/S6 (T11 A1): provider errors and failing tool output that echo keys or bearer tokens are redacted in the UI frame and in SQLite (db, -wal, -shm).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
const dir = mkdtempSync(join(tmpdir(), "a1e2e-"));
process.env.MARCSH_DB_PATH = join(dir, "marcsh.db");
process.env.MARCSH_PREFERENCES_PATH = join(dir, "p.json");
const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("../screens/session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const pi = await import("@earendil-works/pi-coding-agent");
const { fauxAssistantMessage, fauxProvider, fauxToolCall, fauxText, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const { createPiEngine } = await import("../lib/engine/pi");
const KEY = "sk-ant-api03-E2ELEAK1234567890abcdefghijklmnop";
const BEARER = "eyJhbGciOiJIUzI1NiJ9xyz.E2EBEARERpayload123456.sigE2E";
const OTOKEN = "ghp_E2EOPAQUE0123456789abcdefghijklmnopq";
const settle = (ms = 60) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const faux = fauxProvider({ models: [{ id: "faux-1" }] });
const modelRuntime = await pi.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
modelRuntime.registerNativeProvider(faux.provider);
const piEngine = createPiEngine({ agentDir: join(dir, "agent"), modelRuntime, permissionRules: { addPermissionRule() {}, hasPermissionRule: () => true } });
const wrapped = { ...piEngine, id: "claude", startTurn: (req: any, host: any) => piEngine.startTurn({ ...req, model: "faux/faux-1" }, host) };
beforeAll(() => { engines.set("claude", wrapped as any); });
afterAll(() => { engines.set("claude", undefined); });
const needles = [KEY, KEY.slice(0, 20), "E2ELEAK", "E2EBEARER", "E2EOPAQUE", BEARER];
function scan(label: string) {
  const hits: string[] = [];
  for (const f of readdirSync(dir)) if (f.startsWith("marcsh.db")) {
    const b = readFileSync(join(dir, f)).toString("latin1");
    for (const n of needles) if (b.includes(n)) hits.push(`${f}:${n}`);
  }
  console.log(label, "db files", readdirSync(dir).filter((f) => f.startsWith("marcsh.db")), "hits", JSON.stringify(hits));
  return hits;
}
async function run(responses: any[], prompt: string) {
  faux.setResponses(responses);
  const cwd = mkdtempSync(join(dir, "cwd-"));
  writeFileSync(join(cwd, "secret.txt"), `curl: (22) 401 Unauthorized\nAuthorization: Bearer ${BEARER}\nx-api-key: ${KEY}\ntoken=${OTOKEN}\n`);
  const session = getStorage().createSession({ title: "chat", cwd, engine: "claude" });
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }], { initialEntries: [`/sessions/${session.id}`] });
  const screen = await testRender(<RouterProvider router={router} />, { width: 120, height: 40 });
  await settle(150);
  await act(() => screen.mockInput.typeText(prompt));
  await act(() => screen.mockInput.pressEnter());
  for (let i = 0; i < 40; i++) { await settle(100); if (!screen.captureCharFrame().includes("esc")) break; }
  await settle(400);
  const frame = screen.captureCharFrame();
  await act(async () => screen.renderer.destroy());
  const row = getStorage().getSession?.(session.id) as any;
  return { frame, msgs: JSON.stringify(row?.messages ?? row) };
}
test("provider error echoing key + bearer", async () => {
  const { frame, msgs } = await run([fauxAssistantMessage([], { stopReason: "error", errorMessage: `401 {"error":{"message":"invalid x-api-key ${KEY}"}} Authorization: Bearer ${BEARER} token ${OTOKEN}` })], "hello there");
  for (const n of needles) { expect(frame).not.toContain(n); expect(msgs).not.toContain(n); }
  expect(frame).toContain("401");
  expect(scan("provider")).toEqual([]);
});
test("failing bash tool printing secrets from a file", async () => {
  const { frame, msgs } = await run([fauxAssistantMessage([fauxToolCall("bash", { command: "cat secret.txt >&2; exit 22" }, { id: "c1" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("done")])], "show me");
  for (const n of needles) { expect(frame).not.toContain(n); expect(msgs).not.toContain(n); }
  expect(msgs).toContain("401 Unauthorized");
  expect(scan("tool")).toEqual([]);
});
