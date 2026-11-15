import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useState } from "react";
import { TextAttributes } from "@opentui/core";
import type { CapturedSpan } from "@opentui/core";
import type { GitStatus } from "../lib/git-status";
import type { BranchState } from "../lib/git-branch";
import type { ApprovalMode } from "../lib/approval-policy";

process.env.MARCSH_DB_PATH = ":memory:";
const dir = mkdtempSync(join(tmpdir(), "marcsh-status-mode-"));
const prefsPath = join(dir, "preferences.json");
process.env.MARCSH_PREFERENCES_PATH = prefsPath;

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { StatusBar } = await import("./status-bar");

// M5 (pack integration): a mode that is not fully active (auto/yolo paused, e.g. on the default branch) is struck through and
// followed by a red `!`; the git segment names a linked worktree after the branch.

let screen: Awaited<ReturnType<typeof testRender>> | null = null;

afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(async () => {
  rmSync(prefsPath, { force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

const MAIN: BranchState = { kind: "default", branch: "main" };
const FEATURE: BranchState = { kind: "feature", branch: "feat/x" };
const gitOf = (status: GitStatus | null) => async () => status;
const settle = (ms = 150) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

async function render(element: React.ReactNode, approvalMode: ApprovalMode, width = 110) {
  writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "claude", approvalMode }), "utf8");
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ index: true, element }] }]);
  screen = await testRender(<RouterProvider router={router} />, { width, height: 6 });
  await settle();
  await screen.renderOnce();
  return screen.captureCharFrame();
}

/** Every span of the frame, in order. */
const spans = (): CapturedSpan[] => screen!.captureSpans().lines.flatMap((line) => line.spans);
const spanWith = (text: string) => spans().find((span) => span.text.includes(text));
const struck = (span: CapturedSpan | undefined) => span !== undefined && (span.attributes & TextAttributes.STRIKETHROUGH) !== 0;
const sameColour = (a: CapturedSpan | undefined, b: CapturedSpan | undefined) => a !== undefined && b !== undefined && a.fg.equals(b.fg);

