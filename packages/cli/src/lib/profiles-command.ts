import { agentModelFits } from "./agents";
import { primaryModel, routingReport } from "./model-routing";
import { activeProfiles, createStarterProfiles, getSessionProfile, isProfileName, loadProfiles, profilesPath, profilesWarning, setSessionProfile, writeDefaultProfile } from "./profiles";
import { DEFAULT_CHAT_MODEL_ID, SUPPORTED_CHAT_MODELS } from "./models";

export const PROFILE_USAGE = "Usage: /profile [use <name> | default <name> | clear]";

/** What a typed `/profile <args>` asks for. `usage` carries the error text to show; the others are ready to run. */
export type ProfileCommand =
  | { kind: "show" }
  /** The profile for this run of marcsh; its `primary` model becomes the session's model. */
  | { kind: "use"; name: string }
  /** The profile saved in the file as the default. */
  | { kind: "default"; name: string }
  /** Drops the session's profile: the default one (if any) applies again. */
  | { kind: "clear" }
  /** Creates a starter profiles file. Never typed: only the `/profile` dialog's confirm row runs it. */
  | { kind: "create-starter" }
  | { kind: "usage"; message: string };

const usage = (why: string): ProfileCommand => ({ kind: "usage", message: `${why} ${PROFILE_USAGE}` });

/** `/profile`, `/profile use <name>`, `/profile default <name>` and `/profile clear`. Pure: nothing is read, stored or changed. */
export function parseProfileCommand(args: string): ProfileCommand {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { kind: "show" };
  const [verb, name, ...extra] = words;
  switch (verb!.toLowerCase()) {
    case "clear":
      return name === undefined ? { kind: "clear" } : usage("`clear` takes no name.");
    case "use":
    case "default":
      if (name === undefined || extra.length > 0) return usage(`\`${verb!.toLowerCase()}\` takes one profile name.`);
      return { kind: verb!.toLowerCase() as "use" | "default", name };
    default:
      return usage(`"${verb}" is not a subcommand.`);
  }
}

/** What the command did for the user to see: a message to toast, or the lines of the routing to show in a dialog. */
export type ProfileOutcome =
  | { toast: { variant: "success" | "info" | "error"; message: string } }
  /** `create`: there is no profiles file, so the dialog offers to create a starter one. */
  | { show: string[]; create?: true };

/** What running the command needs from the app. */
export type ProfileEnv = {
  /** The engine of the open session, or the default one for a new session. */
  engine: string;
  /** Switches the model of pi turns / of Claude turns to `model`. */
  setPiModel: (model: string) => void;
  setClaudeModel: (model: (typeof SUPPORTED_CHAT_MODELS)[number]["id"]) => void;
  /** The named subagents the selected agent may start, for the routing to list. */
  subagents: () => ReadonlyArray<{ name: string; model?: string }>;
  /** The profiles file; default: `profilesPath()`. */
  path?: string;
  /** The models a starter file uses: pi's model ("provider/id") and the Claude alias. */
  piModel?: string;
  claudeModel?: string;
};

const names = (profiles: Record<string, unknown>) => {
  const all = Object.keys(profiles);
  return all.length > 0 ? all.join(", ") : "none";
};

/** Runs the command. Never throws: whatever goes wrong comes back as an error toast. */
export function runProfileCommand(command: ProfileCommand, env: ProfileEnv): ProfileOutcome {
  const path = env.path ?? profilesPath();
  const engine = { id: env.engine, fits: (model: string) => agentModelFits(model, env.engine) };
  const error = (message: string): ProfileOutcome => ({ toast: { variant: "error", message } });
  if (command.kind === "usage") return error(command.message);

  const loaded = loadProfiles(path);
  const { file } = loaded;

  if (command.kind === "show") {
    const lines = routingReport({ active: activeProfiles(file), subagents: env.subagents(), engine, problems: loaded.problems });
    if (!loaded.exists) lines.unshift(`There is no profiles file yet (${path}). Create it to route models: see the configuration guide.`);
    else if (Object.keys(file.profiles).length > 0) lines.push(`Profiles in the file: ${names(file.profiles)}`);
    return loaded.exists ? { show: lines } : { show: lines, create: true };
  }

  if (command.kind === "create-starter") {
    const created = createStarterProfiles({ engine: env.engine, piModel: env.piModel ?? "", claudeModel: env.claudeModel ?? DEFAULT_CHAT_MODEL_ID }, path);
    if (!created.ok) return error(created.message);
    const shown = runProfileCommand({ kind: "show" }, env);
    const lines = "show" in shown ? shown.show : [];
    return { show: [`Created ${path}: a starter file with one profile, "default". It changes nothing yet; edit it to route models (see the configuration guide).`, ...lines] };
  }

  if (command.kind === "clear") {
    if (getSessionProfile() === undefined) return { toast: { variant: "info", message: "No profile was chosen for this session." } };
    setSessionProfile(undefined);
    return { toast: { variant: "success", message: file.default ? `Session profile cleared; the default profile ${file.default} applies.` : "Session profile cleared; no profile applies." } };
  }

  if (!isProfileName(command.name) || !Object.hasOwn(file.profiles, command.name)) {
    const why = !loaded.exists
      ? `There is no profiles file (${path}).`
      : loaded.problems.length > 0 && Object.keys(file.profiles).length === 0
        ? `${profilesWarning(loaded, path)}`
        : `There is no profile "${command.name}". Profiles: ${names(file.profiles)}.`;
    return error(why);
  }

  if (command.kind === "default") {
    try {
      writeDefaultProfile(command.name, path);
    } catch (failure) {
      return error(failure instanceof Error ? failure.message : String(failure));
    }
    return { toast: { variant: "success", message: `Default profile: ${command.name}. It applies to every session that has not chosen another with /profile use.` } };
  }

  // use: this run of marcsh; the session's model follows the profile's primary route (the model can still be changed after).
  setSessionProfile(command.name);
  // Only the profile just chosen: its own primary route, never the default profile's.
  const model = primaryModel(activeProfiles(file, command.name).slice(0, 1), engine);
  const base = `Profile ${command.name} is in use for this session.`;
  if (!model) return { toast: { variant: "success", message: `${base} Its routes apply to subagents; the model stays as it is (no primary route fits ${env.engine}).` } };
  if (env.engine === "pi") {
    env.setPiModel(model);
    return { toast: { variant: "success", message: `${base} Model: ${model}.` } };
  }
  const alias = SUPPORTED_CHAT_MODELS.find((candidate) => candidate.id === model);
  if (!alias) return { toast: { variant: "info", message: `${base} Its primary model ${model} is not one /models offers on Claude, so the model stays as it is.` } };
  env.setClaudeModel(alias.id);
  return { toast: { variant: "success", message: `${base} Model: ${alias.id}.` } };
}
