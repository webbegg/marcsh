import { describe, expect, test } from "bun:test";
import { PACK_USAGE, parsePackCommand } from "./pack-command";

describe("parsePackCommand", () => {
  test("install takes the spec as typed", () => {
    expect(parsePackCommand("install acme/flows")).toEqual({ kind: "install", spec: "acme/flows" });
    expect(parsePackCommand("  install   acme/flows@v1  ")).toEqual({ kind: "install", spec: "acme/flows@v1" });
    expect(parsePackCommand("install https://github.com/acme/flows")).toEqual({ kind: "install", spec: "https://github.com/acme/flows" });
  });

  test("install without a spec shows the usage line", () => {
    expect(parsePackCommand("install")).toEqual({ kind: "usage", message: PACK_USAGE });
  });

  test("install with a spec that is not a GitHub repo says why, then shows the usage line", () => {
    const command = parsePackCommand("install nonsense");
    expect(command.kind).toBe("usage");
    const message = (command as { message: string }).message;
    expect(message).toContain('Cannot install "nonsense"');
    expect(message.endsWith(` ${PACK_USAGE}`)).toBe(true);
  });

  test("update and remove name the pack by its lower-cased owner/repo", () => {
    expect(parsePackCommand("update Acme/Flows")).toEqual({ kind: "update", id: "acme/flows" });
    expect(parsePackCommand("remove acme/flows")).toEqual({ kind: "remove", id: "acme/flows" });
    expect(parsePackCommand("update https://github.com/acme/flows.git")).toEqual({ kind: "update", id: "acme/flows" });
  });

  test("update alone opens the picker; remove alone shows the usage line", () => {
    expect(parsePackCommand("update")).toEqual({ kind: "picker", action: "update" });
    expect(parsePackCommand("remove")).toEqual({ kind: "usage", message: PACK_USAGE });
  });

  test("update and remove refuse a ref", () => {
    expect(parsePackCommand("update acme/flows@v2")).toEqual({
      kind: "usage",
      message: `acme/flows@v2 names a ref; update takes owner/repo. ${PACK_USAGE}`,
    });
    expect(parsePackCommand("remove acme/flows@v2")).toEqual({
      kind: "usage",
      message: `acme/flows@v2 names a ref; remove takes owner/repo. ${PACK_USAGE}`,
    });
  });

  test("update and remove with a name that is not a repo say why, then show the usage line", () => {
    const command = parsePackCommand("remove bad");
    expect(command.kind).toBe("usage");
    expect((command as { message: string }).message).toContain("not a GitHub repository");
    expect((command as { message: string }).message.endsWith(` ${PACK_USAGE}`)).toBe(true);
  });

  test("an unknown verb, no verb, or extra words show the usage line", () => {
    for (const args of ["", "   ", "list", "install a/b c/d", "update a/b extra", "remove a/b extra"]) {
      expect(parsePackCommand(args)).toEqual({ kind: "usage", message: PACK_USAGE });
    }
  });
});
