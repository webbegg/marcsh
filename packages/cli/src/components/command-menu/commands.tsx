import { SUPPORTED_CHAT_MODELS } from "../../lib/models";
import { piHandle } from "../../lib/engine";
import { listStoredLogins, redactSecrets } from "../../lib/engine/pi-auth";
import { listAvailablePiModels, pickPiModel } from "../../lib/engine/pi-models";
import { 
  AgentsDialogContent,
  EngineDialogContent,
  LoginDialogContent,
  LogoutDialogContent,
  ModelsDialogContent,
  PiModelsDialogContent,
  SessionsDialogContent,
  ThemeDialogContent,
  TrustDialogContent,
} from "../dialogs";
import { runPackCommand } from "../dialogs/pack-dialogs";
import type { SessionCommands } from "./session-commands";
import type { Command, CommandContext } from "./types";

const failureText = (error: unknown) => redactSecrets(error instanceof Error ? error.message : String(error));

/** The pi model picker: the models of pi's runtime whose provider has credentials. */
async function openPiModels(ctx: CommandContext) {
  try {
    const models = await listAvailablePiModels(await piHandle().getRuntime());
    if (models.length === 0) {
      ctx.toast.show({ variant: "info", message: "No pi model is available yet. Run /login to sign in to a provider." });
      return;
    }
    ctx.dialog.open({
      title: "Select Model",
      children: (
        <PiModelsDialogContent
          models={models}
          currentModel={pickPiModel(ctx.piModel, models)}
          onSelectModel={ctx.setPiModel}
        />
      ),
    });
  } catch (error) {
    ctx.toast.show({ variant: "error", message: `Could not load pi models: ${failureText(error)}` });
  }
}

/** `/login` and `/logout` manage the pi engine's logins, whatever engine the current session runs on. */
async function openLogin(ctx: CommandContext) {
  try {
    const pi = piHandle();
    const runtime = await pi.getRuntime();
    ctx.dialog.open({
      title: "Log in",
      children: (
        <LoginDialogContent
          runtime={runtime}
          getDeviceId={pi.getDeviceId}
          onLoggedIn={() => void ctx.refreshPiModel()}
        />
      ),
    });
  } catch (error) {
    ctx.toast.show({ variant: "error", message: `Could not start pi login: ${failureText(error)}` });
  }
}

async function openLogout(ctx: CommandContext) {
  try {
    const runtime = await piHandle().getRuntime();
    const logins = await listStoredLogins(runtime);
    if (logins.length === 0) {
      ctx.toast.show({
        variant: "info",
        message: "No pi logins to remove. /logout only removes logins made with /login; environment variables are unchanged.",
      });
      return;
    }
    ctx.dialog.open({
      title: "Log out",
      children: <LogoutDialogContent runtime={runtime} logins={logins} onLoggedOut={() => void ctx.refreshPiModel()} />,
    });
  } catch (error) {
    ctx.toast.show({ variant: "error", message: `Could not read pi logins: ${failureText(error)}` });
  }
}

/** The action of a command on the open session; with none open (the home screen) it says so. */
const onSession =
  (name: string, run: (session: SessionCommands, ctx: CommandContext) => void | Promise<void>) =>
  (ctx: CommandContext) =>
    ctx.session ? run(ctx.session, ctx) : ctx.toast.show({ variant: "info", message: `/${name} works inside a session. Open one first.` });

export const COMMANDS: Command[] = [
  {
    name: "new",
    description: "Start a new conversation",
    value: "/new",
    action: (ctx) => {
      ctx.navigate("/");
    },
  },
  {
    name: "agents",
    description: "Switch agents",
    value: "/agents",
    action: (ctx) => {
      // `/agents install|update|remove|hooks …` goes straight to the pack flow the dialog's rows open.
      if (ctx.args) return runPackCommand(ctx.args, { dialog: ctx.dialog, toast: ctx.toast, onChanged: () => void ctx.reloadAgents() });
      ctx.dialog.open({
        title: "Select Agent",
        // Read the files again: an agent added since start is listed without a restart.
        children: <AgentsDialogContent agents={ctx.reloadAgents()} currentId={ctx.agentId} onSelectAgent={ctx.selectAgent} onPacksChanged={ctx.reloadAgents} />,
      })
    },
  },
  {
    name: "models",
    description: "Select AI model for generation",
    value: "/models",
    action: (ctx) => {
      // The Claude picker lists Claude aliases, which a pi session cannot use.
      if (ctx.engine === "pi") return openPiModels(ctx);
      ctx.dialog.open({
        title: "Select Model",
        children: (
          <ModelsDialogContent
            models={SUPPORTED_CHAT_MODELS.map((model) => model.id)}
            onSelectModel={ctx.setModel}
          />
        ),
      })
    },
  },
  {
    name: "login",
    description: "Log in to a pi provider (subscription or API key)",
    value: "/login",
    action: openLogin,
  },
  {
    name: "logout",
    description: "Remove a pi provider login",
    value: "/logout",
    action: openLogout,
  },
  {
    name: "trust",
    description: "Trust or distrust this project's pi files",
    value: "/trust",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Project Trust",
        children: <TrustDialogContent cwd={ctx.cwd} />,
      })
    },
  },
  {
    name: "engine",
    description: "Choose the engine for new sessions",
    value: "/engine",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Select Engine",
        children: (
          <EngineDialogContent
            currentEngine={ctx.defaultEngine}
            onSelectEngine={ctx.setDefaultEngine}
          />
        ),
      })
    },
  },
  {
    name: "sessions",
    description: "Browse past sessions",
    value: "/sessions",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Sessions",
        children: <SessionsDialogContent />,
      })
    },
  },
  {
    name: "rename",
    description: "Rename this session",
    value: "/rename",
    argumentHint: "<title>",
    scope: "session",
    action: onSession("rename", (session, ctx) => session.rename(ctx.args)),
  },
  {
    name: "fork",
    description: "Continue in a copy of this session",
    value: "/fork",
    scope: "session",
    action: onSession("fork", (session) => session.fork()),
  },
  {
    name: "export",
    description: "Save this session as markdown or JSON",
    value: "/export",
    argumentHint: "[md|json] [path]",
    scope: "session",
    action: onSession("export", (session, ctx) => session.exportTranscript(ctx.args)),
  },
  {
    name: "undo",
    description: "Put back the files the last turn changed",
    value: "/undo",
    scope: "session",
    action: onSession("undo", (session) => session.undo()),
  },
  {
    name: "redo",
    description: "Re-apply the file changes /undo took back",
    value: "/redo",
    scope: "session",
    action: onSession("redo", (session) => session.redo()),
  },
  {
    name: "diff",
    description: "Show the files changed in this session",
    value: "/diff",
    scope: "session",
    action: onSession("diff", (session) => session.diff()),
  },
  {
    name: "compact",
    description: "Compact this session's context",
    value: "/compact",
    scope: "session",
    action: onSession("compact", (session) => session.compact()),
  },
  {
    name: "copy",
    description: "Copy the last reply to the clipboard",
    value: "/copy",
    scope: "session",
    action: onSession("copy", (session) => session.copy()),
  },
  {
    name: "theme",
    description: "Change color theme",
    value: "/theme",
    action: (ctx) => {
      ctx.dialog.open({
        title: "Select Theme",
        children: <ThemeDialogContent />,
      })
    },
  },
  {
    name: "exit",
    description: "Quit the application",
    value: "/exit",
    action: (ctx) => {
      ctx.exit();
    },
  },
];

/** Marcsh's own command names: a user's command never takes one. */
export const COMMAND_NAMES = COMMANDS.map((command) => command.name);
