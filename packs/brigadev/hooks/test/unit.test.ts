// Unit tests for the pure logic vendored from brigadev (command classification, exit-code rules, commit
// recognition, prose-only rule, tree key, anti-forge rule).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// git-backed cases can exceed bun's 5 s default on a loaded machine.
setDefaultTimeout(60_000);
import { bashWritesEvidence, EVIDENCE_BLOCK, isEvidencePath, pathsOf } from "../lib/guard.ts";
import { brigadevHome, repoName } from "../lib/home.ts";
import {
	buildRunRecord,
	checkKind,
	checkOutcome,
	decideCommitGate,
	exitCodeOf,
	isSourcePath,
	outputTail,
	pendingKey,
	responseText,
	settleRunTree,
	type RunRecord,
} from "../lib/evidence.ts";
import { commitMatches } from "../lib/shell.ts";
import { worktreeTreeResult } from "../lib/tree.ts";

describe("checkKind", () => {
	test("recognizes test runners, including bun test", () => {
		for (const c of ["npm test", "npm run test:unit", "bun test", "bun test ./packs", "bun run test", "CI=1 npx vitest", "pytest -q", "go test ./...", "cargo test", "node --test", "make test", "python -m pytest", "pnpm exec vitest"]) {
			expect(checkKind(c)).toBe("test");
		}
	});
	test("recognizes other checks as check", () => {
		for (const c of ["npm run lint", "tsc --noEmit", "eslint .", "cargo build", "npm run build"]) expect(checkKind(c)).toBe("check");
	});
	test("naming a runner as an argument is not a run", () => {
		for (const c of ["echo npm test", 'grep -n "node --test" package.json', "git status", "ls", "bun install", "bun run dev"]) expect(checkKind(c)).toBeUndefined();
	});
});

describe("checkOutcome (exit-code and chaining rules)", () => {
	test("plain runs and && chains carry the exit code", () => {
		expect(checkOutcome("npm test", 0)).toBe("pass");
		expect(checkOutcome("npm test", 1)).toBe("fail");
		expect(checkOutcome("bun test", 0)).toBe("pass");
		expect(checkOutcome("bun test", 1)).toBe("fail");
		expect(checkOutcome("npm run build && npm test", 0)).toBe("pass");
		expect(checkOutcome("bun test --timeout 60000 ./packs/brigadev/hooks", 0)).toBe("pass");
		expect(checkOutcome("CI=1 bun test", 0)).toBe("pass");
	});
	test("an unknown exit code never passes", () => {
		expect(checkOutcome("npm test", undefined)).toBe("unknown");
	});
	test("anything that hands the exit code to something else is unknown", () => {
		for (const c of ["echo npm test", "true # npm test", "! npm test", "true || npm test", "exit 0 && npm test", "npm test; echo done", "npm test || true", "npm test | tee log", "npm test &", "(npm test)", "echo $(npm test)", "echo `npm test`", "exec true && npm test", "echo pipefail; npm test | cat"]) {
			expect(checkOutcome(c, 0)).toBe("unknown");
		}
	});
	test("a leading set -o pipefail lets a pipe follow", () => {
		expect(checkOutcome("set -o pipefail; npm test | tee log", 0)).toBe("pass");
	});
	test("help, version and listing flags run no tests", () => {
		for (const c of ["bun test --help", "bun test -v", "npm test --help", "npm test -- --help", "node --test --help", "pytest --collect-only", "bun test --dry-run"]) {
			expect(checkOutcome(c, 0)).toBe("unknown");
		}
	});
	test("a package-manager run with options or npm_config_* is not trusted", () => {
		expect(checkOutcome("npm test --workspace=a", 0)).toBe("unknown");
		expect(checkOutcome("npm_config_usage=true npm test", 0)).toBe("unknown");
		expect(checkOutcome("export npm_config_usage=true && npm test", 0)).toBe("unknown");
	});
	test("a cd before the test must stay inside the repository", () => {
		const top = realpathSync(tmpdir());
		expect(checkOutcome("cd /elsewhere && npm test", 0, { cwd: top, topLevel: top })).toBe("unknown");
		expect(checkOutcome("cd sub && npm test", 0, { cwd: top, topLevel: top })).toBe("pass");
	});
});

