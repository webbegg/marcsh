import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

// packages/cli/src/docs -> repository root
const ROOT = join(import.meta.dir, "..", "..", "..", "..");

const EXPECTED_PAGES = [
  "README.md",
  ...[
    "getting-started",
    "screen",
    "guides/plan-then-build",
    "guides/resume-work",
    "guides/switch-engine-or-model",
    "guides/install-a-pack",
    "guides/write-an-agent",
    "guides/publish-a-pack",
    "engines-and-models",
    "sessions",
    "commands",
    "agents",
    "packs",
    "pack-hooks",
    "building-a-pack",
    "configuration",
    "security",
    "troubleshooting",
  ].map((page) => `docs/${page}.md`),
];

/** README.md and every .md under docs/, in subfolders too. */
function pages(root = ROOT): string[] {
  const found = existsSync(join(root, "README.md")) ? [join(root, "README.md")] : [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".md")) found.push(path);
    }
  };
  if (existsSync(join(root, "docs"))) walk(join(root, "docs"));
  return found;
}

/** GitHub's heading anchor: lower case, markup and punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, "")
    .replace(/ /g, "-");
}

/**
 * Text outside fenced code blocks. A fence closes on a line of the same character, at least as long as the opening one, with nothing after it.
 * Any indent opens one, so a fence inside a list item counts.
 */
function withoutFences(markdown: string): string {
  const lines: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of markdown.split("\n")) {
    if (fence === null) {
      const opening = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      // The info string of a backtick fence holds no backtick: otherwise the line is inline code.
      if (opening && !(opening[1]![0] === "`" && opening[2]!.includes("`"))) fence = { char: opening[1]![0]!, length: opening[1]!.length };
      else lines.push(line);
    } else {
      const closing = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (closing && closing[1]![0] === fence.char && closing[1]!.length >= fence.length) fence = null;
    }
  }
  return lines.join("\n");
}

