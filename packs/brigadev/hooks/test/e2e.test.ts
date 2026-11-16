// End-to-end: spawn `bun hooks/evidence.ts <mode>` with a JSON payload on stdin, the way marcsh does,
// against a throwaway git repository, with BRIGADEV_HOME in a temp directory.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Every case spawns several hook processes, each running git.
setDefaultTimeout(60_000);

const SCRIPT = join(import.meta.dir, "..", "evidence.ts");

let scratch: string;
let home: string;
let repo: string;
let evidenceDir: string;

const cleanEnv = () => {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
	return env;
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });

interface Result {
	code: number | null;
	stdout: string;
	stderr: string;
}
function hook(mode: "pre" | "post" | "post-failure", payload: unknown, extraEnv: Record<string, string> = {}, raw?: string): Result {
	const r = spawnSync("bun", [SCRIPT, mode], {
		input: raw ?? JSON.stringify(payload),
		encoding: "utf8",
		env: { ...cleanEnv(), BRIGADEV_HOME: home, MARCSH_AGENT: "acme/test", ...extraEnv },
		timeout: 60_000,
	});
	return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// pi payloads carry no tool_use_id; Claude's do.
const piBash = (command: string, cwd = repo, extra: object = {}) => ({ session_id: "s1", cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, permission_mode: "normal", agent: "acme/test", ...extra });
const piPost = (command: string, cwd = repo) => ({ ...piBash(command, cwd), hook_event_name: "PostToolUse", tool_response: { content: [{ type: "text", text: "3 pass\n0 fail" }], is_error: false } });
const piFail = (command: string, code: number, cwd = repo) => ({ ...piBash(command, cwd), hook_event_name: "PostToolUseFailure", error: `1 fail\n\nCommand exited with code ${code}`, is_interrupt: false });

const records = (): any[] => {
	const dir = evidenceDir;
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
};
const pendingFiles = () => (existsSync(join(evidenceDir, ".pending")) ? readdirSync(join(evidenceDir, ".pending")) : []);

/** Runs a test command through the hooks like the engine does and returns the final record. */
function runTest(command = "npm test", { fail = 0 }: { fail?: number } = {}) {
	expect(hook("pre", piBash(command)).code).toBe(0);
	const r = fail ? hook("post-failure", piFail(command, fail)) : hook("post", piPost(command));
	expect(r.code).toBe(0);
}

beforeAll(() => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "bg-e2e-")));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

