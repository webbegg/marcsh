#!/usr/bin/env bun
/**
 * brigadev evidence gate for marcsh. One script, three modes, wired in hooks.json:
 *
 *   pre           PreToolUse on Bash|Edit|Write|...: blocks a `git commit` with source changes unless a passing
 *                 test run is recorded for the current working tree; blocks writes into the evidence folder;
 *                 notes the tree a check command starts on.
 *   post          PostToolUse on Bash: records a finished check command (exit code 0: the call worked).
 *   post-failure  PostToolUseFailure on Bash: records it with the exit code parsed from the error text.
 *
 * Reads the hook's JSON from stdin. Exit 2 with a reason on stderr blocks a call; a hook can only block, never approve.
 * `pre` fails closed for a commit-looking command (a crash blocks it); `post` never fails the call.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { EVIDENCE_BLOCK, bashWritesEvidence, isEvidencePath, pathsOf } from "./lib/guard.ts";
import { brigadevHome, repoDocsDir } from "./lib/home.ts";
import { expandHome } from "./lib/paths.ts";
import {
	appendEvidence,
	buildRunRecord,
	checkKind,
	commandOf,
	decideCommitGate,
	evidenceFile,
	exitCodeOf,
	isBackgroundStart,
	pendingKey,
	readEvidence,
	responseText,
	savePending,
	settleRunTree,
	takePending,
	type HookMode,
} from "./lib/evidence.ts";
import { commitMatches } from "./lib/shell.ts";
import { currentBranch, dirtyPaths, gitTopLevel, worktreeTreeResult } from "./lib/tree.ts";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

type Payload = Record<string, unknown>;

/** Thrown to block the call with a reason. */
class Block extends Error {}

const cwdOf = (payload: Payload): string => (typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : process.cwd());
const evidenceDirOf = (cwd: string): string => join(repoDocsDir(cwd), "evidence");

/** A `git commit` is gated unless it runs outside git or touches only prose. */
async function commitGate(command: string, cwd: string): Promise<void> {
	const commits = commitMatches(command);
	if (commits.length === 0) return;
	const result = await worktreeTreeResult(cwd);
	const tree = result.kind === "tree" ? result.tree : undefined;
	const treeError = result.kind === "error" ? result.reason : undefined;
	let dirty: string[] = ["(unknown)"];
	let branch: string | null = null;
	let top: string | undefined;
	if (tree !== undefined) {
		top = await gitTopLevel(cwd);
		// Unknown dirty paths count as source: a gate that cannot see the change must not pass it.
		dirty = (top ? await dirtyPaths(top) : undefined) ?? ["(unknown)"];
		branch = await currentBranch(cwd);
	}
	const decision = decideCommitGate({
		dirtyPaths: dirty,
		tree,
		treeError,
		elsewhere: commits.some((match) => match.elsewhere === true),
		records: tree === undefined ? [] : readEvidence(evidenceFile(evidenceDirOf(cwd), branch)),
	});
	if (decision.action === "block") throw new Block(decision.reason);
}

/** Notes the tree a check command starts on, so the run can be keyed to a tree that did not change. */
async function notePending(payload: Payload, command: string, cwd: string): Promise<void> {
	// Cheap test first: hashing the worktree only pays off for a check command.
	if (checkKind(command) === undefined) return;
	const result = await worktreeTreeResult(cwd);
	if (result.kind !== "tree") return;
	savePending(evidenceDirOf(cwd), pendingKey(payload), result.tree);
}

async function pre(payload: Payload): Promise<void> {
	const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
	const cwd = cwdOf(payload);
	const home = brigadevHome();
	if (tool === "Bash") {
		const input = payload.tool_input;
		if (!input || typeof input !== "object") throw new Error("tool_input is not an object");
		const command = commandOf(payload);
		if (command === undefined) return;
		// Nobody forges a recorded test result. Reading stays allowed.
		if (bashWritesEvidence(command, home, homedir(), cwd)) throw new Block(EVIDENCE_BLOCK);
		await commitGate(command, cwd);
		await notePending(payload, command, cwd);
		return;
	}
	if (WRITE_TOOLS.has(tool)) {
		for (const path of pathsOf(payload.tool_input)) {
			if (isEvidencePath(home, resolve(cwd, expandHome(path)))) throw new Block(EVIDENCE_BLOCK);
		}
	}
}

async function post(mode: "post" | "post-failure", payload: Payload): Promise<void> {
	const command = commandOf(payload);
	if (command === undefined || checkKind(command) === undefined) return;
	const cwd = cwdOf(payload);
	const evidenceDir = evidenceDirOf(cwd);
	const before = takePending(evidenceDir, pendingKey(payload));
	// A background start is not a finished run (its pending note is spent above).
	if (mode === "post" && isBackgroundStart(payload)) return;
	const settled = settleRunTree(before, await afterTree(cwd));
	if (!settled.record) return;
	const branch = await currentBranch(cwd);
	const record = buildRunRecord({
		ts: new Date().toISOString(),
		branch,
		tree: settled.tree,
		note: settled.note,
		cwd,
		topLevel: await gitTopLevel(cwd),
		agent: process.env.MARCSH_AGENT || (typeof payload.agent === "string" && payload.agent) || "parent",
		command,
		exitCode: exitCodeOf({ mode, payload }),
		output: mode === "post" ? responseText(payload.tool_response) : typeof payload.error === "string" ? payload.error : "",
	});
	appendEvidence(evidenceFile(evidenceDir, branch), record);
}

async function afterTree(cwd: string): Promise<string | undefined> {
	const result = await worktreeTreeResult(cwd);
	return result.kind === "tree" ? result.tree : undefined;
}

/** Fail closed: a commit-looking command (or one naming the evidence folder) is blocked when this hook crashes. */
function looksSensitive(raw: string): boolean {
	return /\bgit\b[\s\S]*\bcommit\b/.test(raw) || raw.includes("evidence");
}

async function main(): Promise<void> {
	const mode = process.argv[2] as HookMode | undefined;
	const raw = await Bun.stdin.text();
	try {
		if (mode !== "pre" && mode !== "post" && mode !== "post-failure") throw new Error(`unknown mode ${String(mode)} (use pre, post or post-failure)`);
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("the hook payload is not a JSON object");
		const payload = parsed as Payload;
		if (mode === "pre") await pre(payload);
		else if (payload.tool_name === "Bash") await post(mode, payload);
	} catch (error) {
		if (error instanceof Block) {
			process.stderr.write(`${error.message}\n`);
			process.exitCode = 2;
			return;
		}
		// A post hook never disturbs the call: a missing record only means the gate asks for another test run.
		if (mode === "pre" && looksSensitive(raw)) {
			process.stderr.write(`Blocked by brigadev evidence gate: the gate failed (${error instanceof Error ? error.message : String(error)}), so this call cannot be checked. Retry; if it keeps failing, the user can turn the brigadev pack's hooks off with /agents hooks.\n`);
			process.exitCode = 2;
		}
	}
}

if (import.meta.main) await main();
