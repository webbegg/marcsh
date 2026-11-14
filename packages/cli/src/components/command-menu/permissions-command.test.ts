import { describe, expect, test } from "bun:test";
import { APPROVAL_MODES } from "../../lib/approval-policy";
import { PERMISSIONS_USAGE, parsePermissionsCommand, sessionModeMessage } from "./permissions-command";

describe("sessionModeMessage", () => {
  const feature = { kind: "feature", branch: "feat/x" } as const;

  test("keeps the existing toast when the mode is normal or the folder is on a feature branch", () => {
    expect(sessionModeMessage("normal")).toBe("Approval mode: normal for this session");
    expect(sessionModeMessage("normal", { kind: "default", branch: "main" })).toBe("Approval mode: normal for this session");
    expect(sessionModeMessage("auto", feature)).toBe("Approval mode: auto for this session");
    expect(sessionModeMessage("yolo", feature)).toBe("Approval mode: yolo for this session");
  });

  test("says auto and yolo are paused off a feature branch, with the reason", () => {
    expect(sessionModeMessage("yolo", { kind: "default", branch: "main" })).toBe(
      "Approval mode: yolo for this session. yolo is paused here: on the default branch main. marcsh asks as in normal mode until you work on a feature branch, preferably in a worktree.",
    );
    expect(sessionModeMessage("auto", { kind: "none", reason: "detached HEAD" })).toContain("auto is paused here: detached HEAD.");
    expect(sessionModeMessage("auto", { kind: "none", reason: "not a git repository" })).toContain("auto is paused here: not a git repository.");
  });
});

describe("parsePermissionsCommand", () => {
  test("no argument opens the dialog", () => {
    expect(parsePermissionsCommand("")).toEqual({ kind: "dialog" });
    expect(parsePermissionsCommand("   ")).toEqual({ kind: "dialog" });
  });

  test("a mode sets the session mode", () => {
    for (const mode of APPROVAL_MODES) expect(parsePermissionsCommand(mode)).toEqual({ kind: "set", mode });
    expect(parsePermissionsCommand("  yolo  ")).toEqual({ kind: "set", mode: "yolo" });
    expect(parsePermissionsCommand("AUTO")).toEqual({ kind: "set", mode: "auto" });
  });

  test("default <mode> saves the default for new sessions", () => {
    for (const mode of APPROVAL_MODES) expect(parsePermissionsCommand(`default ${mode}`)).toEqual({ kind: "default", mode });
  });

  test("an unknown mode gives the usage line, naming the word", () => {
    const parsed = parsePermissionsCommand("fast");
    expect(parsed).toEqual({ kind: "usage", message: `"fast" is not a mode. ${PERMISSIONS_USAGE}` });
    expect(parsePermissionsCommand("default fast")).toEqual({ kind: "usage", message: `"fast" is not a mode. ${PERMISSIONS_USAGE}` });
  });

  test("a missing or extra word gives the usage line", () => {
    expect(parsePermissionsCommand("default")).toEqual({ kind: "usage", message: PERMISSIONS_USAGE });
    expect(parsePermissionsCommand("default auto now")).toEqual({ kind: "usage", message: PERMISSIONS_USAGE });
    expect(parsePermissionsCommand("auto now")).toEqual({ kind: "usage", message: PERMISSIONS_USAGE });
  });

  test("the usage line names every mode", () => {
    for (const mode of APPROVAL_MODES) expect(PERMISSIONS_USAGE).toContain(mode);
  });
});
