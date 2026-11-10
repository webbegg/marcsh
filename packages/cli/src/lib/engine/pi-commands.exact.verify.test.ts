import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, InMemoryCredentialStore, type Message } from "@earendil-works/pi-ai";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";

let dir: string, agentDir: string, cwd: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "marcsh-pi-plugin-exact-")); agentDir = join(dir, "agent"); cwd = join(dir, "project"); mkdirSync(cwd, { recursive: true }); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
// Bun caches os.homedir(), so this is usually the user's real HOME: the `~/.agents` clash case only runs when HOME is
// a temp dir and has no `.agents` yet, and only then is the directory it created removed again.
const homeAgents = join(homedir(), ".agents");
const canUseHomeAgents = homedir().startsWith(tmpdir()) && !existsSync(homeAgents);
const userTexts = (messages: Message[]) => messages.flatMap((m: any) => (m.role === "user" ? [typeof m.content === "string" ? m.content : m.content.map((b: any) => b.text ?? "").join("")] : []));

async function send(prompt: string) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  let seen = [] as string[]; let calls = 0;
  faux.setResponses([(c: any) => ((calls++, seen = userTexts(c.messages)), fauxAssistantMessage([fauxText("ok")]))]);
  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:") });
  const errs: any[] = [];
  const turn = engine.startTurn({ prompt, cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: new AbortController().signal }, { emit(e: any) { if (e.type === "error") errs.push(e); }, askPermission: async () => "deny", askQuestions: async () => null });
  await turn.done;
  return { seen: seen as string[], calls, errs };
}

const ARGS = [
  "", "fix the login bug", "  spaced   out  ", `"quoted arg" 'two' x`, "$1 $@ $ARGUMENTS ${@:2} /skill:workflow", "line1\nline2", "/feature nested", `""`,
];

function clash(where: string) {
  const skillRoot = where === "agentDir" ? join(agentDir, "skills") : where === "home .agents" ? join(homedir(), ".agents", "skills") : where === "project .pi" ? join(cwd, ".pi", "skills") : where === "project .agents" ? join(cwd, ".agents", "skills") : null;
  const promptRoot = where === "agentDir" ? join(agentDir, "prompts") : where === "project .pi" ? join(cwd, ".pi", "prompts") : null;
  if (skillRoot) { mkdirSync(join(skillRoot, "workflow"), { recursive: true }); writeFileSync(join(skillRoot, "workflow", "SKILL.md"), "---\nname: workflow\ndescription: my own workflow\n---\nUSER WORKFLOW BODY $1\n"); }
  if (promptRoot) { mkdirSync(promptRoot, { recursive: true }); writeFileSync(join(promptRoot, "feature.md"), "---\ndescription: mine\n---\nUSER TEMPLATE $1 $ARGUMENTS"); }
  return { skillRoot, promptRoot };
}

test("reference vs clash, exact equality", async () => {
  // reference: pi's own expansion of the plugin's resources, no clash
  const ref: Record<string, string> = {};
  for (const a of ARGS) {
    for (const [mine, pis] of [["/marcsh:workflow", "/skill:workflow"], ["/marcsh:feature", "/feature"]] as const) {
      const typed = a ? `${pis} ${a}` : pis;
      const r = await send(typed);
      ref[`${mine}|${a}`] = r.seen![0]!;
      expect(r.seen!.length).toBe(1);
      const m = await send(a ? `${mine} ${a}` : mine);
      expect(m.calls).toBe(1);
      expect(m.seen!.length).toBe(1);
      if (m.seen![0] !== ref[`${mine}|${a}`]!) console.log("NOCLASH DIFF", mine, JSON.stringify(a), "\nREF:", JSON.stringify(ref[`${mine}|${a}`]!.slice(0, 300)), "\nGOT:", JSON.stringify(m.seen![0]!.slice(0, 300)));
      expect(m.seen![0]).toBe(ref[`${mine}|${a}`]!);
    }
  }
  for (const where of ["agentDir", ...(canUseHomeAgents ? ["home .agents"] : []), "project .pi", "project .agents"]) {
    const { skillRoot, promptRoot } = clash(where);
    for (const a of ARGS) {
      for (const mine of ["/marcsh:workflow", "/marcsh:feature"]) {
        const m = await send(a ? `${mine} ${a}` : mine);
        const ok = m.seen![0] === ref[`${mine}|${a}`];
        if (!ok) console.log("CLASH DIFF", where, mine, JSON.stringify(a), JSON.stringify(m.seen![0]!.slice(0, 200)));
        expect(m.seen![0]).toBe(ref[`${mine}|${a}`]!);
        expect(m.seen!.length).toBe(1);
      }
    }
    if (skillRoot) {
      const u = await send("/skill:workflow hello");
      console.log(where, "user /skill:workflow ->", JSON.stringify(u.seen![0]!.slice(0, 60)), u.seen![0]!.includes("USER WORKFLOW BODY") && u.seen![0]!.endsWith("hello"));
      expect(u.seen![0]).toContain("USER WORKFLOW BODY");
    }
    if (promptRoot) {
      const u = await send("/feature hello world");
      console.log(where, "user /feature ->", JSON.stringify(u.seen![0]));
      expect(u.seen![0]).toBe("USER TEMPLATE hello hello world");
    }
    rmSync(join(agentDir), { recursive: true, force: true }); rmSync(join(cwd, ".pi"), { recursive: true, force: true }); rmSync(join(cwd, ".agents"), { recursive: true, force: true });
    if (where === "home .agents") rmSync(homeAgents, { recursive: true, force: true });
  }
}, 600000);

test("other forms: unknown, bare, mid-text, leading space and wrong case go to pi as typed; whitespace separators expand", async () => {
  for (const p of ["/marcsh:nope x", "/marcsh:", " /marcsh:feature x", "please /marcsh:feature x", "/marcsh:Feature x"]) {
    const r = await send(p);
    expect(r.seen).toEqual([p]);
  }
  for (const p of ["/marcsh:workflow\targs", "/marcsh:feature\nmulti"]) {
    const r = await send(p);
    expect(r.seen!.length).toBe(1);
    expect(r.seen![0]!.startsWith("/marcsh:")).toBe(false);
  }
}, 120000);
