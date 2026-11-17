// A small shell tokenizer and the `git commit` recognizer, vendored from brigadev-pi-harness
// (lib/command-classifier.ts, reduced to what the evidence gate needs). Best effort, not a sandbox:
// it does not expand variables, load scripts, or follow aliases. Unknown shapes are allowed, never guessed.

const SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n", "(", ")"]);
// Syntax words that can lead a segment (`then git commit`, `{ git commit; }`); the command follows them.
const RESERVED_WORDS = new Set(["{", "}", "!", "if", "then", "elif", "else", "fi", "while", "until", "do", "done"]);
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "nohup", "time", "nice", "exec", "xargs", "timeout", "caffeinate"]);
export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);
// Commands whose arguments are data (search patterns, text), not actions.
const TEXT_COMMANDS = new Set(["grep", "rg", "ag", "echo", "printf", "cat", "less", "head", "tail", "sed", "awk", "jq", "wc"]);

export interface Redirect {
	/** Output operator: >, >>, >|, >&, &>, &>>. */
	op: string;
	target: string;
}

export interface Segment {
	argv: string[];
	/** Separator that precedes this segment ("" for the first one). */
	before: string;
	/** Output redirections; only filled when tokenizing with `redirections`. */
	redirects: Redirect[];
}

/** Literal heredoc bodies are data, not commands. */
export function blankHeredocs(command: string): string {
	return command.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, (raw) => {
		const header = raw.slice(0, raw.indexOf("\n") + 1);
		return header + " ".repeat(raw.length - header.length);
	});
}

/** Index just past the `))` closing an arithmetic expression whose `((` ends at `from`, or -1. */
function arithmeticEnd(text: string, from: number): number {
	let depth = 2;
	let loweredToOneAt = -1;
	for (let j = from; j < text.length; j++) {
		if (text[j] === "(") depth++;
		else if (text[j] === ")") {
			depth--;
			if (depth === 1) loweredToOneAt = j;
			else if (depth === 0) return loweredToOneAt === j - 1 ? j + 1 : -1;
		}
	}
	return -1;
}

/** Index just past the `]]` closing a `[[` whose opening ends at `from`, or -1. */
function conditionalEnd(text: string, from: number): number {
	let quote: "'" | '"' | null = null;
	for (let j = from; j < text.length; j++) {
		const ch = text[j];
		if (quote) {
			if (ch === "\\" && quote === '"') j++;
			else if (ch === quote) quote = null;
		} else if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "\\") j++;
		else if (ch === "]" && text[j + 1] === "]" && /\s/.test(text[j - 1]) && (j + 2 >= text.length || /[\s;&|)]/.test(text[j + 2]))) return j + 2;
	}
	return -1;
}

/** Index just past the `)` closing a `$(` whose opening ends at `from`, or -1. */
function substitutionEnd(text: string, from: number): number {
	let depth = 1;
	let quote: "'" | '"' | null = null;
	for (let j = from; j < text.length; j++) {
		const ch = text[j];
		if (quote) {
			if (ch === "\\" && quote === '"') j++;
			else if (ch === quote) quote = null;
		} else if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "\\") j++;
		else if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return j + 1;
	}
	return -1;
}

/** Blanks a conditional's text (newlines kept), leaving its `$( )` substitutions, which run as commands. */
function blankAroundSubstitutions(region: string): string {
	let out = "";
	let quote: "'" | '"' | null = null;
	for (let j = 0; j < region.length; j++) {
		const ch = region[j];
		if (quote) {
			if (ch === "\\" && quote === '"') {
				out += region.slice(j, j + 2).replace(/[^\n]/g, " ");
				j++;
				continue;
			}
			if (ch === quote) quote = null;
		} else if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "\\") {
			out += region.slice(j, j + 2).replace(/[^\n]/g, " ");
			j++;
			continue;
		}
		if (quote !== "'" && ch === "$" && region[j + 1] === "(" && region[j + 2] !== "(") {
			const end = substitutionEnd(region, j + 2);
			if (end !== -1) {
				out += blankConditionals(region.slice(j, end));
				j = end - 1;
				continue;
			}
		}
		out += ch === "\n" ? ch : " ";
	}
	return out;
}

/**
 * `(( ))`, `$(( ))` and `[[ ]]` hold comparisons, where `>` is not a
 * redirection. Blanks them (newlines kept) so offsets and line structure
 * stay, except for the `$( )` substitutions inside, which still run.
 */
