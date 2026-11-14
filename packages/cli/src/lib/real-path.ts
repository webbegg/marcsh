// Where a path really leads, for the checks that must not be fooled by a symlink (approval policy, folder rules, scratch deletes).

import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The real path `path` would have: symlinks resolved on the part that exists (the last name too), the rest appended. Null for a
 * dangling symlink, whose target is not known.
 */
export function realTarget(path: string): string | null {
  let existing = path;
  const missing: string[] = [];
  // `existsSync` follows symlinks: a dangling one counts as missing and is resolved below as a link.
  while (!existsSync(existing) && !isLink(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(existing.slice(parent.length + 1));
    existing = parent;
  }
  try {
    return join(realpathSync(existing), ...missing);
  } catch {
    return isLink(existing) ? null : path;
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True when `path`, after symlinks, is strictly inside `dir` (also after symlinks). */
export function reallyInside(path: string, dir: string): boolean {
  const root = realTarget(dir)?.replace(/\/+$/, "");
  const real = realTarget(path);
  return root !== undefined && real !== null && real.startsWith(`${root}/`);
}

/**
 * Whether the folders on `dir`'s path can only be repointed with root: every symlink on it (`/tmp` on macOS) is owned by root. A symlink
 * the user owns, which the agent could change, makes it unstable. Folders that do not exist yet count as stable.
 */
export function stableDir(dir: string): boolean {
  const segments = dir.split("/").filter(Boolean);
  for (let i = 1; i <= segments.length; i++) {
    try {
      const stat = lstatSync(`/${segments.slice(0, i).join("/")}`);
      if (stat.isSymbolicLink() && stat.uid !== 0) return false;
    } catch {
      return true;
    }
  }
  return true;
}

/**
 * Whether the folder holds a symlink: a glob there could reach through it. A folder that cannot be read counts as holding one; a
 * missing folder, or a file, holds nothing for a glob to match.
 */
export function holdsSymlink(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isSymbolicLink());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}
