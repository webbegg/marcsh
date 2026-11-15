import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-session-ps-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxAssistantMessage, fauxProvider, fauxText, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const { createPiEngine } = await import("../lib/engine/pi");
const { terminalsFor } = await import("../lib/background/session-terminals");
const { clearSessionMarker, startSessionMarker } = await import("../lib/background/leftovers");
const { leftoverWatch } = await import("../lib/background/leftover-watch");
const { execFileSync } = await import("node:child_process");
const { chmodSync, copyFileSync } = await import("node:fs");
type TurnRequest = import("../lib/engine/types").TurnRequest;
type BackgroundHub = import("../lib/background/hub").BackgroundHub;

// S3: `/ps` lists the session's background terminals, shows one's output (t switches stdout/stderr), and x kills; the status line counts them.

let dir: string;
let agentDir: string;
let cwd: string;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const hubs: BackgroundHub[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-session-ps-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));

afterEach(async () => {
  engines.set("pi", undefined);
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  await Promise.all(hubs.splice(0).map((hub) => hub.dispose()));
  rmSync(dir, { recursive: true, force: true });
});

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
const frameWhere = async (check: (frame: string) => boolean, timeoutMs = 8000) => {
  const start = Date.now();
  let current = frame();
  while (!check(current) && Date.now() - start < timeoutMs) {
    await settle(25);
    current = frame();
  }
  return current;
};
const frameContaining = (text: string) => frameWhere((current) => current.includes(text));
const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(80);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(80);
};

/** A pi session on pi's faux provider whose first turn has ended; returns its background terminals. */
async function openPiSession() {
  const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 3000, tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = modelRuntime.getModel("faux", "faux-1")!;
  modelRuntime.getAvailable = async () => [model];
  faux.setResponses([fauxAssistantMessage([fauxText("first answer")])]);
  const real = createPiEngine({ agentDir, modelRuntime });
  const requests: TurnRequest[] = [];
  engines.set("pi", { ...real, startTurn: (request, host) => (requests.push(request), real.startTurn(request, host)) });
  const session = getStorage().createSession({ title: "pi chat", cwd, engine: "pi" });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [{ pathname: `/sessions/${session.id}`, state: { initialPrompt: { message: "hi", mode: "BUILD", model: "opus" } } }] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 120, height: 40 });
  await settle();
  await frameContaining("first answer");
  const start = Date.now();
  while (getStorage().getSession(session.id)!.messages.length < 2 && Date.now() - start < 8000) await settle(25);
  await settle(100);
  const hub = requests[0]!.background!;
  hubs.push(hub);
  return terminalsFor(hub);
}

