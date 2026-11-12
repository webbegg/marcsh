import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

setDefaultTimeout(300_000);
const work = mkdtempSync(join(tmpdir(), "probe-b1-"));
process.env.MARCSH_DB_PATH = ":memory:";
process.env.MARCSH_PREFERENCES_PATH = join(work, "prefs", "preferences.json");
process.env.MARCSH_AGENTS_DIR = join(work, "agents");
process.env.MARCSH_PACKS_DIR = join(work, "packs");
process.env.MARCSH_PACK_URL_BASE = `file://${join(work, "fixtures")}`;
mock.module("@anthropic-ai/claude-agent-sdk", () => ({ query: () => { throw new Error("no query"); } }));

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("./home");
const { setDefaultEngine } = await import("../lib/preferences");
const { listPacks } = await import("../lib/packs");

const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });

type Fx = { hooks: any; extra?: Record<string, string>; markers: string[] };
const fixtures: Record<string, Fx> = {};
const group = (cmds: string[], matcher = "Bash") => cmds.map((command) => ({ matcher, hooks: [{ type: "command", command }] }));
{
  const t = Array.from({ length: 30 }, (_, i) => `echo THIRTY_${i}_MK`);
  fixtures.thirty = { hooks: { PreToolUse: group(t) }, markers: t.map((_, i) => `THIRTY_${i}_MK`) };
  const s = Array.from({ length: 7 }, (_, i) => `echo SEVEN_${i}_MK`);
  fixtures.seven = { hooks: { PreToolUse: group(s) }, markers: s.map((_, i) => `SEVEN_${i}_MK`) };
  // 100 commands over 10 events, 10 hooks per group
  const h: any = {}; const hm: string[] = [];
  for (let e = 0; e < 10; e++) { h[`Ev${e}`] = [{ matcher: "*", hooks: Array.from({ length: 10 }, (_, k) => { hm.push(`HUN_${e}_${k}_MK`); return { type: "command", command: `echo HUN_${e}_${k}_MK` }; }) }]; }
  fixtures.hundred = { hooks: h, markers: hm };
  // 12 commands of ~1990 chars made of unique words
  const lm: string[] = []; const lc: string[] = [];
  for (let i = 0; i < 12; i++) { const words: string[] = []; let j = 0; let c = "echo"; while (c.length < 1980) { const w = `L${i}w${j++}`; words.push(w); c += " " + w; } lc.push(c); lm.push(...words); }
  fixtures.long = { hooks: { PreToolUse: group(lc) }, markers: lm };
  // a 1990-char command with no spaces at all
  const nospace = "echo " + Array.from({ length: 199 }, (_, i) => `N${String(i).padStart(3, "0")}xxxxx`).join("");
  fixtures.nospace = { hooks: { PreToolUse: group([nospace, "echo NOSP_LAST_MK"]) }, markers: ["NOSP_LAST_MK"] };
  // 7 commands + 400 files
  const extra: Record<string, string> = {}; const fm: string[] = [];
  for (let i = 0; i < 400; i++) { extra[`hooks/f/FILE_${i}_MK.sh`] = "exit 0\n"; fm.push(`FILE_${i}_MK`); }
  fixtures.files = { hooks: { PreToolUse: group(s) }, extra, markers: [...s.map((_, i) => `SEVEN_${i}_MK`), ...fm] };
  // long matcher, 30 events
  const ev: any = {}; const em: string[] = [];
  for (let e = 0; e < 30; e++) { ev[`EventNumber${e}PaddingPaddingPaddingX`] = [{ matcher: Array.from({ length: 22 }, (_, k) => `Tool${k}x`).join("|").slice(0, 200), hooks: [{ type: "command", command: `echo EV_${e}_MK` }] }]; em.push(`EV_${e}_MK`); }
  fixtures.events = { hooks: ev, markers: em };
}

