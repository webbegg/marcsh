import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useEffect } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const dir = mkdtempSync(join(tmpdir(), "marcsh-help-key-"));
process.env.MARCSH_PREFERENCES_PATH = join(dir, "preferences.json");
process.env.MARCSH_HISTORY_PATH = join(dir, "history.jsonl");
process.env.MARCSH_COMMANDS_DIR = join(dir, "commands");
process.env.MARCSH_KEYBINDS_PATH = join(dir, "keybinds.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { InputBar } = await import("./input-bar");
const { useDialog } = await import("../providers/dialog");
const { useKeyboardLayer } = await import("../providers/keyboard-layer");

// S12: `?` on an empty prompt opens the help dialog; with text it is a character.

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let sent: string[] = [];

afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(async () => {
  sent = [];
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

const settle = async (ms = 40) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};

// What can be on top of the prompt: a dialog (any), or a prompt layer such as a permission request.
function Over({ what }: { what?: "dialog" | "permission" }) {
  const dialog = useDialog();
  const { push, pop } = useKeyboardLayer();
  useEffect(() => {
    if (what === "dialog") dialog.open({ title: "Something else", children: <text>an open dialog</text> });
    if (what === "permission") {
      push("permission");
      return () => pop("permission");
    }
    // Once: the context values change with every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [what]);
  return null;
}

async function open({ what, typeOnly = false, disabled = false }: { what?: "dialog" | "permission"; typeOnly?: boolean; disabled?: boolean } = {}) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: <RootLayout />,
      children: [
        {
          index: true,
          element: (
            <>
              <InputBar engine="claude" typeOnly={typeOnly} disabled={disabled} onSubmit={(text) => sent.push(text)} />
              <Over what={what} />
            </>
          ),
        },
      ],
    },
  ]);
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 30, kittyKeyboard: true, exitOnCtrlC: false });
  await settle(120);
}

describe("`?` opens the help dialog (S12)", () => {
  test("on an empty prompt it opens help and types nothing", async () => {
    await open();
    await type("?");

    expect(frame()).toContain("Help");
    await act(async () => screen!.mockInput.pressEscape());
    await settle(60);
    expect(frame()).not.toContain("Help");
    expect(frame()).toContain("Ask anything");
  });

  test("with text in the prompt it types a question mark", async () => {
    await open();
    await type("why");
    await type("?");

    expect(frame()).not.toContain("Help");
    await act(async () => screen!.mockInput.pressEnter());
    await settle(60);
    expect(sent).toEqual(["why?"]);
  });

  test("with a dialog on top it does not open help", async () => {
    await open({ what: "dialog" });
    expect(frame()).toContain("an open dialog");
    await type("?");

    expect(frame()).toContain("an open dialog");
    expect(frame()).not.toContain("Help");
  });

  test("with a permission prompt on top it does nothing", async () => {
    await open({ what: "permission" });
    await type("?");

    expect(frame()).not.toContain("Help");
  });

  test("on a prompt that only takes keys (typeOnly) it does not open help", async () => {
    await open({ typeOnly: true });
    await type("?");

    expect(frame()).not.toContain("Help");
  });

  test("on a disabled prompt it does nothing", async () => {
    await open({ disabled: true });
    await type("?");

    expect(frame()).not.toContain("Help");
  });
});
