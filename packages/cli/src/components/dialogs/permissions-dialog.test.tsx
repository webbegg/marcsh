import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useEffect } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-permissions-"));
const prefsPath = join(prefsDir, "preferences.json");
// The folder the dialog reads the branch of: a plain folder (no repository) unless a test points it elsewhere.
let dialogCwd = prefsDir;
process.env.MARCSH_PREFERENCES_PATH = prefsPath;

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../../layouts/root-layout");
const { Home } = await import("../../screens/home");
const { useDialog } = await import("../../providers/dialog");
const { usePromptConfig } = await import("../../providers/prompt-config");
const { StatusBar } = await import("../status-bar");
const { PermissionsDialogContent } = await import("./permissions-dialog");
type PromptConfig = ReturnType<typeof usePromptConfig>;

let config: PromptConfig;
let reopen: () => void;
// Opens the dialog the way /permissions does, with the provider's values as they are when it opens.
function OpenDialog() {
  const dialog = useDialog();
  config = usePromptConfig();
  useEffect(() => {
    reopen = () =>
      dialog.open({
        title: "Permissions",
        children: (
          <PermissionsDialogContent
            currentMode={config.approvalMode}
            defaultMode={config.defaultApprovalMode}
            cwd={dialogCwd}
            onSelectMode={config.setApprovalMode}
            onSelectDefault={config.setDefaultApprovalMode}
          />
        ),
      });
    reopen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <StatusBar engine="claude" />;
}

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(60);
};
const pressDown = async () => {
  await act(async () => screen!.mockInput.pressArrow("down"));
  await settle(60);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const frame = () => screen!.captureCharFrame().replace(/[│\s]+/g, " ");
const savedPreferences = () => JSON.parse(readFileSync(prefsPath, "utf8"));

async function openDialog() {
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ index: true, element: <OpenDialog /> }] }]);
  screen = await testRender(<RouterProvider router={router} />, { width: 90, height: 30 });
  await settle(100);
}

async function openHome() {
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Home /> }] }]);
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 30 });
  await settle(120);
}

afterEach(async () => {
  dialogCwd = prefsDir;
  rmSync(prefsPath, { force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});
afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));

describe("permissions dialog (S6)", () => {
  test("lists normal, auto and yolo with what each does, and marks the current one", async () => {
    await openDialog();
    const text = frame();
    expect(text).toContain("Permissions");
    expect(text).toContain("• normal asks before edits and commands, as before");
    expect(text).toContain("auto on a feature branch: edits and ordinary commands run; commits and remote actions ask");
    expect(text).toContain("yolo on a feature branch: as auto, and local commits run; remote actions and leaving the branch ask");
    // The session mode equals the saved default: no row to save it.
    expect(text).not.toContain("for new sessions");
  });

  test("choosing a mode sets this session's mode, shows a toast and saves nothing", async () => {
    await openDialog();

    await pressDown();
    await press("RETURN");

    expect(config.approvalMode).toBe("auto");
    const text = frame();
    expect(text).toContain("Approval mode: auto for this session");
    expect(text).not.toContain("asks before edits");
    expect(text).toContain("Build › opus · claude · auto");
    expect(() => readFileSync(prefsPath, "utf8")).toThrow();
  });

  test("choosing auto or yolo in a folder that is not on a feature branch says the mode is paused", async () => {
    await openDialog();

    await pressDown();
    await pressDown();
    await press("RETURN");

    expect(config.approvalMode).toBe("yolo");
    // The toast wraps inside its border.
    const text = frame().replace(/[┃\s]+/g, " ");
    expect(text).toContain("Approval mode: yolo for this session.");
    expect(text).toContain("yolo is paused here: not a git repository. marcsh asks as in normal mode until you work on a feature branch, preferably in a worktree.");
  });

  test("on a feature branch the toast does not mention a pause", async () => {
    dialogCwd = join(prefsDir, "repo");
    mkdirSync(dialogCwd);
    const init = Bun.spawnSync(["git", "init", "-q", "-b", "feat/x"], { cwd: dialogCwd, stdout: "ignore", stderr: "pipe" });
    expect(init.exitCode).toBe(0);
    await openDialog();

    await pressDown();
    await pressDown();
    await press("RETURN");

    expect(frame()).toContain("Approval mode: yolo for this session");
    expect(frame()).not.toContain("paused");
  });

  test("when the mode differs from the saved default a row saves it for new sessions", async () => {
    writeFileSync(prefsPath, JSON.stringify({ themeName: "nord" }), "utf8");
    await openDialog();
    await press("ESCAPE");
    await act(async () => config.setApprovalMode("yolo"));
    await settle();
    await act(async () => reopen());
    await settle(60);

    expect(frame()).toContain("• yolo");
    expect(frame()).toContain("Use yolo for new sessions");

    await pressDown();
    await pressDown();
    await pressDown();
    await press("RETURN");

    expect(savedPreferences()).toEqual({ themeName: "nord", approvalMode: "yolo" });
    expect(config.defaultApprovalMode).toBe("yolo");
    expect(frame()).toContain("New sessions will start in yolo mode");
    expect(frame()).not.toContain("Use yolo for new sessions");
  });
});

describe("/permissions (S6)", () => {
  test("/permissions yolo sets the session mode and the status bar shows it", async () => {
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "claude" }), "utf8");
    await openHome();
    expect(frame()).toContain("Build › opus · claude");

    await type("/permissions yolo");
    await press("RETURN");

    expect(frame()).toContain("Approval mode: yolo for this session");
    expect(frame()).toContain("Build › opus · claude · yolo");
    expect(savedPreferences()).toEqual({ defaultEngine: "claude" });
  });

  test("/permissions default auto saves the default and keeps the other preferences", async () => {
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "claude" }), "utf8");
    await openHome();

    await type("/permissions default auto");
    await press("RETURN");

    expect(savedPreferences()).toEqual({ defaultEngine: "claude", approvalMode: "auto" });
    expect(frame()).toContain("New sessions will start in auto mode");
    // This session is unchanged.
    expect(frame()).not.toContain("claude · auto");
  });

  test("an unknown mode shows the usage line and changes nothing", async () => {
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "claude" }), "utf8");
    await openHome();

    await type("/permissions fast");
    await press("RETURN");

    expect(frame()).toContain('"fast" is not a mode. Usage: /permissions');
    expect(savedPreferences()).toEqual({ defaultEngine: "claude" });
    expect(frame()).not.toContain("claude · ");
  });

  test("/permissions opens the dialog, and the row that saves the default appears once the session mode differs", async () => {
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "claude" }), "utf8");
    await openHome();

    await type("/permissions");
    await press("RETURN");
    expect(frame()).toContain("• normal");
    expect(frame()).not.toContain("for new sessions");
    await press("ESCAPE");

    await type("/permissions auto");
    await press("RETURN");
    await type("/permissions");
    await press("RETURN");
    expect(frame()).toContain("• auto");
    expect(frame()).toContain("Use auto for new sessions");

    await pressDown();
    await pressDown();
    await pressDown();
    await press("RETURN");
    expect(savedPreferences().approvalMode).toBe("auto");
    expect(frame()).toContain("New sessions will start in auto mode");
  });
});
