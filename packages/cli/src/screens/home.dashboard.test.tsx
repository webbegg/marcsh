import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh: preferences, commands and packs all live in tmp.
const root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-home-dashboard-")));
const prefsPath = join(root, "preferences.json");
process.env.MARCSH_PREFERENCES_PATH = prefsPath;
process.env.MARCSH_COMMANDS_DIR = join(root, "commands");
process.env.MARCSH_PACKS_DIR = join(root, "packs");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("./home");
const { NewSession } = await import("./new-session");
const { engines } = await import("../lib/engine");
const { getStorage } = await import("../lib/storage");

// The models that have credentials right now: none, or one.
let available: { provider: string; id: string; name: string }[] = [];
let turns: string[] = [];

const fakePi = {
  id: "pi",
  startTurn: (input: { prompt?: string; message?: string }) => {
    turns.push(String(input.prompt ?? input.message ?? ""));
    return { done: Promise.resolve(), interrupt() {} };
  },
  warmUpCommands: async () => {},
  getRuntime: async () => ({ getAvailable: async () => available }),
  getDeviceId: async () => "device-1",
};

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = async (ms = 30) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(80);
};
const down = async () => {
  await act(async () => screen!.mockInput.pressArrow("down"));
  await settle(80);
};
const ctrl = async (name: string) => {
  await act(async () => screen!.mockInput.pressKey(name as never, { ctrl: true }));
  await settle(80);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(80);
};
const frame = () => screen!.captureCharFrame().replace(/[│\s]+/g, " ");

async function openHome() {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <RootLayout />,
        children: [
          { index: true, element: <Home dashboard /> },
          { path: "sessions/new", element: <NewSession /> },
          { path: "sessions/:id", element: <text>session opened</text> },
        ],
      },
    ],
    { initialEntries: ["/"] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 40 });
  await settle(150);
  return router;
}

const command = (file: string, text: string) => {
  mkdirSync(process.env.MARCSH_COMMANDS_DIR!, { recursive: true });
  writeFileSync(join(process.env.MARCSH_COMMANDS_DIR!, file), text);
};

