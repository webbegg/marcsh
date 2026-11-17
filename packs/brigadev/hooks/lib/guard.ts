// Anti-forge rules: nothing but the recorder writes the evidence folder. Vendored from brigadev-pi-harness
// (lib/guard-rules.ts), adapted to marcsh hook payloads. A textual best-effort rule: reading stays allowed, and a
// deliberately obfuscated command (a path built from variables, `cd` then a relative write) is not prevented.

import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { basename as executableName, blankHeredocs, tokenize } from "./shell.ts";
import { canonicalPath, expandHome, isInside } from "./paths.ts";

export const EVIDENCE_BLOCK =
	"Blocked by brigadev guard: the evidence log is written only by the recorder, so a recorded test result cannot be forged. Read it if you need it; run the tests to add to it.";

// Commands that create, change, or remove files; one of them next to an evidence path is a write.
const WRITE_COMMANDS = new Set(["tee", "cp", "mv", "rm", "ln", "dd", "truncate", "install", "touch", "sed", "awk", "gawk", "perl", "python", "python3", "node", "ruby", "bun", "deno", "rsync", "unlink", "shred", "chmod", "mkdir", "rmdir", "patch"]);

/**
 * True when `target` is in the evidence folder (`<home>/<repo>/evidence`, any repo) or inside it, symlinks and
 * `..` resolved. Any repo, not only the current one: a forged record for another repository is no less a forgery.
 */
export function isEvidencePath(home: string, target: string): boolean {
	const root = canonicalPath(home);
	const path = canonicalPath(target);
	if (!isInside(root, path)) return false;
	const segments = relative(root, path).split(sep);
	return segments.length >= 2 && segments[1] === "evidence";
}

/** The file paths a file-writing tool call names (`file_path` on Claude, `path` on pi, `notebook_path`). */
export function pathsOf(toolInput: unknown): string[] {
	if (!toolInput || typeof toolInput !== "object") return [];
	const input = toolInput as Record<string, unknown>;
	const paths: string[] = [];
	for (const key of ["file_path", "path", "notebook_path"]) {
		const value = input[key];
		if (typeof value === "string" && value !== "" && !paths.includes(value)) paths.push(value);
	}
	return paths;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Spellings of the brigadev home a command can use: absolute, `~/`, `$HOME/`, `${HOME}/`. */
function homeForms(home: string, userHome: string): string[] {
	const forms: string[] = [];
	for (const form of [home, canonicalPath(home)]) {
		forms.push(form);
		if (isInside(userHome, form) && form !== userHome) {
			const rest = relative(userHome, form).split(sep).join("/");
			forms.push(`~/${rest}`, `$HOME/${rest}`, `\${HOME}/${rest}`);
		}
	}
	return forms;
}

/** A command that starts in `cwd` reaches the evidence folder by a relative word, or starts inside it. */
function reachesEvidenceFromCwd(text: string, home: string, cwd: string): boolean {
	if (isEvidencePath(home, cwd)) return true;
	for (const segment of tokenize(text, { redirections: true })) {
		for (const word of [...segment.argv, ...segment.redirects.map((redirect) => redirect.target)]) {
			if (word !== "" && isEvidencePath(home, resolve(cwd, expandHome(word)))) return true;
		}
	}
	return false;
}

/**
 * True when a command both names an evidence folder and writes: an output redirection, or a file-changing command
 * or interpreter. Reading stays allowed (`cat`, `grep`, `ls`, `2>&1`). With `cwd` (where the command starts),
 * relative words resolve against it.
 */
export function bashWritesEvidence(command: string, home: string, userHome: string = homedir(), cwd?: string): boolean {
	if (!command.includes("evidence") && !(cwd !== undefined && cwd.includes("evidence"))) return false;
	const text = blankHeredocs(command);
	const named =
		homeForms(home, userHome).some((form) => new RegExp(`${escapeRegExp(form)}[^\\s'"]*/evidence(?![\\w-])`).test(command)) ||
		/\.brigadev\/[^\s'"]*\/?evidence(?![\w-])/.test(command);
	if (!named && !(cwd !== undefined && reachesEvidenceFromCwd(text, home, cwd))) return false;
	// File-descriptor duplication (`2>&1`) and `/dev/null` are not writes to a file.
	const redirected = text.replace(/\d*>&[\d-]*/g, " ").replace(/\d*>>?\s*\/dev\/null/g, " ");
	if (/&?>/.test(redirected)) return true;
	return tokenize(text).some((segment) => segment.argv.some((word) => WRITE_COMMANDS.has(executableName(word))));
}