describe("StatusBar mode that is not fully active", () => {
  test("auto on the default branch is struck through and followed by a `!`", async () => {
    const frame = await render(<StatusBar cwd="/repo" readGit={gitOf({ branch: "main", changed: null })} readBranch={() => MAIN} />, "auto");

    expect(frame).toContain("· auto !");
    expect(struck(spanWith("auto"))).toBe(true);
    expect(struck(spanWith("!"))).toBe(false);
  });

  test("yolo on the default branch: struck, and the `!` is in the error colour (the colour yolo itself is drawn in)", async () => {
    const frame = await render(<StatusBar cwd="/repo" readGit={gitOf({ branch: "main", changed: null })} readBranch={() => MAIN} />, "yolo");

    expect(frame).toContain("· yolo !");
    expect(struck(spanWith("yolo"))).toBe(true);
    expect(sameColour(spanWith("!"), spanWith("yolo"))).toBe(true);
  });

  test("auto paused outside a repository or on a detached HEAD", async () => {
    const none = await render(<StatusBar cwd="/elsewhere" readGit={gitOf(null)} readBranch={() => ({ kind: "none", reason: "not a git repository" })} />, "auto");

    expect(none).toContain("· auto !");
  });

  test("the `!` of auto on main is in the same colour as yolo's", async () => {
    await render(<StatusBar cwd="/repo" readGit={gitOf({ branch: "main", changed: null })} readBranch={() => MAIN} />, "yolo");
    const yolo = spanWith("yolo");
    await act(async () => screen!.renderer.destroy());
    await render(<StatusBar cwd="/repo" readGit={gitOf({ branch: "main", changed: null })} readBranch={() => MAIN} />, "auto");

    expect(sameColour(spanWith("!"), yolo)).toBe(true);
  });

  test("auto on a feature branch looks as before: no strike, no `!`", async () => {
    const frame = await render(<StatusBar cwd="/repo" readGit={gitOf({ branch: "feat/x", changed: null })} readBranch={() => FEATURE} />, "auto");

    expect(frame).toContain("· auto · feat/x");
    expect(frame).not.toContain("!");
    expect(struck(spanWith("auto"))).toBe(false);
  });

  test("normal has no mode label and no `!`, even on the default branch", async () => {
    const frame = await render(<StatusBar cwd="/repo" readGit={gitOf({ branch: "main", changed: null })} readBranch={() => MAIN} />, "normal");

    expect(frame).not.toContain("!");
    expect(frame).not.toContain("normal");
  });

  test("switching from main to a feature branch un-strikes the mode on the next git read", async () => {
    let branch = "main";
    const readGit = async () => ({ branch, changed: null });
    const readBranch = (): BranchState => (branch === "main" ? MAIN : FEATURE);
    let setMessages: (messages: any[]) => void = () => {};
    function Host() {
      const [messages, set] = useState<any[]>([]);
      setMessages = set;
      return <StatusBar cwd="/repo" readGit={readGit} readBranch={readBranch} messages={messages} />;
    }
    const before = await render(<Host />, "auto");
    expect(before).toContain("· auto !");

    branch = "feat/x";
    // A new message reads git again (as a tool call ending does).
    await act(async () => setMessages([{ id: "u", role: "user", parts: [] }]));
    await settle();
    await screen!.renderOnce();
    const after = screen!.captureCharFrame();

    expect(after).toContain("· auto · feat/x");
    expect(after).not.toContain("!");
    expect(struck(spanWith("auto"))).toBe(false);
  });

  // R3-2: where the checkout stands is read asynchronously, never by a synchronous git call in render.
  test("the paused state comes from an async read of the branch", async () => {
    const feature = await render(<StatusBar cwd="/repo" readGit={gitOf({ branch: "feat/x", changed: null })} readBranch={async () => FEATURE} />, "auto");
    expect(feature).toContain("· auto · feat/x");
    expect(feature).not.toContain("!");
    await act(async () => screen!.renderer.destroy());

    const main = await render(<StatusBar cwd="/repo" readGit={gitOf({ branch: "main", changed: null })} readBranch={async () => MAIN} />, "yolo");
    expect(main).toContain("· yolo !");
    expect(struck(spanWith("yolo"))).toBe(true);
  });

  // R3-10 / R4-2: with git status off (MARCSH_GIT_STATUS=off) or failing, the branch is still read, so the mark follows a switch.
  test("with no git status, a switch to a feature branch still un-strikes the mode", async () => {
    let branch = "main";
    const readBranch = async (): Promise<BranchState> => (branch === "main" ? MAIN : FEATURE);
    let setMessages: (messages: any[]) => void = () => {};
    function Host() {
      const [messages, set] = useState<any[]>([]);
      setMessages = set;
      return <StatusBar cwd="/repo" readGit={gitOf(null)} readBranch={readBranch} messages={messages} />;
    }
    expect(await render(<Host />, "auto")).toContain("· auto !");

    branch = "feat/x";
    // A tool call ending (here a new message) reads the branch again, as the branch's own poll does.
    await act(async () => setMessages([{ id: "u", role: "user", parts: [] }]));
    await settle();
    await screen!.renderOnce();
    const after = screen!.captureCharFrame();
    expect(after).toContain("· auto");
    expect(after).not.toContain("!");
    expect(struck(spanWith("auto"))).toBe(false);
  });

  test("the mode and its `!` are never dropped when narrow", async () => {
    const frame = await render(
      <StatusBar cwd="/repo" readGit={gitOf({ branch: "main", changed: 3 })} readBranch={() => MAIN} hint="enter steers" background="1 background terminal" />,
      "auto",
      30,
    );

    expect(frame).toContain("auto !");
    expect(frame).not.toContain("main");
  });
});

describe("StatusBar worktree", () => {
  test("names a linked worktree after the branch", async () => {
    const frame = await render(
      <StatusBar cwd="/repo" readGit={gitOf({ branch: "feat/x", changed: null, worktree: "pack-integration" })} readBranch={() => FEATURE} />,
      "normal",
    );

    expect(frame).toContain("· feat/x · wt pack-integration");
  });

  test("shows nothing extra in the main checkout", async () => {
    const frame = await render(<StatusBar cwd="/repo" readGit={gitOf({ branch: "feat/x", changed: null })} readBranch={() => FEATURE} />, "normal");

    expect(frame).toContain("· feat/x");
    expect(frame).not.toContain("wt ");
  });

  test("escapes the worktree name like the branch", async () => {
    const frame = await render(
      <StatusBar cwd="/repo" readGit={gitOf({ branch: "feat/x", changed: null, worktree: "wt‮exe" })} readBranch={() => FEATURE} />,
      "normal",
    );

    expect(frame).toContain("wt wt\\u202eexe");
    expect(frame).not.toContain("‮");
  });
});