export function blankConditionals(command: string): string {
	let out = command;
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === "\\" && quote === '"') i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		const atWordStart = i === 0 || /[\s;&|(){]/.test(command[i - 1]);
		let end = -1;
		if (ch === "$" && command.startsWith("((", i + 1)) end = arithmeticEnd(command, i + 3);
		else if (ch === "(" && command[i + 1] === "(" && (i === 0 || !/[\w$]/.test(command[i - 1]))) end = arithmeticEnd(command, i + 2);
		else if (ch === "[" && command[i + 1] === "[" && atWordStart && /\s/.test(command[i + 2] ?? "")) end = conditionalEnd(command, i + 2);
		if (end > i) {
			out = out.slice(0, i) + blankAroundSubstitutions(out.slice(i, end)) + out.slice(end);
			i = end - 1;
		}
	}
	return out;
}

/**
 * Splits a command into segments of words. With `redirections`, unquoted
 * output operators (`>`, `>>`, `>|`, `>&`, `&>`, with an optional fd prefix)
 * and their target word are moved out of argv into `redirects`, and every
 * `(` or `)` is kept as the `before` of a segment, even an empty one, so the
 * scope of a subshell can be followed.
 */
export function tokenize(command: string, options: { redirections?: boolean } = {}): Segment[] {
	const redirections = options.redirections === true;
	const segments: Segment[] = [];
	let argv: string[] = [];
	let redirects: Redirect[] = [];
	let pendingOp: string | null = null;
	let before = "";
	let current = "";
	let inToken = false;
	let quote: "'" | '"' | null = null;

	const pushToken = () => {
		if (inToken) {
			if (pendingOp !== null) redirects.push({ op: pendingOp, target: current });
			else argv.push(current);
			pendingOp = null;
		}
		current = "";
		inToken = false;
	};
	const pushSegment = (separator: string) => {
		pushToken();
		const scopeMarker = redirections && (before === "(" || before === ")");
		if (argv.length > 0 || redirects.length > 0 || scopeMarker) segments.push({ argv, before, redirects });
		argv = [];
		redirects = [];
		pendingOp = null;
		before = separator;
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			inToken = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			if (command[i + 1] !== "\n") {
				current += command[i + 1];
				inToken = true;
			}
			i++;
			continue;
		}
		if (redirections && (ch === ">" || (ch === "&" && command[i + 1] === ">"))) {
			// A word of digits right before ">" is the file descriptor, not an argument.
			if (ch === ">" && inToken && /^\d+$/.test(current)) {
				current = "";
				inToken = false;
			} else pushToken();
			let op = ch;
			let next = i + 1;
			if (ch === "&") {
				op += ">";
				next++;
			}
			if (command[next] === ">") {
				op += ">";
				next++;
			} else if (ch === ">" && (command[next] === "|" || command[next] === "&")) {
				op += command[next];
				next++;
			}
			pendingOp = op;
			i = next - 1;
			continue;
		}
		const two = command.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			pushSegment(two);
			i++;
			continue;
		}
		if (SEPARATORS.has(ch)) {
			pushSegment(ch);
			continue;
		}
		if (ch === " " || ch === "\t") {
			pushToken();
			continue;
		}
		current += ch;
		inToken = true;
	}
	pushSegment("");
	return segments;
}

export function basename(executable: string): string {
	const slash = executable.lastIndexOf("/");
	return slash === -1 ? executable : executable.slice(slash + 1);
}

/** Strips leading reserved words, env assignments, and wrapper commands; reports whether sudo was used. */
export function unwrap(argv: string[]): { argv: string[]; privileged: boolean } {
	let rest = argv;
	let privileged = false;
	while (rest.length > 0) {
		const head = rest[0];
		if (RESERVED_WORDS.has(head)) {
			rest = rest.slice(1);
			continue;
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
			rest = rest.slice(1);
			continue;
		}
		const name = basename(head);
		if (!WRAPPERS.has(name)) break;
		if (name === "sudo" || name === "doas") privileged = true;
		rest = rest.slice(1);
		// Skip wrapper options and the timeout duration.
		while (rest.length > 0 && (rest[0].startsWith("-") || (name === "timeout" && /^\d/.test(rest[0])))) rest = rest.slice(1);
	}
	return { argv: rest, privileged };
}

function hasAny(args: string[], ...flags: string[]): boolean {
	return args.some((a) => flags.includes(a) || flags.some((f) => f.startsWith("--") && a.startsWith(`${f}=`)));
}

