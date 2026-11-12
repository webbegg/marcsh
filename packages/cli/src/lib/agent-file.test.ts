import { describe, expect, test } from "bun:test";
import { readFrontmatter } from "./agent-file";

describe("readFrontmatter nested lines [S15]", () => {
  test("the indented lines under a key are kept as written, and the field stays null", () => {
    const { fields, nested } = readFrontmatter("---\nname: x\ntools:\n  bash: false\n  - Read\nmodel: m\n---\nBody");
    expect(fields.get("tools")).toBeNull();
    expect(nested.get("tools")).toEqual(["bash: false", "- Read"]);
    expect(fields.get("name")).toBe("x");
    expect(fields.get("model")).toBe("m");
  });

  test("every nested block is recorded under its own key", () => {
    const { nested } = readFrontmatter("---\npermission:\n  edit: deny\ntools:\n  bash: false\n---\n");
    expect(nested.get("permission")).toEqual(["edit: deny"]);
    expect(nested.get("tools")).toEqual(["bash: false"]);
  });

  test("a block scalar is not a nested block", () => {
    const { fields, nested } = readFrontmatter("---\ndescription: |\n  one\n  two\n---\n");
    expect(fields.get("description")).toBe("one\ntwo");
    expect(nested.has("description")).toBe(false);
  });

  test("a key with a value on its own line keeps its plain value", () => {
    const { fields, nested } = readFrontmatter("---\ntools: Read, Grep\n---\n");
    expect(fields.get("tools")).toBe("Read, Grep");
    expect(nested.size).toBe(0);
  });

  test("a file without frontmatter has none", () => {
    expect(readFrontmatter("just a body").nested.size).toBe(0);
  });
});
