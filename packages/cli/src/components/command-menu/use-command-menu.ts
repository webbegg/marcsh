import { useRef, useState, useMemo, type RefObject } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { getFilteredCommands, getMenuCommands } from "./filter-commands";
import type { Command } from "./types";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { getStorage } from "../../lib/storage";
import { combineClaudeCommands } from "../../lib/claude-commands";
import { marcshPluginPath, readPluginCommands } from "../../lib/plugin";
import { bundledPiCommands } from "../../lib/engine/pi-commands";
import { loadUserCommands } from "../../lib/user-commands";
import { COMMAND_NAMES } from "./commands";

// Read when the menu opens, so a list cached by a turn or the startup warm-up that just ended shows up.
// The plugin's own commands are read from disk, so they are listed even with an empty cache. So are the user's: a file added since start is listed.
export function loadMenuCommands(engine: string, cwd: string, inSession: boolean): Command[] {
  const user = loadUserCommands({ cwd, builtinNames: COMMAND_NAMES });
  const pluginPath = marcshPluginPath();
  // Each engine has its own cache and its own names for the plugin's commands (on pi, `marcsh:feature` is a template).
  const bundled = !pluginPath ? [] : engine === "pi" ? bundledPiCommands(pluginPath) : readPluginCommands(pluginPath);
  try {
    return getMenuCommands(combineClaudeCommands(getStorage().getCommands(engine), bundled), user, inSession);
  } catch {
    return getMenuCommands(bundled, user, inSession);
  }
}

type UseCommandMenuReturn = {
  showCommandMenu: boolean;
  commandQuery: string;
  /** The commands matching the query, marcsh's own first. */
  commands: Command[];
  selectedIndex: number;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  handleContentChange: (text: string) => void;
  resolveCommand: (index: number) => Command | undefined;
  setSelectedIndex: (index: number) => void;
};

/**
 * The `/` menu of the engine the prompt runs on: its commands and the user's after marcsh's own. `cwd` is the project whose commands are listed.
 * `inSession` lists the commands on the open session too.
 */
export function useCommandMenu(engine: string, cwd: string = process.cwd(), inSession = false): UseCommandMenuReturn {
  const [textValue, setTextValue] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const { push, pop, isTopLayer } = useKeyboardLayer();

  const commandQuery = showCommandMenu && textValue.startsWith("/") ? textValue.slice(1) : "";

  const menuCommands = useMemo(() => (showCommandMenu ? loadMenuCommands(engine, cwd, inSession) : []), [showCommandMenu, engine, cwd, inSession]);
  const filteredCommands = useMemo(
    () => getFilteredCommands(commandQuery, menuCommands),
    [commandQuery, menuCommands],
  );

  const close = () => {
    setShowCommandMenu(false);
    pop("command");
  };

  const handleContentChange = (text: string) => {
    setTextValue(text);
    setSelectedIndex(0);

    // Jump back to the top of the list when the user types a new character
    const scrollbox = scrollRef.current;
    if (scrollbox) {
      scrollbox.scrollTo(0);
    }

    const prefix = text.startsWith("/") ? text.slice(1) : null;
    if (prefix !== null && !prefix.includes(" ")) {
      setShowCommandMenu(true);
      push("command", () => {
        close();
        return true;
      });
    } else {
      close();
    }
  };

  // Resolve a command at a specific index (returns the command, caller handles execution)
  const resolveCommand = (index: number): Command | undefined => {
    const command = filteredCommands[index];
    if (command) {
      close();
    }
    return command;
  };

  // Arrow keys move selection; the list follows along when the highlight goes off-screen
  useKeyboard((key) => {
    if (!showCommandMenu || !isTopLayer("command")) return;

    if (key.name === "escape") {
      key.preventDefault();
      close();
    } else if (key.name === "up") {
      key.preventDefault();
      setSelectedIndex((i: number) => {
        const newIndex = Math.max(0, i - 1);
        // Keep the highlighted item visible when arrowing past the edge
        const sb = scrollRef.current;
        if (sb && newIndex < sb.scrollTop) {
          sb.scrollTo(newIndex);
        }
        return newIndex;
      });
    } else if (key.name === "down") {
      key.preventDefault();
      setSelectedIndex((i: number) => {
        if (filteredCommands.length === 0) {
          return 0;
        }

        const newIndex = Math.min(filteredCommands.length - 1, i + 1);
        const sb = scrollRef.current;
        if (sb) {
          const viewportHeight = sb.viewport.height;
          const visibleEnd = sb.scrollTop + viewportHeight - 1;
          if (newIndex > visibleEnd) {
            sb.scrollTo(newIndex - viewportHeight + 1);
          }
        }
        return newIndex;
      });
    }
  });

  return {
    showCommandMenu,
    commandQuery,
    commands: filteredCommands,
    selectedIndex,
    scrollRef,
    handleContentChange,
    resolveCommand,
    setSelectedIndex,
  };
};
