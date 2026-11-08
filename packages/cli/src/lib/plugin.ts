import { existsSync } from "node:fs";
import { join } from "node:path";

// From src/lib (bin/marcsh runs the sources) or from dist (the built bundle), relative to the running file's directory.
const CANDIDATES = ["../../plugin", "../plugin"];

/** Absolute path of the bundled marcsh Claude Code plugin, or null when it cannot be found. */
export function marcshPluginPath(baseDir: string = import.meta.dir): string | null {
  for (const candidate of CANDIDATES) {
    const path = join(baseDir, candidate);
    if (existsSync(join(path, ".claude-plugin", "plugin.json"))) return path;
  }
  return null;
}