function createFixture(name: string, fx: Fx) {
  const repo = join(work, "fixtures", "acme", name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  const files: Record<string, string> = { "agents/ftd.md": "---\nname: FTD\ndescription: Test first\npermission: build\n---\nx", "hooks/hooks.json": JSON.stringify({ hooks: fx.hooks }), ...(fx.extra ?? {}) };
  for (const [p, t] of Object.entries(files)) { mkdirSync(join(repo, p, ".."), { recursive: true }); writeFileSync(join(repo, p), t); }
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "c");
}
beforeAll(() => { for (const [n, fx] of Object.entries(fixtures)) createFixture(n, fx); });
afterAll(() => rmSync(work, { recursive: true, force: true }));

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const raw = () => screen!.captureCharFrame();
const frame = () => raw().replace(/[│┃█▀▄▌▐░▒▓\s]+/g, " ");
const type = async (t: string) => { await act(() => screen!.mockInput.typeText(t)); await settle(60); };
const press = async (k: string, ms = 80) => { await act(async () => screen!.mockInput.pressKey(k)); await settle(ms); };
const enter = () => press("\r");
const down = (ms?: number) => press("\u001B[B", ms);
const up = () => press("\u001B[A");
async function waitFor(text: string, ms = 60_000) { const until = Date.now() + ms; while (!frame().includes(text)) { if (Date.now() > until) throw new Error(`never: ${text}\n${raw()}`); await settle(100); } }
async function openHome(size: { width: number; height: number }) {
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Home /> }] }], { initialEntries: ["/"] });
  screen = await testRender(<RouterProvider router={router} />, size); await settle();
}
async function install(name: string) {
  await type(`/agents install acme/${name}`); await enter();
  await waitFor("hooks: present, off"); await down(); await enter(); await waitFor(`Installed acme/${name}`);
  await settle(300);
}
const entry = (n: string) => listPacks().find((p) => p.id === `acme/${n}`)!;
function findText(t: string): { x: number; y: number } | null {
  const lines = raw().split("\n");
  for (let y = 0; y < lines.length; y++) { const x = lines[y]!.indexOf(t); if (x >= 0) return { x, y }; }
  return null;
}
async function click(t: string) { const p = findText(t); if (!p) throw new Error(`no ${t} on screen\n${raw()}`); await act(async () => screen!.mockMouse.click(p.x + 1, p.y)); await settle(150); }
function assertChrome(n: string, label: string) {
  const f = frame(); const sha = entry(n).commit.slice(0, 7);
  if (!f.includes(`acme/${n} @ ${sha}`) || !f.includes("Cancel") || !f.includes("Enable")) throw new Error(`${label}: chrome missing\n${raw()}`);
}

beforeEach(() => { mkdirSync(process.env.MARCSH_AGENTS_DIR!, { recursive: true }); setDefaultEngine("claude"); });
afterEach(async () => {
  rmSync(process.env.MARCSH_PACKS_DIR!, { recursive: true, force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

const cases: [string, number, number][] = process.env.SMALL ? [["thirty", 60, 18], ["thirty", 50, 16], ["thirty", 40, 14], ["seven", 80, 14]] : [
  ["thirty", 110, 50], ["seven", 80, 24], ["hundred", 110, 50], ["hundred", 80, 24], ["long", 80, 24], ["long", 110, 50],
  ["nospace", 80, 24], ["files", 80, 24], ["events", 80, 24], ["events", 110, 50],
];
describe("B1 probe", () => {
  for (const [name, width, height] of cases) {
    test(`${name} ${width}x${height}`, async () => {
      await openHome({ width, height });
      await install(name);
      await type(`/agents hooks acme/${name}`); await enter();
      await waitFor("Enabling runs these commands"); await settle(400);
      assertChrome(name, "first");
      expect(frame()).toContain("Scroll to the end to review");
      // 1. mouse click on Enable before the end
      await click("   Enable"); expect(entry(name).hooks).toBeUndefined(); assertChrome(name, "after click");
      // 2. Enter with selection on Enable via mouse move, then Enter
      { const p = findText("   Enable")!; await act(async () => screen!.mockMouse.moveTo(p.x + 1, p.y)); await settle(100); await enter(); }
      expect(entry(name).hooks).toBeUndefined();
      // scroll back to top for the line-by-line walk
      await press("\u001B[H"); await settle(100);
      // 3. Down+Enter
      await down(); await enter(); expect(entry(name).hooks).toBeUndefined();
      await press("\u001B[H"); await settle(100);
      // walk line by line, collecting what was on screen
      const seen = new Set<string>(); const markers = fixtures[name]!.markers;
      const collect = () => { const f = frame(); for (const m of markers) if (f.includes(m)) seen.add(m); };
      collect();
      let steps = 0;
      while (frame().includes("Scroll to the end to review") && steps < 4000) {
        await down(20); steps++; collect(); assertChrome(name, `step ${steps}`);
        if (steps % 25 === 0) { await enter(); if (entry(name).hooks !== undefined && frame().includes("Scroll to the end")) throw new Error("enabled before end"); if (entry(name).hooks) break; }
      }
      collect();
      const missing = markers.filter((m) => !seen.has(m));
      console.log(`${name} ${width}x${height}: steps=${steps} markers=${markers.length} missing=${missing.length} ${missing.slice(0, 5).join(",")}`);
      expect(missing).toEqual([]);
      expect(entry(name).hooks).toBeUndefined();
      expect(frame()).toContain("These commands run on your machine");
      assertChrome(name, "end");
      await enter();
      await waitFor(`Enabled hooks of acme/${name}`);
      expect(entry(name).hooks).toBeDefined();
    });
  }
  if (!process.env.SMALL) test("mouse wheel reaches the end; click Enable then works", async () => {
    await openHome({ width: 80, height: 24 });
    await install("seven");
    await type(`/agents hooks acme/seven`); await enter();
    await waitFor("Enabling runs these commands"); await settle(400);
    const p = findText("SEVEN_0_MK")!;
    for (let i = 0; i < 60 && frame().includes("Scroll to the end"); i++) { await act(async () => screen!.mockMouse.scroll(p.x, p.y, "down")); await settle(60); }
    expect(frame()).not.toContain("Scroll to the end");
    expect(frame()).toContain("SEVEN_6_MK");
    await click("   Enable");
    await waitFor("Enabled hooks of acme/seven");
  });
});
