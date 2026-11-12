import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-bot-message-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../../layouts/root-layout");
const { Session } = await import("../../screens/session");
const { getStorage } = await import("../../lib/storage");
const { ThemeProvider } = await import("../../providers/theme");
const { BotMessage } = await import("./bot-message");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});
const settle = (ms = 60) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");

describe("the label of a reply", () => {
  test("is the name of the agent that answered", async () => {
    screen = await testRender(
      <ThemeProvider>
        <BotMessage parts={[{ type: "text", text: "hi" }]} model="opus" mode="PLAN" agentName="Reviewer" />
      </ThemeProvider>,
      { width: 80, height: 10 },
    );
    await settle();
    expect(frame()).toContain("Reviewer › opus");
    expect(frame()).not.toContain("Plan › opus");
  });

  test("is the mode's name when no agent is known", async () => {
    screen = await testRender(
      <ThemeProvider>
        <BotMessage parts={[{ type: "text", text: "plan reply" }]} model="m-plan" mode="PLAN" />
        <BotMessage parts={[{ type: "text", text: "build reply" }]} model="m-build" mode="BUILD" />
      </ThemeProvider>,
      { width: 80, height: 14 },
    );
    await settle();
    expect(frame()).toContain("Plan › m-plan");
    expect(frame()).toContain("Build › m-build");
  });

  test("of a stored message comes from its `agent` metadata; older messages without it show Plan or Build", async () => {
    const session = getStorage().createSession({ title: "chat", cwd: "/tmp/marcsh-cwd", engine: "claude" });
    const reply = (id: string, metadata: Record<string, unknown>) => ({ id, role: "assistant" as const, parts: [{ type: "text" as const, text: `reply ${id}` }], metadata });
    getStorage().saveMessages(session.id, [
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      reply("a1", { mode: "PLAN", model: "m-one", agent: "Reviewer" }),
      reply("a2", { mode: "PLAN", model: "m-two" }),
      reply("a3", { mode: "BUILD", model: "m-three" }),
    ] as never);
    const router = createMemoryRouter(
      [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
      { initialEntries: [`/sessions/${session.id}`] },
    );
    screen = await testRender(<RouterProvider router={router} />, { width: 120, height: 50 });
    await settle(200);
    await screen.renderOnce();

    const text = frame();
    expect(text).toContain("Reviewer › m-one");
    expect(text).toContain("Plan › m-two");
    expect(text).toContain("Build › m-three");
    expect(text).not.toContain("Plan › m-one");
  });
});
