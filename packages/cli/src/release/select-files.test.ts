import { describe, expect, test } from "bun:test";
import { selectReleaseFiles } from "./select-files";

const tracked = [
  ".github/workflows/release.yml",
  ".gitignore",
  "LICENSE",
  "README.md",
  "bun.lock",
  "bunfig.toml",
  "docs/packs.md",
  "package.json",
  "scripts/build-release.ts",
  "tsconfig.base.json",
  "packages/cli/bin/marcsh",
  "packages/cli/bunfig.toml",
  "packages/cli/package.json",
  "packages/cli/plugin/.claude-plugin/plugin.json",
  "packages/cli/plugin/commands/feature.md",
  "packages/cli/plugin/hooks/guard.ts",
  "packages/cli/plugin/hooks/guard.test.ts",
  "packages/cli/plugin/hooks/hooks.json",
  "packages/cli/plugin/skills/workflow/SKILL.md",
  "packages/cli/src/index.tsx",
  "packages/cli/src/theme.ts",
  "packages/cli/src/lib/bin.test.ts",
  "packages/cli/src/lib/storage.ts",
  "packages/cli/src/lib/engine/pi-trust.ts",
  "packages/cli/src/lib/engine/test-trust.ts",
  "packages/cli/src/lib/engine/fixtures/mcp-resource-server.ts",
  "packages/cli/src/lib/contest-trust.ts",
  "packages/cli/src/lib/fixtures.ts",
  "packages/cli/src/screens/home.tsx",
  "packages/cli/src/screens/home.test.tsx",
  "packages/cli/src/docs/doc-links.test.ts",
  "packages/cli/test-preload.test.ts",
  "packages/cli/test-preload.ts",
  "packages/cli/tsconfig.json",
];

describe("selectReleaseFiles", () => {
  const selected = selectReleaseFiles(tracked);

  // The MIT license asks for its notice in every copy, and a release archive is one.
  test("ships the license", () => {
    expect(selected).toContain("LICENSE");
  });

  test("keeps what `bun install --production` and the launcher need", () => {
    for (const path of [
      "package.json",
      "bun.lock",
      "packages/cli/package.json",
      "packages/cli/bin/marcsh",
      "packages/cli/tsconfig.json",
      "packages/cli/src/index.tsx",
      "packages/cli/src/theme.ts",
      "packages/cli/src/lib/storage.ts",
      "packages/cli/src/screens/home.tsx",
      "packages/cli/plugin/.claude-plugin/plugin.json",
      "packages/cli/plugin/commands/feature.md",
      "packages/cli/plugin/hooks/guard.ts",
      "packages/cli/plugin/hooks/hooks.json",
      "packages/cli/plugin/skills/workflow/SKILL.md",
    ]) {
      expect(selected).toContain(path);
    }
  });

  test("leaves out every test file and test preload", () => {
    expect(selected.filter((path) => /\.test\.tsx?$/.test(path))).toEqual([]);
    expect(selected.filter((path) => /(^|\/)test-preload[^/]*$/.test(path))).toEqual([]);
  });

  test("leaves out the test-only helpers and fixtures that app code never imports", () => {
    expect(selected).not.toContain("packages/cli/src/lib/engine/test-trust.ts");
    expect(selected.filter((path) => /(^|\/)fixtures\//.test(path))).toEqual([]);
    // Near misses are app files and ship.
    expect(selected).toContain("packages/cli/src/lib/engine/pi-trust.ts");
    expect(selected).toContain("packages/cli/src/lib/contest-trust.ts");
    expect(selected).toContain("packages/cli/src/lib/fixtures.ts");
  });

  test("leaves out bunfig.toml (root and package), CI, scripts and the user docs", () => {
    expect(selected.filter((path) => path.endsWith("bunfig.toml"))).toEqual([]);
    expect(selected.filter((path) => path.startsWith(".github/"))).toEqual([]);
    expect(selected.filter((path) => path.startsWith("scripts/"))).toEqual([]);
    // The installed app never reads README.md or docs/: they are for people reading the repository.
    expect(selected).not.toContain("README.md");
    expect(selected.filter((path) => path.startsWith("docs/"))).toEqual([]);
  });

  test("leaves out node_modules and anything else outside the list", () => {
    const result = selectReleaseFiles([
      ...tracked,
      "node_modules/react/index.js",
      "packages/cli/node_modules/zod/index.js",
      "packages/cli/src/node_modules/x.ts",
      ".gitignore",
    ]);
    expect(result.filter((path) => path.includes("node_modules"))).toEqual([]);
    expect(result).not.toContain(".gitignore");
  });

  test("is sorted and does not depend on the input order", () => {
    expect(selected).toEqual([...selected].sort());
    expect(selectReleaseFiles([...tracked].reverse())).toEqual(selected);
  });
});
