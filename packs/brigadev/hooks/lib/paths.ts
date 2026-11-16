// Path helpers, vendored from brigadev-pi-harness (lib/paths.ts).
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export function expandHome(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

const MAX_LINK_HOPS = 40;

/**
 * Absolute path with symlinks resolved, so one directory reached two ways
 * (macOS /tmp and /private/tmp, a symlinked checkout) compares equal. Paths
 * that do not exist yet resolve through their nearest existing parent. A
 * dangling symlink resolves to its target, where a write would really land.
 */
export function canonicalPath(path: string, hops = 0): string {
	let existing = resolve(path);
	const missing: string[] = [];
	while (true) {
		try {
			return join(realpathSync(existing), ...missing.reverse());
		} catch {
			const target = danglingTarget(existing);
			if (target !== undefined && hops < MAX_LINK_HOPS) return join(canonicalPath(resolve(dirname(existing), target), hops + 1), ...missing.reverse());
			const parent = dirname(existing);
			if (parent === existing) return resolve(path);
			missing.push(existing.slice(parent.length).replace(/^[/\\]/, ""));
			existing = parent;
		}
	}
}

function danglingTarget(path: string): string | undefined {
	try {
		return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
	} catch {
		return undefined;
	}
}

export function isInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
