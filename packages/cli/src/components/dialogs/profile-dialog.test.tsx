import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useEffect } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const root = mkdtempSync(join(tmpdir(), "marcsh-profile-dialog-"));
process.env.MARCSH_PREFERENCES_PATH = join(root, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../../layouts/root-layout");
const { useDialog } = await import("../../providers/dialog");
const { ProfileDialogContent } = await import("./profile-dialog");
const { parseProfileCommand, runProfileCommand } = await import("../../lib/profiles-command");
const { loadProfiles, profilesPath } = await import("../../lib/profiles");

let dir: string;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

// Opens the dialog the way `/profile` does: the routing report, and the offer only when there is no file.
function OpenProfile() {
  const dialog = useDialog();
  useEffect(() => {
    const env = { engine: "pi", setPiModel: () => {}, setClaudeModel: () => {}, subagents: () => [], piModel: "openai/gpt-5", claudeModel: "sonnet" };
    const outcome = runProfileCommand(parseProfileCommand(""), env);
    if (!("show" in outcome)) throw new Error("expected a report");
    dialog.open({
      title: "Model Profile",
      width: "wide",
      children: <ProfileDialogContent lines={outcome.show} onCreate={outcome.create ? () => runProfileCommand({ kind: "create-starter" }, env) : undefined} />,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <text>home</text>;
}

beforeEach(() => {
  dir = mkdtempSync(join(root, "case-"));
  process.env.MARCSH_PROFILES_PATH = join(dir, "marcsh", "profiles.json");
});

afterEach(async () => {
  delete process.env.MARCSH_PROFILES_PATH;
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

// OpenTUI 0.9 paints a committed update on a later frame (and a frame cannot be read mid-paint): draw it before it is read.
const settle = async (ms = 30) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(80);
};
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
// Paths wrap in a dialog: compare with every space and border dropped.
const packed = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, "");

async function open() {
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ index: true, element: <OpenProfile /> }] }]);
  screen = await testRender(<RouterProvider router={router} />, { width: 120, height: 36 });
  await settle(120);
}

describe("/profile with no file (S17, L6/Q3)", () => {
  test("offers a row that creates a starter file, and says nothing has been written yet", async () => {
    await open();

    expect(frame()).toContain("There is no profiles file yet");
    expect(frame()).toContain("Create a starter profiles file");
    expect(existsSync(profilesPath())).toBe(false);
  });

  test("Enter creates the file at profilesPath() (parent folder included), it parses, and the path is shown", async () => {
    await open();
    await press("RETURN");

    const path = profilesPath();
    expect(path.startsWith(dir)).toBe(true);
    const loaded = loadProfiles(path);
    expect(loaded.exists).toBe(true);
    expect(loaded.problems).toEqual([]);
    expect(loaded.file.default).toBe("default");
    expect(loaded.file.profiles.default?.primary?.model).toBe("openai/gpt-5");
    expect(packed()).toContain(`Created${path}`);
    // The offer is gone once the file exists.
    expect(frame()).not.toContain("Create a starter profiles file");
  });

  test("a file that appears between the offer and the confirm is never overwritten", async () => {
    await open();
    expect(frame()).toContain("Create a starter profiles file");
    mkdirSync(join(dir, "marcsh"), { recursive: true });
    const theirs = JSON.stringify({ version: 1, profiles: { mine: { primary: { model: "sonnet" } } } });
    writeFileSync(profilesPath(), theirs);

    await press("RETURN");

    expect(readFileSync(profilesPath(), "utf8")).toBe(theirs);
    expect(frame()).toContain("already exists");
    expect(frame()).toContain("left as it is");
  });

  test.skipIf(process.getuid?.() === 0)("a folder that cannot be written gets a permission message and no file", async () => {
    const locked = join(dir, "marcsh");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      await open();
      await press("RETURN");
      expect(frame()).toContain("permission denied");
      expect(existsSync(profilesPath())).toBe(false);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test("with a file there is no offer, and Enter does not write", async () => {
    mkdirSync(join(dir, "marcsh"));
    const mine = JSON.stringify({ version: 1, profiles: { mine: { primary: { model: "sonnet" } } } });
    writeFileSync(profilesPath(), mine);
    await open();

    expect(frame()).not.toContain("Create a starter profiles file");
    await press("RETURN");
    expect(readFileSync(profilesPath(), "utf8")).toBe(mine);
  });
});