describe("commit recognition", () => {
	test("plain commits are commits", () => {
		for (const c of ["git commit -m x", "git commit --amend", "git add . && git commit -m x", "sh -c 'git commit -m x'", "git -c user.name=a commit -m x", "FOO=1 git commit -m x", "sudo git commit -m x"]) {
			expect(commitMatches(c).length).toBeGreaterThan(0);
		}
	});
	test("other uses of the words are not commits", () => {
		for (const c of ["git status", 'echo "git commit"', 'grep "git commit" README.md', "git log --oneline", "git commit-tree abc", "ls"]) {
			expect(commitMatches(c)).toEqual([]);
		}
	});
	test("a commit after a cd, branch switch, -C or location variable is elsewhere", () => {
		for (const c of ["cd other && git commit -m x", "git checkout b && git commit -m x", "git -C ../x commit -m x", "GIT_DIR=/x git commit -m x", "git --work-tree=/x commit -m x"]) {
			const matches = commitMatches(c);
			expect(matches.length).toBeGreaterThan(0);
			expect(matches.every((m) => m.elsewhere === true)).toBe(true);
		}
	});
	test("git add / stash before the commit stay in place", () => {
		expect(commitMatches("git add -A && git commit -m x")[0]?.elsewhere).toBeFalsy();
	});
});

describe("prose-only rule", () => {
	test("prose and legal files are not source", () => {
		for (const p of ["README.md", "docs/a.markdown", "docs/x.rst", "docs/y.ADOC", "LICENSE", "sub/NOTICE", "COPYING", "AUTHORS"]) expect(isSourcePath(p)).toBe(false);
	});
	test("everything else, including .txt and .mdx, is source", () => {
		for (const p of ["src/a.ts", "requirements.txt", "CMakeLists.txt", "page.mdx", "LICENSE.ts", "Makefile", "(unknown)"]) expect(isSourcePath(p)).toBe(true);
	});
});

describe("decideCommitGate", () => {
	const run = (over: Partial<RunRecord>): RunRecord => ({ v: 1, type: "run", ts: "t", branch: "b", tree: "T1", cwd: "/r", agent: "parent", command: "npm test", kind: "test", exitCode: 0, outcome: "pass", tail: "", ...over });
	const base = { dirtyPaths: ["src/a.ts"], tree: "T1", elsewhere: false, records: [] as RunRecord[] };
	test("no git tree: allow", () => {
		expect(decideCommitGate({ ...base, tree: undefined }).action).toBe("allow");
	});
	test("a tree that cannot be computed blocks, fail closed", () => {
		const d = decideCommitGate({ ...base, tree: undefined, treeError: "timed out after 10s" });
		expect(d.action).toBe("block");
		expect(d.action === "block" && d.reason).toContain("timed out after 10s");
	});
	test("docs-only changes pass, source changes need a passing test on this tree", () => {
		expect(decideCommitGate({ ...base, dirtyPaths: ["README.md", "docs/a.rst"] }).action).toBe("allow");
		expect(decideCommitGate(base).action).toBe("block");
		expect(decideCommitGate({ ...base, records: [run({})] }).action).toBe("allow");
	});
	test("a passing run on another tree, a failed run, an unknown run and a lint pass do not count", () => {
		for (const r of [run({ tree: "T0" }), run({ outcome: "fail", exitCode: 1 }), run({ outcome: "unknown", exitCode: undefined }), run({ kind: "check" })]) {
			expect(decideCommitGate({ ...base, records: [r] }).action).toBe("block");
		}
	});
	test("a commit elsewhere is blocked", () => {
		expect(decideCommitGate({ ...base, elsewhere: true, records: [run({})] }).action).toBe("block");
	});
	test("the reason says how to proceed and names the pack hook bypass", () => {
		const d = decideCommitGate(base);
		expect(d.action === "block" && d.reason).toContain("Blocked by brigadev evidence gate");
	});
});

describe("exit codes from the hook payloads", () => {
	test("PostToolUse means exit 0", () => {
		expect(exitCodeOf({ mode: "post", payload: { tool_response: { content: [{ type: "text", text: "ok" }], is_error: false } } })).toBe(0);
	});
	test("pi failure: the code is anchored at the end of the error text", () => {
		expect(exitCodeOf({ mode: "post-failure", payload: { error: "1 fail\n\nCommand exited with code 1" } })).toBe(1);
		expect(exitCodeOf({ mode: "post-failure", payload: { error: "Command exited with code 0\nmore output\n\nCommand exited with code 2" } })).toBe(2);
		expect(exitCodeOf({ mode: "post-failure", payload: { error: "Command exited with code 1\nand then output" } })).toBeUndefined();
	});
	test("Claude failure (tool_use_id present): the code is anchored at the start", () => {
		expect(exitCodeOf({ mode: "post-failure", payload: { tool_use_id: "toolu_1", error: "Exit code 3\nfail output" } })).toBe(3);
		expect(exitCodeOf({ mode: "post-failure", payload: { tool_use_id: "toolu_1", error: "output\nExit code 0\n" } })).toBeUndefined();
		// pi's end-anchored form is not trusted on Claude, where the command's output could print it.
		expect(exitCodeOf({ mode: "post-failure", payload: { tool_use_id: "toolu_1", error: "x\n\nCommand exited with code 0" } })).toBeUndefined();
	});
	test("pi does not trust a start-anchored form", () => {
		expect(exitCodeOf({ mode: "post-failure", payload: { error: "Exit code 0\nfoo" } })).toBeUndefined();
	});
	test("timeouts, aborts, unparseable text and code 0 in a failure are unknown", () => {
		for (const error of ["Command timed out after 30 seconds", "Command aborted", "", "weird", "x\n\nCommand exited with code 0"]) {
			expect(exitCodeOf({ mode: "post-failure", payload: { error } })).toBeUndefined();
		}
		expect(exitCodeOf({ mode: "post-failure", payload: {} })).toBeUndefined();
		expect(exitCodeOf({ mode: "post-failure", payload: { is_interrupt: true, error: "x\n\nCommand exited with code 1" } })).toBeUndefined();
	});
	test("an interrupted Claude PostToolUse is unknown", () => {
		expect(exitCodeOf({ mode: "post", payload: { tool_response: { stdout: "", stderr: "", interrupted: true } } })).toBeUndefined();
	});
});