beforeAll(() => engines.set("pi", fakePi as never));
afterAll(() => {
  engines.set("pi", undefined);
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  available = [{ provider: "fake-a", id: "a-1", name: "Alpha One" }];
  turns = [];
  writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "pi" }), "utf8");
});
afterEach(async () => {
  rmSync(process.env.MARCSH_COMMANDS_DIR!, { recursive: true, force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("home dashboard (S1, S2)", () => {
  test("the starting screen is the menu with the four daily options in order, not the input", async () => {
    await openHome();

    const text = frame();
    const feature = text.indexOf("New feature");
    const bug = text.indexOf("Fix a bug");
    const ticket = text.indexOf("Work on a ticket");
    const review = text.indexOf("Review a PR");
    expect(feature).toBeGreaterThan(-1);
    expect(bug).toBeGreaterThan(feature);
    expect(ticket).toBeGreaterThan(bug);
    expect(review).toBeGreaterThan(ticket);
    expect(text).toContain("esc");
    expect(text).not.toContain("Ask anything");
  });

  test("Down moves the highlight; Enter chooses the highlighted option", async () => {
    await openHome();
    await down();
    await press("RETURN");

    // No /bug-fix command is loaded: the menu closes and the input holds the option's starter text.
    const text = frame();
    expect(text).not.toContain("Work on a ticket");
    expect(text).toContain("Fix a bug:");
  });
});

describe("Esc (S4)", () => {
  test("closes the menu and shows the home screen with the input", async () => {
    const router = await openHome();
    await press("ESCAPE");

    const text = frame();
    expect(text).toContain("Ask anything");
    expect(text).not.toContain("Work on a ticket");
    expect(text).not.toContain("Review a PR");
    expect(router.state.location.pathname).toBe("/");
  });
});

describe("reopening the menu (S5)", () => {
  test("ctrl+x b opens the menu again", async () => {
    await openHome();
    await press("ESCAPE");
    expect(frame()).not.toContain("Work on a ticket");

    await ctrl("x");
    await press("b");

    const text = frame();
    expect(text).toContain("Work on a ticket");
    expect(text).not.toContain("Ask anything");
  });

  test("/dashboard opens the menu again", async () => {
    await openHome();
    await press("ESCAPE");
    await type("/dashboard");
    await press("RETURN");

    expect(frame()).toContain("Work on a ticket");
  });
});

describe("the daily actions in ctrl+p (S6)", () => {
  test("ctrl+p on the menu closes it and opens the palette, which lists the four actions and /dashboard", async () => {
    await openHome();
    await ctrl("p");
    expect(frame()).toContain("Command Palette");
    expect(frame()).not.toContain("esc prompt");

    for (const name of ["new-feature", "fix-bug", "work-ticket", "pr-review", "dashboard"]) {
      await type(name);
      expect(frame()).toContain(`/${name}`);
      for (let i = 0; i < name.length; i++) await act(async () => screen!.mockInput.pressBackspace());
      await settle(60);
    }
  });

  test("/fix-bug from the palette with no /bug-fix command puts the starter text in the input", async () => {
    await openHome();
    await press("ESCAPE");
    await ctrl("p");
    await type("fix-bug");
    await press("RETURN");

    const text = frame();
    expect(text).not.toContain("Command Palette");
    expect(text).toContain("Fix a bug:");
  });

  test("/new-feature from the palette runs /feature when it is loaded: its question form opens", async () => {
    command(
      "feature.md",
      "---\ndescription: Build it\nquestions:\n  - id: what\n    label: What should be built?\n    kind: long\n    required: true\n---\nBuild {{what}}",
    );
    await openHome();
    await press("ESCAPE");
    await ctrl("p");
    await type("new-feature");
    await press("RETURN");
    await settle(100);

    expect(frame()).toContain("What should be built?");
  });

  test("with text in the prompt, an action replaces nothing and says to clear it", async () => {
    await openHome();
    await press("ESCAPE");
    await type("my own words");
    await ctrl("p");
    await type("fix-bug");
    await press("RETURN");

    const text = frame();
    expect(text).toContain("my own words");
    expect(text).not.toContain("Fix a bug:");
    expect(text).toContain("Clear the prompt");
  });
});

describe("choosing an option (S3)", () => {
  test("with a matching command loaded, it runs that command: its question form opens", async () => {
    command(
      "feature.md",
      "---\ndescription: Build it\nquestions:\n  - id: what\n    label: What should be built?\n    kind: long\n    required: true\n---\nBuild {{what}}",
    );
    const router = await openHome();
    await press("RETURN");

    const text = frame();
    expect(text).toContain("What should be built?");
    expect(router.state.location.pathname).toBe("/");
  });

  test("with a matching command without questions, it starts a session with the expanded command", async () => {
    command("ticket.md", "---\ndescription: Ticket work\n---\nWork on the pasted ticket.");
    const router = await openHome();
    await down();
    await down();
    await press("RETURN");
    await settle(150);

    expect(router.state.location.pathname).toStartWith("/sessions/");
    expect(getStorage().listSessions().map((session) => session.title)).toContain("Work on the pasted ticket.");
  });

  test("with no matching command, the menu closes and the input holds the starter text", async () => {
    const router = await openHome();
    await down();
    await down();
    await down();
    await press("RETURN");

    const text = frame();
    expect(text).toContain("Review PR:");
    expect(text).not.toContain("Ask anything");
    expect(router.state.location.pathname).toBe("/");
  });

  test("with no model, it does not run the command: the input holds the invocation and the first-run card shows (A2)", async () => {
    available = [];
    command("feature.md", "---\ndescription: Build it\n---\nBuild it.");
    const router = await openHome();
    expect(frame()).toContain("/login sign in to a provider");

    await press("RETURN");

    const text = frame();
    expect(text).toContain("/feature");
    expect(text).not.toContain("Work on a ticket");
    expect(router.state.location.pathname).toBe("/");
    expect(turns.length).toBe(0);
  });
});
