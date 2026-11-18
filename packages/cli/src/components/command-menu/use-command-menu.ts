import { useRef, useState, useMemo, type RefObject } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { getFilteredCommands, getMenuCommands } from "./filter-commands";
import type { Command } from "./types";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { getStorage } from "../../lib/storage";
import { combineClaudeCommands, type ClaudeCommand } from "../../lib/claude-commands";
import { marcshPluginPath, readPluginCommands } from "../../lib/plugin";
import { bundledPiCommands } from "../../lib/engine/pi-commands";
import { loadCommandSet } from "../../lib/user-commands";
import { COMMAND_NAMES } from "./commands";

// Read when the menu opens, so a list cached by a turn or the startup warm-up that just ended shows up.
// The plugin's own commands are read from disk, so they are listed even with an empty cache. So are the user's: a file added since start is listed.
export function loadMenuCommands(engine: string, cwd: string, inSession: boolean): Command[] {
  const known = loadEngineCommands(engine);
  const { commands, hidden } = loadCommandSet({ cwd, builtinNames: COMMAND_NAMES, engineNames: known.map((command) => command.name) });
  return getMenuCommands(known, commands, inSession, hidden, engine);
}

/** The engine's commands as marcsh knows them: the list its last turn or warm-up cached, plus the bundled plugin's. */
export function loadEngineCommands(engine: string): ClaudeCommand[] {
  const pluginPath = marcshPluginPath();
  // Each engine has its own cache and its own names for the plugin's commands (on pi, `marcsh:feature` is a template).
  const bundled = !pluginPath ? [] : engine === "pi" ? bundledPiCommands(pluginPath) : readPluginCommands(pluginPath);
  try {
    return combineClaudeCommands(getStorage().getCommands(engine), bundled);
  } catch {
    return bundled;
  }
}

/** The engine's command names, which beat a pack's command of the same name (see `loadUserCommands`). */
export const engineCommandNames = (engine: string) => loadEngineCommands(engine).map((command) => command.name);

type UseCommandMenuReturn = {
  showCommandMenu: boolean;
  commandQuery: string;
  /** The commands matching the query, marcsh's own first. */
  commands: Command[];
  selectedIndex: number;
  /** The user moved the highlight with the arrows since the text last changed: Enter then runs the highlighted row (see `typedCommand`). */
  navigated: boolean;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  handleContentChange: (text: string) => void;
  resolveCommand: (index: number) => Command | undefined;
  /** Highlights a row the mouse is over; it does not count as navigating. */
  setSelectedIndex: (index: number) => void;
};

/**
 * The `/` menu of the engine the prompt runs on: its commands and the user's after marcsh's own. `cwd` is the project whose commands are listed.
 * `inSession` lists the commands on the open session too.
 */
export function useCommandMenu(engine: string, cwd: string = process.cwd(), inSession = false): UseCommandMenuReturn {
  const [textValue, setTextValue] = useState("");
  const [selectedIndex, setSelectedIndexState] = useState(0);
  const [navigated, setNavigated] = useState(false);
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
    setSelectedIndexState(0);
    setNavigated(false);

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

  // The mouse passing over a row only highlights it, and undoes an earlier arrow choice: Enter runs what was typed again. A stray move
  // must not change what Enter runs; the arrows and a click choose a row.
  const setSelectedIndex = (index: number) => {
    setSelectedIndexState(index);
    setNavigated(false);
  };

  // Resolve a command at a specific index (returns the command, caller handles execution)
  const resolveCommand = (index: number): Command | undefined => {
    const command = filteredCommands[index];
    if (command) {
      close();
    }
    return command;
  };

  // Arrow keys move the selection. Only a move that changed the highlight counts as choosing a row: Up on the first row moves
  // nothing, so Enter still runs what was typed. The menu (`CommandMenu`) keeps the highlighted row in view, header rows included.
  useKeyboard((key) => {
    if (!showCommandMenu || !isTopLayer("command")) return;

    if (key.name === "escape") {
      key.preventDefault();
      close();
    } else if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      const last = filteredCommands.length - 1;
      const up = key.name === "up";
      // From the latest index, not this render's: two presses can arrive before the next render. Setting `navigated` again is harmless.
      setSelectedIndexState((i: number) => {
        const next = last < 0 ? 0 : up ? Math.max(0, i - 1) : Math.min(last, i + 1);
        if (next !== i) setNavigated(true);
        return next;
      });
    }
  });

  return {
    showCommandMenu,
    commandQuery,
    commands: filteredCommands,
    selectedIndex,
    navigated,
    scrollRef,
    handleContentChange,
    resolveCommand,
    setSelectedIndex,
  };
};
