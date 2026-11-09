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
      ctx.dialog.open({
        title: "Select Agent",
        children: <AgentsDialogContent currentMode={ctx.mode} onSelectMode={ctx.setMode} />,
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
