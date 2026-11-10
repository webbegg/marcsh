import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findProjectResources } from "./pi-trust";

// S18: marcsh asks exactly when pi 1.5.0's own hasTrustRequiringProjectResources says the project has gated files.
const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { hasTrustRequiringProjectResources } = (await import(new URL("core/trust-manager.js", entry).href)) as {
  hasTrustRequiringProjectResources: (cwd: string) => boolean;
};

const root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-trust-parity-")));
const savedHome = process.env.HOME;
afterAll(() => {
  process.env.HOME = savedHome;
  for (const dir of [root]) {
    try {
      chmodSync(dir, 0o700);
    } catch {}
  }
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
const file = (p: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "x");
};
type Build = (project: string, base: string) => string | void;
const cases: [string, Build][] = [
  ["empty project", () => {}],
  ["empty .pi", (p) => void mkdirSync(join(p, ".pi"))],
  [".pi/agent only", (p) => void mkdirSync(join(p, ".pi/agent"), { recursive: true })],
  [".pi/npm only", (p) => void mkdirSync(join(p, ".pi/npm"), { recursive: true })],
  ["AGENTS.md only", (p) => file(join(p, "AGENTS.md"))],
  [".pi is a file", (p) => file(join(p, ".pi"))],
  [".pi symlinked to a folder with extensions", (p, b) => (file(join(b, "real/extensions/x.ts")), symlinkSync(join(b, "real"), join(p, ".pi")))],
  [".agents/skills in project", (p) => void mkdirSync(join(p, ".agents/skills"), { recursive: true })],
  [".agents without skills", (p) => void mkdirSync(join(p, ".agents/other"), { recursive: true })],
  [".agents/skills in grandparent", (p) => void mkdirSync(join(p, "../../.agents/skills"), { recursive: true })],
  ["parent .pi/extensions (pi reads .pi in cwd only)", (p) => file(join(p, "../.pi/extensions/x.ts"))],
  ["cwd is a subfolder of a project with .pi", (p) => (file(join(p, ".pi/extensions/x.ts")), mkdirSync(join(p, "sub")), join(p, "sub"))],
  ["cwd is a symlink to a project with .pi", (p, b) => (file(join(p, ".pi/mcp.json")), symlinkSync(p, join(b, "link")), join(b, "link"))],
  ["cwd does not exist", (p) => join(p, "missing")],
  ["cwd = HOME holding ~/.agents/skills", (p) => (mkdirSync(join(p, ".agents/skills"), { recursive: true }), (process.env.HOME = p), p)],
  ["HOME reached through a symlink", (p, b) => (mkdirSync(join(p, ".agents/skills"), { recursive: true }), symlinkSync(p, join(b, "home")), (process.env.HOME = join(b, "home")), mkdirSync(join(p, "proj")), join(p, "proj"))],
];
for (const name of ["settings.json", "mcp.json", "extensions", "skills", "prompts", "themes", "SYSTEM.md", "APPEND_SYSTEM.md"]) {
  cases.push([`.pi/${name} as a file`, (p) => file(join(p, ".pi", name))]);
  cases.push([`.pi/${name} as an empty folder`, (p) => void mkdirSync(join(p, ".pi", name), { recursive: true })]);
  cases.push([`.pi/${name} as a broken symlink`, (p) => (mkdirSync(join(p, ".pi"), { recursive: true }), symlinkSync(join(p, "nowhere"), join(p, ".pi", name)))]);
}

describe("project trust detection parity with pi (S18)", () => {
  for (const [name, build] of cases) {
    test(name, () => {
      const base = join(root, `c${n++}`);
      const project = join(base, "a", "b", "project");
      mkdirSync(project, { recursive: true });
      try {
        const cwd = build(project, base) || project;
        expect(findProjectResources(cwd).length > 0).toBe(hasTrustRequiringProjectResources(cwd));
      } finally {
        process.env.HOME = savedHome;
      }
    });
  }
});
