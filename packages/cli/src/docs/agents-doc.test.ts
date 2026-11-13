import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_FIELDS } from "../lib/agent-file";
import { FIELD_NAMES, TOOL_GROUPS } from "../lib/tool-names";

// packages/cli/src/docs -> repository root
const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const DOC = join(ROOT, "docs", "agents.md");

const doc = existsSync(DOC) ? readFileSync(DOC, "utf8") : "";

/** The text under the heading `title` (any level), up to the next heading. */
function section(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^#{1,6}\\s+${title}\\s*$`).test(line));
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && /^#{1,6}\s/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

/** The cells of the table row whose first cell is `name` as inline code: | `name` | ... |. Undefined when there is no such row. */
function rowCells(text: string, name: string): string[] | undefined {
  const row = text.split("\n").find((line) => new RegExp(`^\\|\\s*\`${name}\`\\s*\\|`).test(line));
  return row?.split("|").slice(1, -1).map((cell) => cell.trim());
}

const fieldsTable = section(doc, "Frontmatter fields");
const groupsTable = section(doc, "Groups");

describe("docs/agents.md", () => {
  test("exists", () => {
    expect(existsSync(DOC)).toBe(true);
  });

  test("has a row in the frontmatter table for every field the parser accepts", () => {
    expect(KNOWN_FIELDS.size).toBeGreaterThan(0);
    const missing = [...KNOWN_FIELDS].filter((field) => rowCells(fieldsTable, field) === undefined);
    expect(missing).toEqual([]);
  });

  test("has a row in the groups table for every tool group of the tools field", () => {
    const missing = TOOL_GROUPS.filter((group) => rowCells(groupsTable, group) === undefined);
    expect(missing).toEqual([]);
  });

  test("lists every name the tools field takes for a group in that group's row", () => {
    const missing: string[] = [];
    for (const [group, names] of Object.entries(FIELD_NAMES)) {
      const listed = (rowCells(groupsTable, group)?.[1] ?? "").split(",").map((name) => name.replace(/`/g, "").trim().toLowerCase());
      for (const name of names) if (!listed.includes(name)) missing.push(`${group}: ${name}`);
    }
    expect(missing).toEqual([]);
  });
});

describe("table helpers", () => {
  const sample = ["# Page", "", "## Fields", "", "| Field | Notes |", "| --- | --- |", "| `name` | a | b |", "", "## Groups", "| `read` | read, grep |"].join("\n");

  test("a row is found only inside its own section", () => {
    expect(rowCells(section(sample, "Fields"), "name")).toEqual(["`name`", "a", "b"]);
    expect(rowCells(section(sample, "Fields"), "read")).toBeUndefined();
    expect(rowCells(section(sample, "Groups"), "read")).toEqual(["`read`", "read, grep"]);
  });

  test("a missing section is empty", () => {
    expect(section(sample, "Nope")).toBe("");
  });
});