beforeEach(() => {
	rmSync(join(scratch, "home"), { recursive: true, force: true });
	rmSync(join(scratch, "myrepo"), { recursive: true, force: true });
	home = join(scratch, "home");
	repo = join(scratch, "myrepo");
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@t");
	git(repo, "config", "user.name", "t");
	writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
	writeFileSync(join(repo, "README.md"), "# r\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "init");
	evidenceDir = join(home, "myrepo", "evidence");
});

describe("PostToolUse / PostToolUseFailure record test runs", () => {
	test("a passing test run is recorded with brigadev's fields", () => {
		const out = hook("pre", piBash("npm test"));
		expect(out.code).toBe(0);
		expect(pendingFiles().length).toBe(1);
		const post = hook("post", piPost("npm test"));
		expect(post.code).toBe(0);
		expect(pendingFiles()).toEqual([]);
		const recs = records();
		expect(recs.length).toBe(1);
		const r = recs[0];
		expect(r).toMatchObject({ v: 1, type: "run", branch: "main", cwd: repo, agent: "acme/test", command: "npm test", kind: "test", exitCode: 0, outcome: "pass" });
		expect(r.tree).toMatch(/^[0-9a-f]{40,64}$/);
		expect(r.tail).toContain("3 pass");
		expect(typeof r.ts).toBe("string");
		expect(existsSync(join(evidenceDir, "main.jsonl"))).toBe(true);
	});

	test("the evidence file is 0600 and its folder 0700", () => {
		runTest();
		expect(statSync(join(evidenceDir, "main.jsonl")).mode & 0o777).toBe(0o600);
		expect(statSync(evidenceDir).mode & 0o777).toBe(0o700);
	});

	test("bun test is recognized", () => {
		runTest("bun test");
		expect(records()[0]).toMatchObject({ command: "bun test", kind: "test", outcome: "pass" });
	});

	test("pi failure: the exit code comes from the end of the error text", () => {
		runTest("npm test", { fail: 1 });
		expect(records()[0]).toMatchObject({ exitCode: 1, outcome: "fail" });
		expect(records()[0].tail).toContain("Command exited with code 1");
	});

	test("Claude failure: Exit code N at the start of the error, tool_use_id keys the pending tree", () => {
		const base = { session_id: "c1", cwd: repo, tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "toolu_1", permission_mode: "default" };
		expect(hook("pre", { ...base, hook_event_name: "PreToolUse" }).code).toBe(0);
		expect(hook("post-failure", { ...base, hook_event_name: "PostToolUseFailure", error: "Exit code 2\nboom", is_interrupt: false }).code).toBe(0);
		expect(records()[0]).toMatchObject({ exitCode: 2, outcome: "fail" });
	});

	test("Claude success shape (stdout/stderr) is a pass", () => {
		const base = { session_id: "c1", cwd: repo, tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "toolu_2" };
		hook("pre", { ...base, hook_event_name: "PreToolUse" });
		hook("post", { ...base, hook_event_name: "PostToolUse", tool_response: { stdout: "ok", stderr: "", interrupted: false } });
		expect(records()[0]).toMatchObject({ exitCode: 0, outcome: "pass" });
	});

	test("an unparseable failure (timeout) is unknown and never passes", () => {
		hook("pre", piBash("npm test"));
		hook("post-failure", { ...piBash("npm test"), error: "Command timed out after 30 seconds" });
		expect(records()[0]).toMatchObject({ outcome: "unknown" });
		expect(records()[0].exitCode).toBeUndefined();
	});

	test("without the tree before the run, the record is unknown with a note", () => {
		const r = hook("post", piPost("npm test"));
		expect(r.code).toBe(0);
		expect(records()[0]).toMatchObject({ outcome: "unknown", note: "tree before the run is unknown" });
		expect(records()[0].tree).toBeUndefined();
	});

	test("a tree edited during the run is unknown with a note", () => {
		hook("pre", piBash("npm test"));
		writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
		hook("post", piPost("npm test"));
		expect(records()[0]).toMatchObject({ outcome: "unknown", note: "tree changed during run" });
	});

	test("commands that are not checks are not recorded, and leave no pending file", () => {
		expect(hook("pre", piBash("ls -la")).code).toBe(0);
		expect(pendingFiles()).toEqual([]);
		expect(hook("post", piPost("ls -la")).code).toBe(0);
		expect(existsSync(home)).toBe(false);
	});

	test("naming a test as an argument, or chaining it away, is not a pass", () => {
		runTest("echo npm test");
		expect(records()).toEqual([]);
		runTest("npm test || true");
		expect(records()[0]).toMatchObject({ outcome: "unknown" });
	});

	test("a started background process is not a run", () => {
		hook("pre", piBash("npm test"));
		const r = hook("post", { ...piBash("npm test"), tool_response: { content: [{ type: "text", text: 'Started background terminal bt-1 "x" (pid 1)' }], is_error: false } });
		expect(r.code).toBe(0);
		expect(records()).toEqual([]);
		hook("pre", { session_id: "c", cwd: repo, tool_name: "Bash", tool_input: { command: "npm test", run_in_background: true }, tool_use_id: "t9" });
		hook("post", { session_id: "c", cwd: repo, tool_name: "Bash", tool_input: { command: "npm test", run_in_background: true }, tool_use_id: "t9", tool_response: { stdout: "", stderr: "", interrupted: false } });
		expect(records()).toEqual([]);
	});

	test("outside git nothing is recorded", () => {
		const plain = join(scratch, "plain");
		mkdirSync(plain, { recursive: true });
		hook("pre", piBash("npm test", plain));
		expect(hook("post", piPost("npm test", plain)).code).toBe(0);
		expect(existsSync(home)).toBe(false);
	});

	test("detached HEAD records under detached.jsonl", () => {
		git(repo, "checkout", "-q", "--detach");
		runTest();
		expect(existsSync(join(evidenceDir, "detached.jsonl"))).toBe(true);
	});

	test("a malformed payload never fails a post hook", () => {
		expect(hook("post", undefined, {}, "not json").code).toBe(0);
		expect(hook("post-failure", undefined, {}, "").code).toBe(0);
	});
});

describe("PreToolUse blocks git commit without a passing run on the current tree", () => {
	const commit = (command = "git commit -am x", cwd = repo) => hook("pre", piBash(command, cwd));

	test("source changes with no run: blocked (exit 2) with a clear reason", () => {
		writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
		const r = commit();
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("Blocked by brigadev evidence gate");
		expect(r.stderr).toContain("no passing test is recorded");
	});

	test("a passing run on this tree lets the commit through; an edit blocks it again", () => {
		writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
		runTest();
		expect(commit().code).toBe(0);
		writeFileSync(join(repo, "a.ts"), "export const a = 3;\n");
		expect(commit().code).toBe(2);
		runTest();
		expect(commit().code).toBe(0);
	});

	test("committing part of the tree does not change the tree key", () => {
		writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
		writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
		runTest();
		git(repo, "add", "a.ts");
		git(repo, "commit", "-qm", "part");
		expect(commit().code).toBe(0);
	});

	test("a failing or unknown run does not unlock the commit", () => {
		writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
		runTest("npm test", { fail: 1 });
		const r = commit();
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("failed");
		hook("post", piPost("npm test")); // no pending: unknown with a note
		expect(commit().code).toBe(2);
	});

	test("a lint pass does not count", () => {
		writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
		runTest("npm run lint");
		expect(records()[0].kind).toBe("check");
		expect(commit().code).toBe(2);
	});

	test("prose-only changes pass without a test run", () => {
		writeFileSync(join(repo, "README.md"), "# changed\n");
		writeFileSync(join(repo, "NOTES.rst"), "notes\n");
		writeFileSync(join(repo, "LICENSE"), "MIT\n");
		expect(commit().code).toBe(0);
		writeFileSync(join(repo, "requirements.txt"), "x\n");
		expect(commit().code).toBe(2);
	});

	test("unrecognised or non-commit commands are allowed", () => {
		writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
		for (const c of ["git status", 'echo "git commit"', "git add -A", "git commit-tree HEAD^{tree}"]) expect(commit(c).code).toBe(0);
	});

	test("a commit that runs elsewhere cannot be checked and is blocked", () => {
		writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
		runTest();
		expect(commit("cd .. && git commit -am x").code).toBe(2);
		expect(commit("git -C /tmp commit -am x").code).toBe(2);
	});

	test("outside git a commit is allowed", () => {
		const plain = join(scratch, "plain2");
		mkdirSync(plain, { recursive: true });
		expect(hook("pre", piBash("git commit -m x", plain)).code).toBe(0);
	});

	test("fails closed when the tree cannot be computed (corrupt index)", () => {
		writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
		writeFileSync(join(repo, ".git", "index"), "garbage garbage garbage");
		const r = commit();
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("could not be computed");
	});

	test("fails closed when the working directory is missing", () => {
		const r = commit("git commit -m x", join(scratch, "gone"));
		expect(r.code).toBe(2);
	});

	test("a crashing hook blocks a commit-looking command and lets others through", () => {
		// Garbage on stdin: nothing can be parsed, so the raw text decides.
		expect(hook("pre", undefined, {}, '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"').code).toBe(2);
		expect(hook("pre", undefined, {}, "garbage").code).toBe(0);
		// A payload that parses but cannot be handled (tool_input is not an object).
		expect(hook("pre", { tool_name: "Bash", cwd: repo, tool_input: "git commit -m x" }).code).toBe(2);
	});

	test("works for the Claude payload shape too", () => {
		writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
		const p = { session_id: "c", cwd: repo, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -am x" }, tool_use_id: "toolu_9", permission_mode: "default" };
		expect(hook("pre", p).code).toBe(2);
	});
});

describe("PreToolUse anti-forge: nobody writes the evidence folder", () => {
	test("Edit and Write into the evidence folder are blocked", () => {
		runTest();
		const file = join(evidenceDir, "main.jsonl");
		for (const tool of ["Edit", "Write", "MultiEdit"]) {
			const r = hook("pre", { session_id: "s", cwd: repo, tool_name: tool, tool_input: { file_path: file, content: "x" } });
			expect(r.code).toBe(2);
			expect(r.stderr).toContain("evidence log is written only by the recorder");
		}
		// pi also gives `path`; a relative path resolves against cwd; another repo's evidence counts too.
		expect(hook("pre", { session_id: "s", cwd: repo, tool_name: "Write", tool_input: { path: file } }).code).toBe(2);
		expect(hook("pre", { session_id: "s", cwd: evidenceDir, tool_name: "Write", tool_input: { file_path: "main.jsonl" } }).code).toBe(2);
		expect(hook("pre", { session_id: "s", cwd: repo, tool_name: "Write", tool_input: { file_path: join(home, "otherrepo", "evidence", "x.jsonl") } }).code).toBe(2);
		expect(hook("pre", { session_id: "s", cwd: repo, tool_name: "Write", tool_input: { file_path: join(evidenceDir, "..", "evidence", ".pending", "k.json") } }).code).toBe(2);
	});

	test("a symlink into the evidence folder does not hide the write", () => {
		runTest();
		const link = join(scratch, "linkdir");
		execFileSync("ln", ["-s", evidenceDir, link]);
		const r = hook("pre", { session_id: "s", cwd: repo, tool_name: "Write", tool_input: { file_path: join(link, "main.jsonl") } });
		expect(r.code).toBe(2);
		rmSync(link);
	});

	test("ordinary Edit and Write are allowed", () => {
		expect(hook("pre", { session_id: "s", cwd: repo, tool_name: "Write", tool_input: { file_path: join(repo, "a.ts") } }).code).toBe(0);
		expect(hook("pre", { session_id: "s", cwd: repo, tool_name: "Edit", tool_input: { file_path: join(home, "myrepo", "tasks", "t.md") } }).code).toBe(0);
	});

	test("Bash writes that name the evidence folder are blocked; reads are not", () => {
		runTest();
		const file = join(evidenceDir, "main.jsonl");
		for (const c of [`echo '{}' >> ${file}`, `rm -rf ${evidenceDir}`, `cp /tmp/x ${file}`, `sed -i s/fail/pass/ ${file}`]) {
			const r = hook("pre", piBash(c));
			expect(r.code).toBe(2);
			expect(r.stderr).toContain("evidence log is written only by the recorder");
		}
		for (const c of [`cat ${file}`, `grep pass ${file} | tail -1`, `ls ${evidenceDir}`]) expect(hook("pre", piBash(c)).code).toBe(0);
	});

	test("the evidence rule needs no git and applies even outside a repository", () => {
		const plain = join(scratch, "plain3");
		mkdirSync(plain, { recursive: true });
		expect(hook("pre", piBash(`echo x > ${join(evidenceDir, "a.jsonl")}`, plain)).code).toBe(2);
	});

	test("hooks leave the recorded file intact after a blocked forgery", () => {
		runTest();
		const before = readFileSync(join(evidenceDir, "main.jsonl"), "utf8");
		hook("pre", piBash(`echo x >> ${join(evidenceDir, "main.jsonl")}`));
		expect(readFileSync(join(evidenceDir, "main.jsonl"), "utf8")).toBe(before);
	});
});

describe("hooks.json", () => {
	const cfg = JSON.parse(readFileSync(join(dirname(SCRIPT), "hooks.json"), "utf8"));
	test("only the allowed keys, command hooks and explicit timeouts", () => {
		expect(Object.keys(cfg).every((k) => k === "hooks" || k === "description")).toBe(true);
		let commands = 0;
		for (const [event, groups] of Object.entries<any[]>(cfg.hooks)) {
			expect(["PreToolUse", "PostToolUse", "PostToolUseFailure"]).toContain(event);
			for (const g of groups) {
				expect(Object.keys(g).every((k) => k === "matcher" || k === "hooks")).toBe(true);
				expect((g.matcher ?? "").length).toBeLessThanOrEqual(200);
				expect(g.matcher ?? "").toMatch(/^[A-Za-z0-9_.|*-]*$/);
				for (const h of g.hooks) {
					commands++;
					expect(Object.keys(h).sort()).toEqual(["command", "timeout", "type"]);
					expect(h.type).toBe("command");
					expect(h.timeout).toBeGreaterThan(0);
					expect(h.timeout).toBeLessThanOrEqual(600);
					expect(h.command.length).toBeLessThanOrEqual(2000);
					// eslint-disable-next-line no-control-regex
					expect(h.command).not.toMatch(/[\u0000-\u001f\u007f\u00a0\u2028\u2029]/);
					expect(h.command).toMatch(/^bun "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/evidence\.ts" (pre|post|post-failure)$/);
				}
			}
		}
		expect(commands).toBeGreaterThanOrEqual(3);
	});
	test("each mode is wired to the right event and tools", () => {
		const modeOf = (event: string) => cfg.hooks[event].flatMap((g: any) => g.hooks.map((h: any) => `${g.matcher}:${h.command.split(" ").at(-1)}`));
		expect(modeOf("PostToolUse")).toEqual(["Bash:post"]);
		expect(modeOf("PostToolUseFailure")).toEqual(["Bash:post-failure"]);
		const pre = cfg.hooks.PreToolUse.map((g: any) => g.matcher.split("|")).flat();
		for (const tool of ["Bash", "Edit", "Write"]) expect(pre).toContain(tool);
	});
});
