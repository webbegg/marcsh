// Content key of a working tree, plus the few git facts the hooks need.
//
// The key is the git tree id of every tracked and untracked, non-ignored file as it is on disk, computed in a
// throwaway index (seeded from the real one for its stat cache) so the user's index and staging are never
// touched. Commits do not change it; any edit does. Objects the computation writes go to a quarantine inside
// the scratch directory, with the real object store as a read-only alternate, so nothing lands in `.git/objects`.
// Vendored from brigadev-pi-harness (lib/worktree-tree.ts, lib/worktree-snapshot.ts).

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
/** One budget for the whole call (every git command in it). */
export const WORKTREE_TREE_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 5_000;

export type TreeResult = { kind: "tree"; tree: string } | { kind: "no-git" } | { kind: "error"; reason: string };

export interface WorktreeTreeOptions {
	/** Overall deadline in milliseconds (default 10 s). */
	timeoutMs?: number;
}

const NOT_A_WORK_TREE = /not a git repository|must be run in a work tree/i;

const describeFailure = (error: unknown, budgetMs: number): string => {
	const failure = error as { killed?: boolean; signal?: string; code?: unknown; stderr?: unknown; message?: unknown } | undefined;
	if (failure?.killed || failure?.signal === "SIGTERM") return `timed out after ${Math.round(budgetMs / 100) / 10}s`;
	if (failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "git output was too large";
	const detail = String(failure?.stderr || failure?.message || "").trim().split("\n")[0];
	return detail ? `git failed: ${detail.slice(0, 200)}` : "git failed";
};

/** The tree id, `no-git` when `cwd` is not in a git work tree (or git is missing), or `error` with the reason. */
export async function worktreeTreeResult(cwd: string, options: WorktreeTreeOptions = {}): Promise<TreeResult> {
	const budget = options.timeoutMs ?? WORKTREE_TREE_TIMEOUT_MS;
	const deadline = Date.now() + budget;
	// Spawning in a directory that does not exist fails like a missing git does: tell them apart.
	if (!existsSync(cwd)) return { kind: "error", reason: `the working directory ${cwd} does not exist` };
	let scratch: string | undefined;
	try {
		const git = async (args: string[], at: string, env: NodeJS.ProcessEnv = {}) => {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw Object.assign(new Error("deadline"), { killed: true });
			return (await run("git", args, { cwd: at, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...env }, timeout: remaining, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
		};
		let top: string;
		try {
			top = await git(["rev-parse", "--show-toplevel"], cwd);
		} catch (error) {
			const failure = error as { code?: unknown; killed?: boolean; stderr?: unknown };
			if (failure.code === "ENOENT") return { kind: "no-git" };
			if (!failure.killed && failure.code === 128 && NOT_A_WORK_TREE.test(String(failure.stderr ?? ""))) return { kind: "no-git" };
			throw error;
		}
		if (!top) return { kind: "no-git" };

		scratch = mkdtempSync(join(tmpdir(), "brigadev-tree-index-"));
		const realIndex = resolve(cwd, await git(["rev-parse", "--git-path", "index"], cwd));
		const realObjects = resolve(cwd, await git(["rev-parse", "--git-path", "objects"], cwd));
		const index = join(scratch, "index");
		const quarantine = join(scratch, "objects");
		mkdirSync(quarantine);
		if (existsSync(realIndex)) {
			copyFileSync(realIndex, index);
			// Keep the index mtime: git re-hashes "racily clean" entries (files modified no earlier than the index
			// was written). A fresh mtime would make a same-size edit in the same second look unchanged.
			const { atime, mtime } = statSync(realIndex);
			utimesSync(index, atime, mtime);
		}
		const env = {
			GIT_INDEX_FILE: index,
			GIT_OBJECT_DIRECTORY: quarantine,
			GIT_ALTERNATE_OBJECT_DIRECTORIES: [realObjects, process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES].filter(Boolean).join(delimiter),
		};
		await git(["add", "-A", "--", "."], top, env);
		const tree = await git(["write-tree"], top, env);
		return /^[0-9a-f]{40,64}$/.test(tree) ? { kind: "tree", tree } : { kind: "error", reason: "git write-tree printed no tree id" };
	} catch (error) {
		return { kind: "error", reason: describeFailure(error, budget) };
	} finally {
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	}
}

/** The tree id, or undefined when there is none (no git, or a failure). */
export async function worktreeTree(cwd: string, options: WorktreeTreeOptions = {}): Promise<string | undefined> {
	const result = await worktreeTreeResult(cwd, options);
	return result.kind === "tree" ? result.tree : undefined;
}

async function git(args: string[], cwd: string): Promise<string | undefined> {
	try {
		return (await run("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })).stdout;
	} catch {
		return undefined;
	}
}

/** Top level of the git work tree holding `cwd`, or undefined. */
export async function gitTopLevel(cwd: string): Promise<string | undefined> {
	return (await git(["rev-parse", "--show-toplevel"], cwd))?.trim() || undefined;
}

/** Current branch name, or null on a detached HEAD (or any failure). */
export async function currentBranch(cwd: string): Promise<string | null> {
	return (await git(["symbolic-ref", "--short", "-q", "HEAD"], cwd))?.trim() || null;
}

/** Paths from `git status --porcelain=v1 -z`; a rename or copy lists its original path too. */
export function parsePorcelain(output: string): string[] {
	const fields = output.split("\0");
	const paths: string[] = [];
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (field.length < 4) continue;
		paths.push(field.slice(3));
		if (/[RC]/.test(field.slice(0, 2)) && fields[i + 1]) paths.push(fields[++i]);
	}
	return paths;
}

/** Paths git reports as changed under `root` (all untracked files listed), or undefined when git cannot say. */
export async function dirtyPaths(root: string): Promise<string[] | undefined> {
	const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root);
	return status === undefined ? undefined : parsePorcelain(status);
}
