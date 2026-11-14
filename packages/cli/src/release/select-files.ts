// Which repository files go into marcsh.tar.gz: what `bun install --frozen-lockfile --production` and
// `packages/cli/bin/marcsh` need, and nothing else. Anything not listed is left out (an allow-list), so a new file at the
// repository root never ships by accident. README.md and docs/ are for people reading the repository: the installed app
// never reads them.

// LICENSE and THIRD_PARTY_NOTICES.md: the MIT licenses (marcsh's own and those of the code it ported) ask for their notice in
// every copy, and the archive is one.
const FILES = new Set(["LICENSE", "THIRD_PARTY_NOTICES.md", "package.json", "bun.lock", "packages/cli/package.json", "packages/cli/tsconfig.json"]);
const FOLDERS = ["packages/cli/bin/", "packages/cli/src/", "packages/cli/plugin/"];

// Test-only: tests, test preloads and the helpers and fixtures that only tests import (`test-*` files such as
// engine/test-trust.ts, and `fixtures/` folders). No app code imports them.
const isTestFile = (path: string) =>
  /\.test\.tsx?$/.test(path) || /(^|\/)test-[^/]*$/.test(path) || /(^|\/)fixtures\//.test(path);
const isDependency = (path: string) => path.split("/").includes("node_modules");

/** The tracked paths (relative to the repository root, `/`-separated) that ship, sorted so the tarball is reproducible. */
export function selectReleaseFiles(tracked: readonly string[]): string[] {
  return tracked
    .filter((path) => FILES.has(path) || FOLDERS.some((folder) => path.startsWith(folder)))
    .filter((path) => !isTestFile(path) && !isDependency(path))
    .sort();
}
