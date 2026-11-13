// Builds the release assets: `<out>/marcsh.tar.gz` and `<out>/marcsh.tar.gz.sha256` (`<hex>  marcsh.tar.gz`, the
// `shasum -a 256` format). Usage: bun scripts/build-release.ts [--out <dir>]   (default: dist/)
// The files and their contents come from HEAD (`git ls-tree`, `git archive`), not from the working tree: untracked files,
// uncommitted edits and files that were never committed cannot ship. Which of the committed files ship is decided by
// selectReleaseFiles.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { selectReleaseFiles } from "../packages/cli/src/release/select-files";

const ROOT = resolve(import.meta.dir, "..");
const TOP = "marcsh";
const TARBALL = "marcsh.tar.gz";
// Fixed modification time (1980-01-01), so the same files always give the same tarball.
const EPOCH = new Date(Date.UTC(1980, 0, 1));

// A failure throws instead of calling process.exit: exit would skip the `finally` that removes the staging folder.
class BuildError extends Error {}

function fail(message: string): never {
  throw new BuildError(message);
}

function parseOut(argv: string[]): string {
  let out = join(ROOT, "dist");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    if (arg !== "--out") fail(`unknown argument "${arg}" (usage: bun scripts/build-release.ts [--out <dir>])`);
    const value = argv[++i];
    if (!value) fail("--out needs a directory");
    out = resolve(value);
  }
  return out;
}

function run(command: string[], cwd: string, env?: Record<string, string>, stdin?: Uint8Array) {
  const result = Bun.spawnSync(command, { cwd, env: { ...process.env, ...env }, stdin, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail(`${command.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout;
}

function build(argv: string[]) {
  const out = parseOut(argv);

  const committed = run(["git", "ls-tree", "-r", "-z", "--name-only", "HEAD"], ROOT).toString().split("\0").filter(Boolean);
  const files = selectReleaseFiles(committed);
  if (files.length === 0) fail("no files selected (is this a git checkout with a commit?)");

  const staging = mkdtempSync(join(tmpdir(), "marcsh-release-"));
  const tarballTmp = join(out, `${TARBALL}.tmp`);
  const checksumTmp = join(out, `${TARBALL}.sha256.tmp`);
  try {
    // Unpack HEAD's copy of the selected files into marcsh/ first: it gives the top folder without GNU- or BSD-only tar
    // flags, keeps the committed executable bit, and lets the modes and times be fixed.
    const top = join(staging, TOP);
    mkdirSync(top);
    const archive = run(["git", "--literal-pathspecs", "archive", "--format=tar", "HEAD", "--", ...files], ROOT);
    run(["tar", "-xf", "-", "-C", top], staging, undefined, archive);
    for (const file of files) {
      const target = join(top, file);
      chmodSync(target, statSync(target).mode & 0o100 ? 0o755 : 0o644);
      utimesSync(target, EPOCH, EPOCH);
    }

    const list = join(staging, "files.txt");
    writeFileSync(list, files.map((file) => `${TOP}/${file}`).join("\n") + "\n");

    // uid/gid 0 and no names: the same bytes whoever builds it. GNU tar and bsdtar spell these flags differently.
    const gnu = run(["tar", "--version"], staging).toString().includes("GNU");
    const owner = gnu ? ["--owner=0", "--group=0", "--numeric-owner"] : ["--uid", "0", "--gid", "0", "--numeric-owner"];
    const tarFile = join(staging, "marcsh.tar");
    // COPYFILE_DISABLE: macOS tar would add `._*` extended-attribute entries.
    run(["tar", "-cf", tarFile, ...owner, "-C", staging, "-T", list], staging, { COPYFILE_DISABLE: "1" });
    // -n: no file name or time in the gzip header.
    const gzipped = run(["gzip", "-n", "-9", "-c", tarFile], staging);
    const hex = createHash("sha256").update(gzipped).digest("hex");

    // Both files are written under temp names first and renamed last, so a crash cannot leave a tarball next to the
    // checksum of another build. The old checksum goes before the new tarball arrives.
    mkdirSync(out, { recursive: true });
    writeFileSync(tarballTmp, gzipped);
    writeFileSync(checksumTmp, `${hex}  ${TARBALL}\n`);
    rmSync(join(out, `${TARBALL}.sha256`), { force: true });
    renameSync(tarballTmp, join(out, TARBALL));
    renameSync(checksumTmp, join(out, `${TARBALL}.sha256`));

    console.log(`${join(out, TARBALL)}: ${files.length} files, ${gzipped.length} bytes`);
    console.log(`${join(out, `${TARBALL}.sha256`)}: ${hex}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(tarballTmp, { force: true });
    rmSync(checksumTmp, { force: true });
  }
}

try {
  build(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof BuildError)) throw error;
  console.error(`build-release: ${error.message}`);
  process.exitCode = 1;
}