// Git subcommands that neither move HEAD to another branch nor change which
// repository a later command in the same line acts on.
const STAYS_ON_BRANCH_GIT = new Set(["add", "rm", "mv", "status", "diff", "log", "show", "apply", "fetch", "pull", "push", "commit", "stash", "tag", "blame", "ls-files", "rev-parse", "remote", "describe"]);

// Variables that point git at another repository, work tree, ref store, or index.
const GIT_LOCATION_ASSIGNMENT = /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE)=/;

/** Any word of the segment assigns a git-location variable (prefix, `env`, `export`, `declare -x`, ...). */
function setsGitLocation(rawArgv: string[]): boolean {
	return rawArgv.some((a) => GIT_LOCATION_ASSIGNMENT.test(a));
}

/** The script of `sh -c '<script>'` or `eval <words>`, or undefined for any other command. */
function shellScript(name: string, args: string[]): string | undefined {
	const scriptIndex = name === "eval" ? 0 : args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
	return name === "eval" ? args.join(" ") : scriptIndex >= 0 ? args[scriptIndex + 1] : undefined;
}

/** Directory or branch changes by the segment, which make a later `git commit` land somewhere the gate did not inspect. */
function changesCommitTarget(rawArgv: string[]): boolean {
	if (setsGitLocation(rawArgv)) return true;
	const { argv } = unwrap(rawArgv);
	if (argv.length === 0) return false;
	const name = basename(argv[0]);
	const args = argv.slice(1);
	if (name === "cd" || name === "pushd" || name === "popd") return true;
	if (name === "git") {
		const index = gitSubcommand(args);
		return index === -1 || !STAYS_ON_BRANCH_GIT.has(args[index]);
	}
	if (name === "gh") return args.includes("checkout");
	if (SHELLS.has(name) || name === "eval") {
		const script = shellScript(name, args);
		return script !== undefined && tokenize(blankHeredocs(script)).some((segment) => changesCommitTarget(segment.argv));
	}
	return false;
}

/** Returns the git subcommand index, skipping global options such as -C <dir>. */
function gitSubcommand(args: string[]): number {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") {
			i++;
			continue;
		}
		if (a.startsWith("-")) continue;
		return i;
	}
	return -1;
}

/** True when the git invocation targets another repository or work tree than the current directory's. */
function gitTargetsElsewhere(args: string[], rawArgv: string[]): boolean {
	const gitAt = rawArgv.findIndex((a) => basename(a) === "git");
	if (setsGitLocation(rawArgv.slice(0, Math.max(gitAt, 0)))) return true;
	const index = gitSubcommand(args);
	return args.slice(0, Math.max(index, 0)).some((a, i) => a === "-C" || a.startsWith("--git-dir") || a.startsWith("--work-tree") || (a === "-c" && /^core\.(worktree|bare)\b/i.test(args[i + 1] ?? "")));
}

export interface CommitMatch {
	/** The commit may not run in the session's directory or on its current branch: a preceding `cd`, branch switch, or `-C`/`--git-dir`/`--work-tree` style redirection. */
	elsewhere?: boolean;
	amend: boolean;
}

function commitsOfSegment(rawArgv: string[]): CommitMatch[] {
	const { argv } = unwrap(rawArgv);
	if (argv.length === 0) return [];
	const name = basename(argv[0]);
	const args = argv.slice(1);

	if (SHELLS.has(name) || name === "eval") {
		const script = shellScript(name, args);
		if (!script) return [];
		const nested = commitMatches(script);
		// A location variable set on the wrapper applies to every git call inside its script.
		if (setsGitLocation(rawArgv)) for (const match of nested) match.elsewhere = true;
		return nested;
	}
	if (TEXT_COMMANDS.has(name) || name !== "git") return [];
	const index = gitSubcommand(args);
	if (index === -1 || args[index] !== "commit") return [];
	const match: CommitMatch = { amend: hasAny(args.slice(index + 1), "--amend") };
	if (gitTargetsElsewhere(args, rawArgv)) match.elsewhere = true;
	return [match];
}

/** Every `git commit` a shell command runs, with whether it may land elsewhere than the session's directory and branch. */
export function commitMatches(command: string): CommitMatch[] {
	const matches: CommitMatch[] = [];
	let moved = false;
	for (const segment of tokenize(blankHeredocs(command))) {
		const found = commitsOfSegment(segment.argv);
		if (moved) for (const match of found) match.elsewhere = true;
		matches.push(...found);
		moved ||= changesCommitTarget(segment.argv);
	}
	return matches;
}
