import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { parseTools, type AgentTools } from "./agent-tools";
import { Mode, type ModeType } from "./modes";

/** An agent file larger than this is not read (a pack is third-party content). */
export const MAX_AGENT_BYTES = 256 * 1024;

/**
 * A selectable agent: Tab cycles them and `/agents` lists them. Build and Plan are built in; the rest are markdown files with
 * OpenCode-style frontmatter. `mode` is the permission profile both engines already understand: PLAN only reads, BUILD asks
 * before it writes or runs.
 */
export type Agent = {
  /** "build" and "plan" for the built-ins, "<pack>/<file stem>" for the rest. */
  id: string;
  name: string;
  description?: string;
  mode: ModeType;
  /** Appended to the engine's own system prompt, never in place of it. */
  prompt?: string;
  /** The model this agent asks for; the session model is used when absent or unusable on the engine. */
  model?: string;
  /** Where the agent comes from: "user" for ~/.marcsh/agents, "owner/repo" for an installed pack; undefined for the built-ins. */
  pack?: string;
  /** A pack agent's generated plugin view (its skills and commands): loaded by the engines only while this agent is selected. */
  pluginDir?: string;
  /** The tool groups this agent does not get (its `tools` field); undefined when it restricts nothing. */
  tools?: AgentTools;
  /** Names in the `tools` field that match no tool group: not applied, and named in the warning. */
  unknownTools?: string[];
  /** Frontmatter fields marcsh reads but does not apply. */
  ignored: string[];
};

/** `nested` holds the raw indented lines under a key (a map or list marcsh does not read generally; only `tools` is used). */
export type Frontmatter = { fields: Map<string, string | null>; nested: Map<string, string[]>; body: string; unclosed: boolean };

/**
 * The one reader for flat frontmatter (agent files and marcsh's own plugin files): `key: value` lines, quoted values, and `|`/`>`
 * blocks. An indented block under a key is a nested map or list: its field is null and its lines are kept in `nested`, so a caller
 * that reads one (`tools`) can; the others are never applied.
 * (A pack's skills and commands are checked by `declaredKeys` in pack-scan.ts, a stricter reader on purpose.)
 */
export function readFrontmatter(text: string): Frontmatter {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const fields = new Map<string, string | null>();
  const nested = new Map<string, string[]>();
  if (lines[0]?.trim() !== "---") return { fields, nested, body: text, unclosed: false };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  // An opening line with no closing one: the whole file stays the prompt, and the caller reports it.
  if (end < 0) return { fields, nested, body: text, unclosed: true };

  let key: string | undefined;
  let block: { style: string; lines: string[] } | undefined;
  const closeBlock = () => {
    if (key && block) fields.set(key, block.lines.join(block.style.startsWith("|") ? "\n" : " ").trim());
    block = undefined;
  };
  for (const line of lines.slice(1, end)) {
    const top = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (top) {
      closeBlock();
      key = top[1]!;
      const value = top[2]!.trim();
      if (/^[|>][-+]?$/.test(value)) block = { style: value, lines: [] };
      fields.set(key, value.replace(/^(["'])(.*)\1$/, "$2"));
    } else if (key && /^[ \t]/.test(line) && line.trim()) {
      if (block) block.lines.push(line.trim());
      else {
        fields.set(key, null);
        nested.set(key, [...(nested.get(key) ?? []), line.trim()]);
      }
    }
  }
  closeBlock();
  return { fields, nested, body: lines.slice(end + 1).join("\n"), unclosed: false };
}

const KNOWN_FIELDS = new Set(["name", "description", "mode", "permission", "model", "tools"]);

function slug(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
}

/** The ID part of an agent file: its slug, else (a name with no letters or digits) a short hash of the file name, which is stable. */
const idPart = (stem: string, file: string) => slug(stem) || createHash("sha1").update(file).digest("hex").slice(0, 8);

/** Parses one agent file; null when it is a subagent (not selectable). */
export function parseAgentFile(text: string, { pack, file }: { pack: string; file: string }): Agent | null {
  const { fields, nested, body, unclosed } = readFrontmatter(text);
  // A `tools` field with no name in it is reported as ignored, like any other field marcsh cannot apply.
  const tools = fields.has("tools") ? parseTools(fields.get("tools"), nested.get("tools")) : undefined;
  const ignored = [...fields.keys()].filter((key) => !KNOWN_FIELDS.has(key) || (key === "tools" && tools?.empty));
  if (unclosed) ignored.push("frontmatter");

  // The frontmatter `mode` says whether the agent is selectable (primary/all) or a subagent; it is not the Build/Plan `mode` of the
  // Agent, which comes from `permission`.
  const selectable = fields.get("mode");
  if (selectable === "subagent") return null;
  if (selectable !== undefined && selectable !== "primary" && selectable !== "all") ignored.push("mode");

  const permission = fields.get("permission");
  if (permission !== undefined && permission !== "read-only" && permission !== "build") ignored.push("permission");

  const stem = basename(file, extname(file));
  const field = (key: string) => fields.get(key)?.trim() || undefined;
  const prompt = body.trim();
  return {
    id: `${pack}/${idPart(stem, file)}`,
    name: field("name") ?? stem,
    description: field("description"),
    mode: permission === "read-only" ? Mode.PLAN : Mode.BUILD,
    prompt: prompt || undefined,
    model: field("model"),
    pack,
    ...(tools?.tools ? { tools: tools.tools } : {}),
    ...(tools && !tools.empty ? { unknownTools: tools.unknown } : {}),
    ignored,
  };
}