function anchorsOf(file: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  for (const line of withoutFences(readFileSync(file, "utf8")).split("\n")) {
    const heading = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const base = slug(heading[1]!);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

// [text](target "title"): the text may hold one level of brackets (an image), the target one level of parentheses.
const INLINE_LINK = /!?\[((?:[^[\]\\]|\\.|\[(?:[^[\]\\]|\\.)*\])*)\]\(\s*(<[^>]*>|(?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/** The targets of the links in `text`, and of the links inside their text (a badge that is itself a link). */
function inlineTargets(text: string): string[] {
  return [...text.matchAll(INLINE_LINK)].flatMap((match) => [match[2]!.replace(/^<|>$/g, ""), ...inlineTargets(match[1]!)]);
}

/** Targets of inline links and images, `[text](target "title")` and `[text](<target>)`. Code spans and fences are skipped. */
function linkTargets(markdown: string): string[] {
  const text = withoutFences(markdown).replace(/(`+)[^\n]*?\1/g, "");
  const targets = inlineTargets(text);
  // Reference definitions: [label]: target
  for (const match of text.matchAll(/^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/gm)) {
    targets.push(match[1]!.replace(/^<|>$/g, ""));
  }
  return targets;
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Whether `path` exists with exactly this letter case under `root`: a case-insensitive disk (macOS) would accept a link that is broken on GitHub and on Linux. */
function existsExactly(root: string, path: string): boolean {
  const parts = relative(root, path).split(sep);
  if (parts[0] === "..") return existsSync(path);
  let current = root;
  for (const part of parts) {
    if (part === "") continue;
    try {
      if (!readdirSync(current).includes(part)) return false;
    } catch {
      return false;
    }
    current = join(current, part);
  }
  return true;
}

function brokenLinks(file: string, root = ROOT): string[] {
  const problems: string[] = [];
  const name = relative(root, file);
  for (const target of linkTargets(readFileSync(file, "utf8"))) {
    // http(s), mailto and any other scheme
    if (target === "" || EXTERNAL.test(target)) continue;

    const hash = target.indexOf("#");
    let path: string;
    let anchor: string;
    try {
      path = decodeURI(hash === -1 ? target : target.slice(0, hash));
      anchor = hash === -1 ? "" : decodeURI(target.slice(hash + 1));
    } catch {
      problems.push(`${name}: ${target} is not a valid link`);
      continue;
    }

    const destination = path === "" ? file : resolve(dirname(file), path);
    if (!existsExactly(root, destination)) {
      problems.push(`${name}: ${target} does not exist`);
      continue;
    }
    if (anchor !== "" && statSync(destination).isFile() && destination.endsWith(".md") && !anchorsOf(destination).has(anchor.toLowerCase())) {
      problems.push(`${name}: ${target} has no heading '#${anchor}' in ${relative(root, destination)}`);
    }
  }
  return problems;
}

describe("documentation pages", () => {
  test("the expected set exists", () => {
    const missing = EXPECTED_PAGES.filter((page) => !existsSync(join(ROOT, page)));
    expect(missing).toEqual([]);
  });

  test("every relative link in README.md and docs/**/*.md resolves", () => {
    expect(pages().flatMap((page) => brokenLinks(page))).toEqual([]);
  });
});

describe("link checker", () => {
  const scratch = (markdown: string) => linkTargets(markdown);

  test("reads inline links, skips code and fences", () => {
    const markdown = ["[a](a.md) and ![img](p.png \"t\") `[no](code.md)`", "```", "[no](fence.md)", "```", "[b]: b.md#x"].join("\n");
    expect(scratch(markdown)).toEqual(["a.md", "p.png", "b.md#x"]);
  });

  test("slugs follow GitHub", () => {
    expect(slug("Pack hooks: what runs?")).toBe("pack-hooks-what-runs");
    expect(slug("`/agents` and [Packs](packs.md)")).toBe("agents-and-packs");
    expect(slug("ask_user")).toBe("ask_user");
  });

  test("reads a link around an image, a double-backtick code span and parentheses in a target", () => {
    const markdown = ["[![badge](a.png)](b.md)", "``[no](x.md) `y` ``", "[c](d_(1).md)"].join("\n");
    expect(scratch(markdown).sort()).toEqual(["a.png", "b.md", "d_(1).md"]);
  });

  test("a fence closes only on a fence of the same kind, at least as long, with no text after it", () => {
    const markdown = ["````md", "```sh", "[no](one.md)", "```", "[no](two.md)", "````", "[yes](three.md)", "    ```", "    [no](four.md)", "    ```"].join("\n");
    expect(scratch(markdown)).toEqual(["three.md"]);
  });
});

describe("link checker on fixtures", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "doc-links-"));
    mkdirSync(join(root, "docs"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const write = (name: string, text: string) => writeFileSync(join(root, name), text);
  const check = (name: string) => brokenLinks(join(root, name), root);

  test("reports a missing file", () => {
    write("README.md", "[gone](docs/gone.md)\n");
    expect(check("README.md")).toEqual(["README.md: docs/gone.md does not exist"]);
  });

  test("reports a missing heading, and accepts the numbered anchor of a duplicate heading", () => {
    write("docs/a.md", "# A\n\n## Same\n\n## Same\n");
    write("README.md", "[ok](docs/a.md#same) [ok](docs/a.md#same-1) [bad](docs/a.md#same-2) [bad](docs/a.md#nope)\n");
    expect(check("README.md")).toEqual([
      "README.md: docs/a.md#same-2 has no heading '#same-2' in docs/a.md",
      "README.md: docs/a.md#nope has no heading '#nope' in docs/a.md",
    ]);
  });

  test("a comment line in a code block is not a heading", () => {
    write("docs/a.md", "# A\n\n```sh\n# build\n```\n");
    write("README.md", "[bad](docs/a.md#build)\n");
    expect(check("README.md")).toEqual(["README.md: docs/a.md#build has no heading '#build' in docs/a.md"]);
  });

  test("a link with the wrong letter case is broken, as it is on GitHub", () => {
    write("docs/a.md", "# A\n");
    write("README.md", "[bad](docs/A.md)\n");
    expect(check("README.md")).toEqual(["README.md: docs/A.md does not exist"]);
  });

  test("a malformed escape is reported, not thrown", () => {
    write("README.md", "[bad](docs/%zz.md)\n");
    expect(check("README.md")).toEqual(["README.md: docs/%zz.md is not a valid link"]);
  });

  test("pages in folders under docs/ are checked too", () => {
    mkdirSync(join(root, "docs", "guides"));
    write("docs/guides/a.md", "[gone](../gone.md)\n");
    expect(pages(root).flatMap((page) => brokenLinks(page, root))).toEqual(["docs/guides/a.md: ../gone.md does not exist"]);
  });

  test("external links and links inside the same page are left alone", () => {
    write("README.md", "# Top\n\n[web](https://example.com/x) [mail](mailto:a@b.c) [self](#top)\n");
    expect(check("README.md")).toEqual([]);
  });
});