describe("responseText", () => {
	test("reads pi content, Claude stdout/stderr, and strings", () => {
		expect(responseText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
		expect(responseText({ stdout: "out", stderr: "err" })).toBe("out\nerr");
		expect(responseText("plain")).toBe("plain");
		expect(responseText(undefined)).toBe("");
	});
});

describe("records", () => {
	test("keep brigadev field names and cap the tail", () => {
		const r = buildRunRecord({ ts: "2026-01-01T00:00:00.000Z", branch: "main", tree: "T", cwd: "/r", agent: "parent", command: "npm test", exitCode: 0, output: `${"x\n".repeat(100)}done`, topLevel: "/r" });
		expect(Object.keys(r).sort()).toEqual(["agent", "branch", "command", "cwd", "exitCode", "kind", "outcome", "tail", "tree", "ts", "type", "v"].sort());
		expect(r.outcome).toBe("pass");
		expect(r.tail.split("\n").length).toBeLessThanOrEqual(20);
		expect(outputTail("a\nb\n")).toBe("a\nb");
	});
	test("a note makes the run unknown", () => {
		const r = buildRunRecord({ ts: "t", branch: null, cwd: "/r", agent: "parent", command: "npm test", exitCode: 0, output: "", note: "tree changed during run" });
		expect(r.outcome).toBe("unknown");
		expect(r.note).toBe("tree changed during run");
	});
});

describe("tree key", () => {
	test("settleRunTree keys a run only to a tree that did not change", () => {
		expect(settleRunTree("A", "A")).toEqual({ record: true, tree: "A" });
		expect(settleRunTree("A", "B")).toEqual({ record: true, tree: undefined, note: "tree changed during run" });
		expect(settleRunTree(undefined, "B")).toEqual({ record: true, tree: undefined, note: "tree before the run is unknown" });
		expect(settleRunTree("A", undefined)).toEqual({ record: false });
	});
	test("pendingKey is stable and depends on session, cwd, command and tool_use_id", () => {
		const k = pendingKey({ session_id: "s", cwd: "/r", tool_input: { command: "npm test" } });
		expect(k).toMatch(/^[0-9a-f]{40,64}$/);
		expect(pendingKey({ session_id: "s", cwd: "/r", tool_input: { command: "npm test" } })).toBe(k);
		expect(pendingKey({ session_id: "s2", cwd: "/r", tool_input: { command: "npm test" } })).not.toBe(k);
		expect(pendingKey({ session_id: "s", cwd: "/r2", tool_input: { command: "npm test" } })).not.toBe(k);
		expect(pendingKey({ session_id: "s", cwd: "/r", tool_input: { command: "npm run test" } })).not.toBe(k);
		// With a tool_use_id (Claude) the call is the key, so a cd inside the command cannot change it.
		const a = pendingKey({ session_id: "s", cwd: "/r", tool_use_id: "t1", tool_input: { command: "npm test" } });
		expect(pendingKey({ session_id: "s", cwd: "/r/sub", tool_use_id: "t1", tool_input: { command: "npm test" } })).toBe(a);
		expect(pendingKey({ session_id: "s", cwd: "/r", tool_use_id: "t2", tool_input: { command: "npm test" } })).not.toBe(a);
	});
});

describe("worktreeTreeResult", () => {
	let dir: string;
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	beforeAll(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "bg-tree-")));
		git("init", "-q");
		git("config", "user.email", "t@t");
		git("config", "user.name", "t");
		writeFileSync(join(dir, "a.ts"), "1");
		git("add", ".");
		git("commit", "-qm", "init");
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("same content, same tree; an edit or a new file changes it; a commit does not", async () => {
		const t0 = await worktreeTreeResult(dir);
		expect(t0.kind).toBe("tree");
		expect(await worktreeTreeResult(dir)).toEqual(t0);
		writeFileSync(join(dir, "a.ts"), "2");
		const t1 = await worktreeTreeResult(dir);
		expect(t1).not.toEqual(t0);
		writeFileSync(join(dir, "b.ts"), "x");
		const t2 = await worktreeTreeResult(dir);
		expect(t2).not.toEqual(t1);
		git("add", "-A");
		git("commit", "-qm", "two");
		expect(await worktreeTreeResult(dir)).toEqual(t2);
	});
	test("outside git is no-git; a missing directory is an error", async () => {
		const out = realpathSync(mkdtempSync(join(tmpdir(), "bg-nogit-")));
		try {
			expect(await worktreeTreeResult(out)).toEqual({ kind: "no-git" });
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
		expect((await worktreeTreeResult(join(out, "missing"))).kind).toBe("error");
	});
});

