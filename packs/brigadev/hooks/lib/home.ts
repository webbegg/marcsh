// Where brigadev keeps its per-repository documents: `<brigadev home>/<repo>/`.
// Vendored from brigadev-pi-harness (lib/repo-docs.ts).
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalPath, expandHome } from "./paths.ts";

const GIT_TIMEOUT_MS = 5_000;
const FALLBACK_NAME = "project";

/** `~/.brigadev`, or `BRIGADEV_HOME` when set (tests and relocated setups). */
export function brigadevHome(env: Record<string, string | undefined> = process.env): string {
	const override = env.BRIGADEV_HOME?.trim();
	return override ? resolve(expandHome(override)) : join(homedir(), ".brigadev");
}

/**
 * Basename of the main worktree root, so every worktree of a repository
 * shares one folder. Outside git (or for a bare or submodule layout, where
 * the common dir is not a `.git` folder), the basename of `cwd`.
 */
export function repoName(cwd: string): string {
	const own = basename(resolve(cwd)) || FALLBACK_NAME;
	try {
		const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: GIT_TIMEOUT_MS }).trim();
		// Canonical: at the checkout root git prints a relative `.git`, and from a worktree the real absolute path.
		const commonDir = canonicalPath(resolve(cwd, common));
		return common && basename(commonDir) === ".git" ? basename(dirname(commonDir)) || own : own;
	} catch {
		return own;
	}
}

/** Folder for this repository's harness documents. */
export function repoDocsDir(cwd: string, env: Record<string, string | undefined> = process.env): string {
	return join(brigadevHome(env), repoName(cwd));
}
