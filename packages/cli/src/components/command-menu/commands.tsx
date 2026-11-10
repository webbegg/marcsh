import { PI_DEFAULT_MODEL, SUPPORTED_CHAT_MODELS } from "../../lib/models";
import { 
  AgentsDialogContent,
  EngineDialogContent,
  ModelsDialogContent,
  SessionsDialogContent,
  ThemeDialogContent,
} from "../dialogs";
import type { Command } from "./types";

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
      // The picker lists Claude aliases, which a pi session cannot use.
      if (ctx.engine === "pi") {
        ctx.toast.show({
          variant: "info",
          message: `pi sessions use ${PI_DEFAULT_MODEL} for now`,
        });
        return;
      }
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
