/**
 * Evidence log: every check run (tests, lint, typecheck, build) is recorded with its exit code and output tail
 * in `<brigadev home>/<repo>/evidence/<branch>.jsonl`, keyed to the worktree content tree it ran on (lib/tree.ts).
 *
 * The commit gate reads it: a commit with source changes needs a passing test recorded for the current tree, so
 * any edit after the last passing run blocks the commit until the tests run again.
 *
 * Vendored from brigadev-pi-harness (lib/evidence.ts). Changes for marcsh: `bun test` is a test runner; the exit
 * code comes from the hook payload (`exitCodeOf`); the tree before a run is kept in `evidence/.pending/`.
 */

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalPath, isInside } from "./paths.ts";
import { basename as executableName, blankHeredocs, tokenize, unwrap, type Segment } from "./shell.ts";

const MAX_COMMAND_CHARS = 500;
const TAIL_LINES = 20;
const TAIL_CHARS = 2000;
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Prose only: `.txt` and `.mdx` hold requirements, CMake lists, and components, so they count as source.
const DOC_EXTENSIONS = /\.(md|markdown|rst|adoc)$/i;
const DOC_NAMES = new Set(["LICENSE", "NOTICE", "COPYING", "AUTHORS"]);

const TEST_TOOLS = new Set(["vitest", "jest", "mocha", "pytest", "rspec", "phpunit"]);
const CHECK_TOOLS = new Set(["tsc", "eslint"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const TEST_SCRIPT = /^test(:.*)?$/;
const CHECK_SCRIPT = /^(lint|typecheck|check|build)(:.*)?$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// A segment starting with one of these can end the shell, replace it, or run other code before the test.
const CONTROL_WORDS = new Set(["exit", "return", "exec", "trap", "eval", "source", "."]);
const PIPEFAIL_SETTERS = new Set(["-o", "-eo", "-euo"]);
// Runner flags that exit 0 without running a test (help, version, listing, dry runs, config dumps), matched without any `=value`.
const NO_RUN_FLAGS = new Set([
	"--help", "-h", "-H", "-?", "--usage", "--version", "-V", "--v8-options", "--collect-only", "--co", "--listTests",
	"--list", "-list", "-help", "--dry-run", "--no-run", "--showConfig",
]);
// The only option a package manager may read before `--` and still vouch for a pass; any other (`-v`, `-w pkg`, `--color=-v`) might not run the script.
const PM_SILENT = new Set(["--silent", "-s"]);
// npm, pnpm, and yarn read their config from these variables (`npm_config_usage=true` prints usage and runs nothing).
const PM_CONFIG_ENV = /^(npm|pnpm|yarn)_config_/i;

export type CheckKind = "test" | "check";
export type CheckOutcome = "pass" | "fail" | "unknown";

export interface RunRecord {
	v: 1;
	type: "run";
	ts: string;
	branch: string | null;
	/** Worktree content tree the command ran on; undefined outside git or when it could not be vouched for. */
	tree?: string;
	cwd: string;
	/** MARCSH_AGENT (the turn's agent), or "parent" when marcsh did not say. */
	agent: string;
	command: string;
	kind: CheckKind;
	exitCode?: number;
	outcome: CheckOutcome;
	tail: string;
	/** Why the outcome could not be trusted beyond the command itself (e.g. "tree changed during run"). */
	note?: string;
}

/** Skips leading option words (`-y`, `--silent`). */
const skipFlags = (args: string[]): string[] => {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) i++;
	return args.slice(i);
};

/** Kind of a check run by a tool invoked directly (`vitest`, `cargo test`, `node --test`). */
function toolKind(argv: string[]): CheckKind | undefined {
	const name = executableName(argv[0] ?? "");
	const rest = argv.slice(1);
	if (TEST_TOOLS.has(name)) return "test";
	if (CHECK_TOOLS.has(name)) return "check";
	if ((name === "python" || name === "python3") && rest[0] === "-m" && rest[1] === "pytest") return "test";
	if (name === "node") {
		for (const word of rest) {
			if (!word.startsWith("-")) return undefined;
			if (word === "--test") return "test";
		}
		return undefined;
	}
	const sub = rest[0];
	switch (name) {
		case "cargo":
			return sub === "test" ? "test" : sub === "check" || sub === "build" || sub === "clippy" ? "check" : undefined;
		case "go":
			return sub === "test" ? "test" : sub === "vet" || sub === "build" ? "check" : undefined;
		case "make":
			return sub === "test" ? "test" : sub === "check" ? "check" : undefined;
		case "dotnet":
		case "mvn":
		case "gradle":
		case "gradlew":
			return sub === "test" ? "test" : undefined;
		default:
			return undefined;
	}
}

/** Kind of a check run through a package manager or a runner (`npm run test`, `bun test`, `pnpm exec vitest`, `npx jest`). */
function runnerKind(argv: string[]): CheckKind | undefined {
	const name = executableName(argv[0] ?? "");
	let rest = skipFlags(argv.slice(1));
	if (name === "npx" || name === "bunx") return toolKind(rest);
	if (!PACKAGE_MANAGERS.has(name)) return undefined;
	if (name === "pnpm" && rest[0] === "exec") return toolKind(skipFlags(rest.slice(1)));
	if (rest[0] === "run") rest = skipFlags(rest.slice(1));
	const script = rest[0];
	if (script === undefined) return undefined;
	if (TEST_SCRIPT.test(script)) return "test";
	if (CHECK_SCRIPT.test(script)) return "check";
	return name === "yarn" ? toolKind(rest) : undefined;
}

/** Kind of a segment whose command word is a check runner; a runner named only as an argument is not one. */
function segmentKind(argv: string[]): CheckKind | undefined {
	let i = 0;
	while (i < argv.length && (ASSIGNMENT.test(argv[i]) || argv[i] === "!")) i++;
	const command = argv.slice(i);
	return command.length === 0 ? undefined : (runnerKind(command) ?? toolKind(command));
}

const parse = (command: string): Segment[] => tokenize(blankHeredocs(command), { redirections: true });

/** The first segment that runs a test, else the first that runs another check. */
function firstCheck(segments: Segment[]): { kind: CheckKind; index: number } | undefined {
	let other: { kind: CheckKind; index: number } | undefined;
	for (let index = 0; index < segments.length; index++) {
		const kind = segmentKind(segments[index].argv);
		if (kind === "test") return { kind, index };
		if (kind && !other) other = { kind, index };
	}
	return other;
}

export function checkKind(command: string): CheckKind | undefined {
	return firstCheck(parse(command))?.kind;
}

/** Index of the first non-option word from `from` (words.length if none), or undefined at an option other than `-s`/`--silent`. */
function nextPositional(words: string[], from: number): number | undefined {
	let i = from;
	while (i < words.length && words[i].startsWith("-")) {
		if (!PM_SILENT.has(words[i])) return undefined;
		i++;
	}
	return i;
}

/** True when no word after the script (before `--`) is an option other than `-s`/`--silent`; a plain argument is no option, and every option that could take a value is already refused. */
const onlySilent = (words: string[]): boolean => words.every((word) => !word.startsWith("-") || PM_SILENT.has(word));

/** True when a no-run flag is among `words`; `-v` counts unless `verboseOk` (it means verbose for go test, pytest, cargo test). */
function hasNoRunFlag(words: string[], verboseOk: boolean): boolean {
	return words.some((word) => {
		if (!word.startsWith("-")) return false;
		const flag = word.split("=")[0];
		return NO_RUN_FLAGS.has(flag) || (flag === "-v" && !verboseOk);
	});
}

/** `-v` is verbose, not the version, for these runners. */
function verboseRunner(argv: string[]): boolean {
	const name = executableName(argv[0] ?? "");
	if (name === "pytest") return true;
	if ((name === "python" || name === "python3") && argv[1] === "-m" && argv[2] === "pytest") return true;
	return (name === "go" || name === "cargo") && argv[1] === "test";
}

/** A runner reached through `npx`, `pnpm exec`, or `yarn <tool>`: its own words, and the launcher's options before it, are checked. */
function toolMayRunNoTests(words: string[]): boolean {
	const tool = skipFlags(words);
	const launcher = words.slice(0, words.length - tool.length);
	return hasNoRunFlag(launcher, false) || hasNoRunFlag(tool, verboseRunner(tool));
}

/**
 * True when the check segment might print help, a version, or a listing and
 * exit 0 without running a test. A package-manager test run vouches for a
 * pass only with no option before `--` except `-s`/`--silent`; words after
 * `--` go to the script and are checked against the no-run flags.
 * `bun test` is bun's own runner, not a script: its arguments are the runner's.
 */
function mayRunNoTests(argv: string[]): boolean {
	let start = 0;
	while (start < argv.length && (ASSIGNMENT.test(argv[start]) || argv[start] === "!")) start++;
	const command = argv.slice(start);
	const name = executableName(command[0] ?? "");
	if (name === "bun" && command[1] === "test") return hasNoRunFlag(command.slice(2), false);
	if (name === "npx" || name === "bunx") return toolMayRunNoTests(command.slice(1));
	if (!PACKAGE_MANAGERS.has(name)) return hasNoRunFlag(command, verboseRunner(command));

	const dash = command.indexOf("--");
	const before = command.slice(1, dash === -1 ? undefined : dash);
	const after = dash === -1 ? [] : command.slice(dash + 1);
	let at = nextPositional(before, 0);
	if (at === undefined || at >= before.length) return true;
	if (name === "pnpm" && before[at] === "exec") return toolMayRunNoTests([...before.slice(at + 1), ...after]);
	if (before[at] === "run") at = nextPositional(before, at + 1);
	if (at === undefined || at >= before.length) return true;
	const script = before[at];
	if (TEST_SCRIPT.test(script) || CHECK_SCRIPT.test(script)) {
		return !onlySilent(before.slice(at + 1)) || hasNoRunFlag(after, false);
	}
	return toolMayRunNoTests([...before.slice(at), ...after]);
}

/** Where the command runs, so a `cd` before the check can be judged. */
export interface CheckContext {
	/** The session's working directory. */
	cwd?: string;
	/** Top level of the git work tree the evidence is keyed to. */
	topLevel?: string;
	/** Home directory for `~` (default: the user's). */
	home?: string;
}

function isPipefailSetter(argv: string[] | undefined): boolean {
	return !!argv && argv.length === 3 && argv[0] === "set" && PIPEFAIL_SETTERS.has(argv[1]) && argv[2] === "pipefail";
}

/** Directory after `cd`/`pushd` from `dir`, or undefined when it cannot be known to be inside `top`. */
function cdTarget(argv: string[], dir: string, top: string, home: string): string | undefined {
	if (executableName(argv[0]) === "popd") return undefined;
	const args = argv.slice(1).filter((word) => word === "-" || !word.startsWith("-"));
	if (args.length > 1 || args[0] === "-") return undefined;
	const raw = args[0] ?? "~";
	if (/[$`*?[{]/.test(raw) || (raw.startsWith("~") && raw !== "~" && !raw.startsWith("~/"))) return undefined;
	const expanded = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
	const target = canonicalPath(resolve(dir, expanded));
	return isInside(top, target) ? target : undefined;
}

/**
 * "pass" or "fail" only when the shell's exit code is the check's. That holds
 * for a plain `&&` chain whose segment is the runner itself: a `;`, `||`, `&`,
 * newline, `!`, comment, subshell, substitution, or a pipe after the check
 * hands the code to something else, and so does an `exit`, `exec`, `eval`, or
 * `source` before it. The one exception is a leading `set -o pipefail;`, which
 * lets a pipe follow the check. A `cd` before the check must stay inside the
 * git top level. Anything else is "unknown".
 */
export function checkOutcome(command: string, exitCode: number | undefined, context: CheckContext = {}): CheckOutcome {
	if (exitCode === undefined) return "unknown";
	const text = blankHeredocs(command);
	if (text.includes("`") || text.includes("$(")) return "unknown";
	// The tokenizer drops a separator that ends the command: `npm test &` runs in the background.
	const end = text.trimEnd();
	if (end.endsWith(";") || (end.endsWith("&") && !end.endsWith("&&"))) return "unknown";
	const segments = tokenize(text, { redirections: true });
	const found = firstCheck(segments);
	if (!found) return "unknown";
	if (mayRunNoTests(segments[found.index].argv)) return "unknown";
	// npm config can come from the environment (`npm_config_usage=true`), set on the segment or by an earlier one.
	for (let i = 0; i <= found.index; i++) {
		const { argv } = segments[i];
		let leading = 0;
		while (leading < argv.length && (ASSIGNMENT.test(argv[leading]) || argv[leading] === "!")) leading++;
		// Earlier segments: any word (`export npm_config_x=1`, `npm_config_x=1 true`); the check itself: only its leading assignments.
		if (argv.slice(0, i === found.index ? leading : argv.length).some((word) => PM_CONFIG_ENV.test(word))) return "unknown";
	}

	const pipefail = isPipefailSetter(segments[0]?.argv) && (segments[1]?.before === ";" || segments[1]?.before === "&&");
	for (let i = 0; i < segments.length; i++) {
		const { argv, before } = segments[i];
		const allowed = (i === 0 && before === "") || before === "&&" || (before === ";" && pipefail && i === 1) || (before === "|" && (i <= found.index || pipefail));
		if (!allowed || argv[0] === "!" || argv.some((word) => word.startsWith("#"))) return "unknown";
	}

	let dir = context.cwd ? canonicalPath(context.cwd) : undefined;
	const top = context.topLevel ? canonicalPath(context.topLevel) : undefined;
	for (let i = 0; i < found.index; i++) {
		const { argv: rest } = unwrap(segments[i].argv);
		const words = [...segments[i].argv.slice(0, segments[i].argv.length - rest.length), ...rest.slice(0, 1)];
		if (words.some((word) => CONTROL_WORDS.has(executableName(word)))) return "unknown";
		const name = executableName(rest[0] ?? "");
		if (name === "cd" || name === "pushd" || name === "popd") {
			dir = dir && top ? cdTarget(rest, dir, top, context.home ?? homedir()) : undefined;
			if (!dir) return "unknown";
		}
	}
	return exitCode === 0 ? "pass" : "fail";
}

export function outputTail(output: string, lines = TAIL_LINES): string {
	const tail = output.trimEnd().split("\n").slice(-lines).join("\n");
	return tail.length > TAIL_CHARS ? tail.slice(-TAIL_CHARS) : tail;
}

export function buildRunRecord(input: { ts: string; branch: string | null; tree?: string; cwd: string; agent: string; command: string; exitCode?: number; output: string; topLevel?: string; note?: string }): RunRecord {
	const record: RunRecord = {
		v: 1,
		type: "run",
		ts: input.ts,
		branch: input.branch,
		tree: input.tree,
		cwd: input.cwd,
		agent: input.agent,
		command: input.command.slice(0, MAX_COMMAND_CHARS),
		kind: checkKind(input.command) ?? "check",
		exitCode: input.exitCode,
		outcome: input.note ? "unknown" : checkOutcome(input.command, input.exitCode, { cwd: input.cwd, topLevel: input.topLevel }),
		tail: outputTail(input.output),
	};
	if (input.note) record.note = input.note;
	return record;
}

/**
 * The tree a run may be keyed to. A run counts for a tree only if that tree
 * was the same before and after it: an edit made while it ran (a parallel tool
 * call, `test && edit`) must not be vouched for. Without the tree before the
 * run, or when it changed, the run is recorded without a tree and as unknown.
 * No tree after the run means no git: nothing is recorded.
 */
export function settleRunTree(before: string | undefined, after: string | undefined): { record: false } | { record: true; tree: string | undefined; note?: string } {
	if (after === undefined) return { record: false };
	if (before === undefined) return { record: true, tree: undefined, note: "tree before the run is unknown" };
	if (before !== after) return { record: true, tree: undefined, note: "tree changed during run" };
	return { record: true, tree: after };
}

export function branchSlug(branch: string | null): string {
	return branch ? branch.replace(/[^A-Za-z0-9._-]+/g, "-") : "detached";
}

export function evidenceFile(evidenceDir: string, branch: string | null): string {
	return join(evidenceDir, `${branchSlug(branch)}.jsonl`);
}

/** Creates a folder (and missing parents) readable by the user only. */
function privateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// Not ours to change (an existing folder owned by someone else): the write below decides.
	}
}

/** One JSON line per record (file mode 0600, folder 0700); appends from several processes stay whole lines. */
export function appendEvidence(file: string, record: RunRecord): void {
	privateDir(dirname(file));
	appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readEvidence(file: string): RunRecord[] {
	if (!existsSync(file)) return [];
	const records: RunRecord[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (parsed?.v === 1 && parsed.type === "run") records.push(parsed);
		} catch {
			// A torn or hand-edited line must not hide the rest of the log.
		}
	}
	return records;
}

/** Prose and legal files never need a test run; everything else is source. */
export function isSourcePath(path: string): boolean {
	return !DOC_EXTENSIONS.test(path) && !DOC_NAMES.has(basename(path));
}

export type GateDecision = { action: "allow"; why: string } | { action: "block"; reason: string };

export interface GateInput {
	/** Paths `git status` reports as changed, repository-relative. */
	dirtyPaths: readonly string[];
	/** Current worktree content tree; undefined when there is no git work tree, or when `treeError` says it could not be computed. */
	tree: string | undefined;
	/** Why the tree could not be computed (timeout, git failure). Set means the gate fails closed; absent with no tree means no git. */
	treeError?: string;
	/** The commit may run in another directory or on another branch. */
	elsewhere: boolean;
	records: readonly RunRecord[];
}

const BYPASS = "Hooks cannot be overridden from the conversation. If the user wants to commit anyway, they can turn the brigadev pack's hooks off with /agents hooks.";

const UNBLOCK = `Run the tests in their own Bash command, with the runner as the command itself (\`npm test\`, \`bun test\`, \`node --test\`, ...; optionally in an \`&&\` chain) so its exit code is the test's: no \`;\`, \`||\`, \`&\`, \`!\`, comment, subshell, or later \`|\` unless a leading \`set -o pipefail;\` is set, and no \`cd\` out of the repository. Then commit again. ${BYPASS}`;

const TREE_ERROR_UNBLOCK = `Retry the commit; if it keeps failing, fix the git problem (a very large untracked file, a corrupt index, a stuck lock) or ignore the file. ${BYPASS}`;

export function decideCommitGate(input: GateInput): GateDecision {
	if (input.elsewhere) {
		return { action: "block", reason: `Blocked by brigadev evidence gate: this commit runs in another directory or on another branch, so the recorded test runs cannot vouch for it. Commit from the session's directory. ${UNBLOCK}` };
	}
	if (input.treeError !== undefined) {
		return { action: "block", reason: `Blocked by brigadev evidence gate: the working tree could not be computed (${input.treeError}), so no recorded test run can be matched to this commit. ${TREE_ERROR_UNBLOCK}` };
	}
	if (input.tree === undefined) return { action: "allow", why: "no git tree to check" };
	if (!input.dirtyPaths.some(isSourcePath)) return { action: "allow", why: "docs-only changes" };
	const runs = input.records.filter((r) => r.type === "run" && r.kind === "test" && r.tree === input.tree);
	if (runs.some((r) => r.outcome === "pass")) return { action: "allow", why: "passing test on this tree" };
	const last = runs.at(-1);
	const detail = !last
		? "no passing test is recorded for the current working tree (source files changed since the last passing run, or the tests never ran)"
		: last.outcome === "fail"
			? `the last test run on this tree failed (\`${last.command}\`, exit ${last.exitCode})`
			: `the last test run on this tree has no trustworthy exit code (\`${last.command}\`)`;
	return { action: "block", reason: `Blocked by brigadev evidence gate: ${detail}. ${UNBLOCK}` };
}

// ---------------------------------------------------------------------------------------------------------
// Hook payloads (marcsh runs the same scripts on pi and on Claude; see hooks/README.md for the verified shapes)
// ---------------------------------------------------------------------------------------------------------

export type HookMode = "pre" | "post" | "post-failure";

const asObject = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/** Text of a tool response: pi `{content:[{type:"text",text}]}`, Claude `{stdout, stderr}`, or a plain string. */
export function responseText(response: unknown): string {
	if (typeof response === "string") return response;
	const object = asObject(response);
	if (!object) return "";
	if (Array.isArray(object.content)) {
		return object.content
			.map((part) => asObject(part))
			.filter((part) => part?.type === "text" && typeof part.text === "string")
			.map((part) => part?.text as string)
			.join("\n");
	}
	return [object.stdout, object.stderr, object.output].filter((part): part is string => typeof part === "string" && part !== "").join("\n");
}

/** pi appends this to the output of a command that exited non-zero (pi's bash tool). */
const PI_EXIT = /(?:^|\n)Command exited with code (\d+)\s*$/;
/** Claude Code starts the error of a failed Bash call with this (not verified against Claude's source: an assumption). */
const CLAUDE_EXIT = /^Exit code (\d+)(?:\s|$)/;

/**
 * Exit code of the Bash call, or undefined when it cannot be known (never a pass).
 * PostToolUse: the call worked, so 0. PostToolUseFailure: parsed from `error`: on pi from the end of the text
 * (pi appends the status line after the output), on Claude (the payload has a `tool_use_id`, pi's has none) from
 * the start (Claude puts it before the output). Only the form of the engine at hand is trusted, so a command
 * cannot forge the other. A failure that says 0, a timeout, an abort, or an interrupt is unknown.
 */
export function exitCodeOf(input: { mode: "post" | "post-failure"; payload: Record<string, unknown> }): number | undefined {
	const { mode, payload } = input;
	if (payload.is_interrupt === true) return undefined;
	if (mode === "post") return asObject(payload.tool_response)?.interrupted === true ? undefined : 0;
	const error = typeof payload.error === "string" ? payload.error : "";
	const claude = typeof payload.tool_use_id === "string";
	const match = (claude ? CLAUDE_EXIT : PI_EXIT).exec(error);
	if (!match) return undefined;
	const code = Number(match[1]);
	// A failed call that says 0 contradicts itself: not trusted.
	return Number.isSafeInteger(code) && code > 0 ? code : undefined;
}

/** True when a PostToolUse is a background process starting (pi `bg_start`, Claude `run_in_background`), not a finished run. */
export function isBackgroundStart(payload: Record<string, unknown>): boolean {
	if (asObject(payload.tool_input)?.run_in_background === true) return true;
	const response = asObject(payload.tool_response);
	if (response && (typeof response.backgroundTaskId === "string" || typeof response.background_task_id === "string")) return true;
	return responseText(payload.tool_response).startsWith("Started background terminal");
}

/** The shell command of a Bash call, or undefined. */
export function commandOf(payload: Record<string, unknown>): string | undefined {
	const command = asObject(payload.tool_input)?.command;
	return typeof command === "string" ? command : undefined;
}

/** Key of a call's "tree before" file. Claude: the call itself (`tool_use_id`). pi, which has none: session, directory and command. */
export function pendingKey(payload: { session_id?: unknown; cwd?: unknown; tool_use_id?: unknown; tool_input?: unknown }): string {
	const command = asObject(payload.tool_input)?.command;
	const session = String(payload.session_id ?? "");
	const parts = typeof payload.tool_use_id === "string" && payload.tool_use_id !== "" ? ["call", session, payload.tool_use_id, String(command ?? "")] : ["run", session, String(payload.cwd ?? ""), String(command ?? "")];
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

interface Pending {
	tree: string;
	ts: number;
}

/** Records the tree a check command starts on (`evidence/.pending/<key>.json`), and drops leftovers older than a day. */
export function savePending(evidenceDir: string, key: string, tree: string): void {
	const dir = join(evidenceDir, ".pending");
	privateDir(dir);
	const now = Date.now();
	try {
		for (const name of readdirSync(dir)) {
			try {
				if (now - statSync(join(dir, name)).mtimeMs > PENDING_MAX_AGE_MS) rmSync(join(dir, name), { force: true });
			} catch {
				// Gone already.
			}
		}
	} catch {
		// Pruning is housekeeping.
	}
	const pending: Pending = { tree, ts: now };
	writeFileSync(join(dir, `${key}.json`), JSON.stringify(pending), { mode: 0o600 });
}

/** The tree recorded when the call started, removing the file; undefined when there is none. */
export function takePending(evidenceDir: string, key: string): string | undefined {
	const file = join(evidenceDir, ".pending", `${key}.json`);
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Pending>;
		return typeof parsed.tree === "string" ? parsed.tree : undefined;
	} catch {
		return undefined;
	} finally {
		rmSync(file, { force: true });
	}
}
