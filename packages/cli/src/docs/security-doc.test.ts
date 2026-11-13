import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVAL_MODES, DEFAULT_APPROVAL_MODE } from "../lib/approval-policy";

// packages/cli/src/docs -> repository root
const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const read = (page: string) => (existsSync(join(ROOT, "docs", page)) ? readFileSync(join(ROOT, "docs", page), "utf8") : "");

const security = read("security.md");
const configuration = read("configuration.md");

// The text of the "### Permission modes" section, up to the next heading of the same level.
const section = security.match(/^### Permission modes\s*$([\s\S]*?)(?=^### |^## )/m)?.[1] ?? "";

describe("docs/security.md permission modes", () => {
  test("has a Permission modes section", () => {
    expect(section.length).toBeGreaterThan(0);
  });

  test("names every mode in the table, and the one sessions start in", () => {
    for (const mode of APPROVAL_MODES) expect(section).toContain(`| \`${mode}\` |`);
    expect(section).toContain(`\`${DEFAULT_APPROVAL_MODE}\` is the mode every session starts in`);
  });

  test("says what always asks, what is blocked, and what stays the same in every mode", () => {
    for (const text of [
      "always ask",
      "`sudo`",
      "`npm install`",
      "`rm -rf ~`",
      "stays blocked in `auto` and `yolo`",
      "temp folder",
      "best-effort check, not a sandbox",
      "Claude settings",
    ]) {
      expect(section).toContain(text);
    }
  });
});

describe("docs/configuration.md", () => {
  test("lists the approvalMode preference and its values", () => {
    const row = configuration.split("\n").find((line) => line.startsWith("| `approvalMode` |")) ?? "";
    expect(row).not.toBe("");
    for (const mode of APPROVAL_MODES) expect(row).toContain(`\`${mode}\``);
    expect(row).toContain(`Default: \`${DEFAULT_APPROVAL_MODE}\``);
  });
});
