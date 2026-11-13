import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..", "..");

// The release workflow and install.sh run `bun install --frozen-lockfile`, which may reject a bun.lock that
// disagrees with a workspace package.json.
test("bun.lock records the packages/cli version", () => {
  const version = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version;
  const lock = readFileSync(join(root, "bun.lock"), "utf8");
  const entry = /"packages\/cli": \{\s*"name": "@marcsh\/cli",\s*"version": "([^"]+)"/.exec(lock);
  expect(entry?.[1]).toBe(version);
});