describe("evidence repo folder", () => {
	test("BRIGADEV_HOME overrides ~/.brigadev", () => {
		expect(brigadevHome({ BRIGADEV_HOME: "/x/y" })).toBe("/x/y");
		expect(brigadevHome({}).endsWith("/.brigadev")).toBe(true);
	});
	test("repo is the basename of the main worktree root, shared by worktrees", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "bg-repo-")));
		try {
			const main = join(root, "myrepo");
			mkdirSync(main);
			const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
			git(main, "init", "-q");
			git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i");
			git(main, "worktree", "add", "-q", join(root, "wt"), "-b", "other");
			expect(repoName(main)).toBe("myrepo");
			expect(repoName(join(root, "wt"))).toBe("myrepo");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("anti-forge rule", () => {
	const home = "/h/.brigadev";
	test("a path inside any repo's evidence folder is evidence", () => {
		expect(isEvidencePath(home, "/h/.brigadev/repo/evidence/main.jsonl")).toBe(true);
		expect(isEvidencePath(home, "/h/.brigadev/other/evidence/.pending/x.json")).toBe(true);
		expect(isEvidencePath(home, "/h/.brigadev/repo/evidence")).toBe(true);
		expect(isEvidencePath(home, "/h/.brigadev/repo/tasks/evidence.md")).toBe(false);
		expect(isEvidencePath(home, "/h/project/evidence/a.ts")).toBe(false);
	});
	test("bash writes to the evidence folder are caught, reads are not", () => {
		for (const c of [`echo x >> ${home}/repo/evidence/b.jsonl`, `echo x >> ~/.brigadev/repo/evidence/b.jsonl`, `tee $HOME/.brigadev/repo/evidence/b.jsonl`, `rm -rf ${home}/repo/evidence`, `cp /tmp/f ${home}/repo/evidence/b.jsonl`, `sed -i s/1/0/ ~/.brigadev/repo/evidence/b.jsonl`, `python3 -c "x" ~/.brigadev/repo/evidence/b.jsonl`]) {
			expect(bashWritesEvidence(c, home, "/h")).toBe(true);
		}
		for (const c of [`cat ${home}/repo/evidence/b.jsonl`, `grep fail ~/.brigadev/repo/evidence/b.jsonl | tail -3`, `ls -la ~/.brigadev/repo/evidence`, `jq . ${home}/repo/evidence/b.jsonl 2>&1`, "echo x > /tmp/a", `echo evidence > ${home}/repo/tasks/a.md`]) {
			expect(bashWritesEvidence(c, home, "/h")).toBe(false);
		}
	});
	test("a relative write from inside the evidence folder is caught when the cwd is known", () => {
		expect(bashWritesEvidence("echo x >> b.jsonl", home, "/h", `${home}/repo/evidence`)).toBe(true);
		expect(bashWritesEvidence("echo x >> ../evidence/f.jsonl", home, "/h", `${home}/repo/tasks`)).toBe(true);
		expect(bashWritesEvidence("cat b.jsonl", home, "/h", `${home}/repo/evidence`)).toBe(false);
		expect(bashWritesEvidence("echo x >> b.jsonl", home, "/h", "/work/project")).toBe(false);
	});
	test("pathsOf reads file_path, path and notebook_path", () => {
		expect(pathsOf({ file_path: "/a" })).toEqual(["/a"]);
		expect(pathsOf({ path: "/b" })).toEqual(["/b"]);
		expect(pathsOf({ notebook_path: "/c" })).toEqual(["/c"]);
		expect(pathsOf({ file_path: "/a", path: "/a" })).toEqual(["/a"]);
		expect(pathsOf(undefined)).toEqual([]);
	});
	test("the block message is stable", () => {
		expect(EVIDENCE_BLOCK).toContain("evidence log is written only by the recorder");
	});
});
