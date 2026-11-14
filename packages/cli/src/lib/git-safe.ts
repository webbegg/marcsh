/**
 * How marcsh runs a read-only git command in a folder it may not trust (the status line reads any folder, before the trust
 * question). A repo's own `.git/config` can name programs git runs on its behalf; these options switch off the ones a read can
 * reach, the way `snapshot.ts` (`SAFE_CONFIG`) and `packs.ts` (`hardened`) do for their own git calls.
 */

/** Per-call config that wins over the repo's: no fsmonitor hook, no hooks, no pager, no submodule recursion. */
export const READ_ONLY_CONFIG: readonly (readonly [string, string])[] = [
  ["core.fsmonitor", "false"],
  ["core.untrackedCache", "false"],
  ["core.hooksPath", "/dev/null"],
  ["core.pager", "cat"],
  ["diff.external", ""],
  ["submodule.recurse", "false"],
  ["status.submoduleSummary", "false"],
];

/** The arguments that go before the git subcommand: `--no-pager`, `--no-optional-locks` and every `-c` of `READ_ONLY_CONFIG`. */
export function readOnlyGitArgs(): string[] {
  return ["--no-pager", "--no-optional-locks", ...READ_ONLY_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`])];
}

/**
 * The environment for such a call: nothing inherited from `GIT_*` (a surrounding `GIT_DIR`, `GIT_EXTERNAL_DIFF` or
 * `GIT_CONFIG_PARAMETERS` cannot redirect or extend it), no system config, no optional locks, no prompt and no pager.
 * The user's own global config still applies.
 */
export function readOnlyGitEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" };
}