describe("/ps (S3)", () => {
  test("lists the terminals, opens one's output, switches to stderr, and kills it", async () => {
    const terminals = await openPiSession();
    const snapshot = await act(async () => terminals.start({ command: "echo OUT-LINE; echo ERR-LINE >&2; sleep 30", title: "dev server", cwd }));
    expect(await frameContaining("1 background terminal running · /ps")).toContain("1 background terminal running · /ps");

    await type("/ps");
    await press("RETURN");
    const list = await frameContaining("Background terminals");
    // Status, title, the command (cut to the dialog's width) and the runtime.
    expect(list).toMatch(/running dev server echo OUT-LINE; echo ERR-LINE .* \ds 1 running of 1/);

    await press("RETURN");
    // The output can reach the view after its header (a slow machine): wait for the line itself, not only the command line.
    const stdout = await frameWhere((current) => current.split("OUT-LINE").length === 3 && current.includes("full log"));
    expect(stdout).toContain("$ echo OUT-LINE");
    expect(stdout.split("OUT-LINE").length).toBe(3); // the command line and the output line

    await type("t");
    const stderr = await frameWhere((current) => current.split("ERR-LINE").length === 3);
    expect(stderr).toContain("stderr · full log");
    expect(stderr.split("OUT-LINE").length).toBe(2); // only the command line now

    await type("x");
    await frameWhere(() => snapshot.status !== "running");
    expect(snapshot.status).toBe("killed");
    expect(await frameContaining("killed · SIGTERM")).toContain("killed · SIGTERM");
    expect(await frameWhere((current) => !current.includes("background terminal running"))).not.toContain("background terminal running");
  }, 30000);

  test("x kills the highlighted terminal from the list", async () => {
    const terminals = await openPiSession();
    const older = await act(async () => terminals.start({ command: "sleep 30", title: "older", cwd }));
    const newer = await act(async () => terminals.start({ command: "sleep 31", title: "newer", cwd }));
    await frameContaining("2 background terminals running");

    await type("/ps");
    await press("RETURN");
    await frameContaining("2 running of 2");
    // Newest first: the second row is the older one.
    await act(async () => screen!.mockInput.pressArrow("down"));
    await settle(80);
    await type("x");
    await frameWhere(() => older.status !== "running");
    expect(older.status).toBe("killed");
    expect(newer.status).toBe("running");
    expect(await frameContaining("1 running of 2")).toContain("killed older");
  }, 30000);

  // M6: what this run's tools left running is listed under the terminals; x stops the highlighted one; the status line counts them.
  test("lists this run's leftover processes, and x stops the highlighted one", async () => {
    const savedMarker = process.env.MARCSH_SESSION;
    const marker = startSessionMarker();
    // macOS hides the environment of its own binaries from ps: a copy of sleep is not one.
    const sleeper = join(dir, "sleeper");
    copyFileSync(Bun.which("sleep")!, sleeper);
    chmodSync(sleeper, 0o755);
    const pid = Number(execFileSync("/bin/sh", ["-c", `${sleeper} 45 >/dev/null 2>&1 & echo $!`], { encoding: "utf8" }).trim());
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      expect(process.env.MARCSH_SESSION).toBe(marker.id);
      const terminals = await openPiSession();
      await act(async () => terminals.start({ command: "sleep 30", title: "dev server", cwd }));
      await frameContaining("1 background terminal running");

      await type("/ps");
      await press("RETURN");
      const list = await frameContaining("Leftover processes");
      // Pid, age, memory, and the command (here a long temp path, cut to the dialog's width).
      expect(list).toMatch(new RegExp(`Leftover processes .* ${pid} \\d+s [\\d.]+ MB /`));
      // The terminal's own sleep is in /ps already: it is not a leftover.
      expect(list).not.toMatch(/Leftover processes .*sleep 30/);
      // The status line's count reads the same scan (its wording is in status-bar.background.test.tsx; this line is too narrow for it).
      expect(leftoverWatch.list().map((left) => left.pid)).toEqual([pid]);

      // Newest first, then the leftovers: the second row.
      await act(async () => screen!.mockInput.pressArrow("down"));
      await settle(80);
      await type("x");
      await frameWhere(() => !alive(), 8000);
      expect(alive()).toBe(false);
      expect(await frameWhere((current) => !current.includes("Leftover processes"))).not.toContain(String(pid));
      expect(terminals.running()).toBe(1);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
      clearSessionMarker();
      await leftoverWatch.refresh({ force: true });
      if (savedMarker === undefined) delete process.env.MARCSH_SESSION;
      else process.env.MARCSH_SESSION = savedMarker;
    }
  }, 30000);

  test("/ps on a session without background terminals lists the leftovers alone", async () => {
    const { PsDialogContent } = await import("../components/dialogs/ps-dialog");
    const { createLeftoverWatch } = await import("../lib/background/leftover-watch");
    const watch = createLeftoverWatch({
      scan: async () => [{ pid: 4242, pgid: 4242, startedAt: Date.now() - 120_000, ageMs: 120_000, rssMb: 85, command: "node \u001b[31mserver.js", groupOnly: true }],
    });
    const { RootLayout: Layout } = await import("../layouts/root-layout");
    const router = createMemoryRouter([{ path: "/", element: <Layout />, children: [{ index: true, element: <PsDialogContent leftovers={watch} /> }] }]);
    screen = await testRender(<RouterProvider router={router} />, { width: 120, height: 20 });
    const shown = await frameContaining("node");
    expect(shown).toContain("Background terminals run in pi sessions only.");
    expect(shown).toMatch(/Leftover processes .*4242 2m 85 MB node \\u001b\[31mserver\.js|Leftover processes .*4242 2m 85 MB node .*server\.js/);
    // The escape is shown, never sent to the terminal.
    expect(shown).not.toContain("\u001b");
  }, 30000);

  // R3-4: the highlight follows the terminal, not the row: one started meanwhile goes on top without taking it.
  test("a terminal started while the list is open does not move the highlight, and x kills the highlighted one", async () => {
    const terminals = await openPiSession();
    const first = await act(async () => terminals.start({ command: "sleep 30", title: "first", cwd }));
    await frameContaining("1 background terminal running");

    await type("/ps");
    await press("RETURN");
    await frameContaining("1 running of 1");
    const second = await act(async () => terminals.start({ command: "sleep 31", title: "second", cwd }));
    await frameContaining("2 running of 2");
    await type("x");
    await frameWhere(() => first.status !== "running");
    expect(first.status).toBe("killed");
    expect(second.status).toBe("running");
  }, 30000);
});
