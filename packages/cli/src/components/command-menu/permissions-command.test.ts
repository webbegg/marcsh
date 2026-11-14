import { describe, expect, test } from "bun:test";
import { APPROVAL_MODES } from "../../lib/approval-policy";
import { PERMISSIONS_USAGE, parsePermissionsCommand } from "./permissions-command";

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
