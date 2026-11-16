// Allowed edit surfaces: the repository-relative paths or globs a bounded writer subagent may touch. The parent derives them (the
// `Task` tool's `editSurfaces`); the child's guard enforces them (see `engine/pi-surfaces.ts`). Ported from brigadev's edit-surfaces.

const GLOB_CHARS = /[*?[\]{}]/;

/** A surface as it is compared: trimmed, forward slashes, no leading `./`, no trailing `/`. */
function normalize(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

/** The surfaces in the form the rest of the module compares and shows them. */
export function normalizeSurfaces(surfaces: readonly string[]): string[] {
  return surfaces.map(normalize);
}

/** Entries that name the whole repository once normalized (`.`, `./`, `./.`, `*`, `**`, `**\/*`, `./**`). */
const WHOLE_REPOSITORY = new Set(["", ".", "*", "**", "**/*", "./*", "./**"]);

/**
 * The problems with a list of surfaces, each naming the bad entry; an empty list means the surfaces are valid. Rejected: no entries,
 * empty or non-string entries, the repository root in any spelling, absolute and home paths, and `..` anywhere.
 */
export function validateSurfaces(surfaces: readonly unknown[] | undefined): string[] {
  if (!surfaces || surfaces.length === 0) return ["editSurfaces must list at least one repository-relative path or glob"];
  const problems: string[] = [];
  for (const raw of surfaces) {
    if (typeof raw !== "string") {
      problems.push(`${JSON.stringify(raw)} is not a string`);
      continue;
    }
    const trimmed = raw.trim();
    const path = normalize(raw);
    if (!trimmed) problems.push("empty surface entry");
    else if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("~")) {
      problems.push(`"${raw}" must be repository-relative, not absolute`);
    } else if (path.split("/").includes("..")) problems.push(`"${raw}" must not escape the repository with ".."`);
    else if (WHOLE_REPOSITORY.has(path) || path.split("/").every((segment) => segment === "." || segment === "")) {
      problems.push(`"${raw}" covers the whole repository`);
    }
  }
  return problems;
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else source += "[^/]*";
    } else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** True when a repository-relative path is inside one of the surfaces. */
export function isWithinSurfaces(relativePath: string, surfaces: readonly string[]): boolean {
  const path = normalize(relativePath);
  return surfaces.some((raw) => {
    const surface = normalize(raw);
    if (GLOB_CHARS.test(surface)) return globToRegExp(surface).test(path);
    // A plain entry matches the exact file or anything under that directory.
    return path === surface || path.startsWith(`${surface}/`);
  });
}

function staticSegments(surface: string): string[] {
  const segments = normalize(surface).split("/");
  const firstGlob = segments.findIndex((segment) => GLOB_CHARS.test(segment));
  return firstGlob === -1 ? segments : segments.slice(0, firstGlob);
}

function isSegmentPrefix(a: string[], b: string[]): boolean {
  return a.length <= b.length && a.every((segment, i) => segment === b[i]);
}

/**
 * Conservative overlap check: two surfaces overlap when the static part of one is a path prefix of the other. It may report overlap
 * for disjoint globs in one directory (`src/*.ts` and `src/*.js`); it never misses a real one. The message names the entries.
 */
export function surfacesOverlap(a: readonly string[], b: readonly string[]): string | undefined {
  for (const left of a) {
    for (const right of b) {
      if (isSegmentPrefix(staticSegments(left), staticSegments(right)) || isSegmentPrefix(staticSegments(right), staticSegments(left))) {
        return `"${left}" overlaps "${right}"`;
      }
    }
  }
  return undefined;
}
