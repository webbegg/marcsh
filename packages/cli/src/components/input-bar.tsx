import { readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { createContext, useContext, useRef, useState, useCallback, useEffect, type RefObject } from "react";

import { TextAttributes } from "@opentui/core";

import type { TextareaRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { KeyBinding } from "@opentui/core";
import { useNavigate } from "react-router";
import { EmptyBorder } from "./border";
import { StatusBar } from "./status-bar";
import { CommandMenu } from "./command-menu";
import type { Command } from "./command-menu/types";
import { COMMANDS } from "./command-menu/commands";
import { useCommandMenu } from "./command-menu/use-command-menu";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { useDialog } from "../providers/dialog";
import { useToast } from "../providers/toast";
import { useTheme } from "../providers/theme";
import { usePromptConfig } from "../providers/prompt-config";
import { Mode } from "../lib/modes";
import type { EngineId } from "../lib/engine";
import { slashInputKind } from "../lib/claude-commands";
import { warmUpEngineCommands } from "../lib/engine";
import { quitApp } from "../lib/quit";
import { clearKeyActivity, noteKeyActivity, setDraft } from "../lib/prompt-lock";

const MAX_VISIBLE_MENTIONS = 8;
const MAX_FALLBACK_MENTION_CANDIDATES = 32;
const MENTION_QUERY_CHARACTER = /[A-Za-z0-9._/-]/;
const RECURSIVE_MENTION_IGNORED_DIRECTORIES = new Set(["node_modules"]);

type MentionMatch = {
  start: number;
  end: number;
  query: string;
};

type MentionCandidate = {
  path: string;
  kind: "file" | "directory";
};

function isWithinDirectory(directory: string, targetPath: string) {
  const relativePath = relative(directory, targetPath);
  return relativePath === "" 
    || (!relativePath.startsWith("..") 
    && !isAbsolute(relativePath));
}

function isMentionQueryCharacter(character: string) {
  return MENTION_QUERY_CHARACTER.test(character);
}

function findActiveMention(text: string, cursorOffset: number): MentionMatch | null {
  const safeOffset = Math.max(0, Math.min(cursorOffset, text.length));

  let start = safeOffset;
  while (start > 0 && !/\s/.test(text[start - 1]!)) {
    start -= 1;
  }

  let end = safeOffset;
  while (end < text.length && !/\s/.test(text[end]!)) {
    end += 1;
  }

  const token = text.slice(start, end);
  const relativeCursor = safeOffset - start;
  const mentionStart = token.lastIndexOf("@", relativeCursor);

  if (mentionStart === -1) {
    return null;
  }

  const previousCharacter = token[mentionStart - 1];
  if (previousCharacter && isMentionQueryCharacter(previousCharacter)) {
    return null;
  }

  let mentionEnd = mentionStart + 1;
  while (mentionEnd < token.length && isMentionQueryCharacter(token[mentionEnd]!)) {
    mentionEnd += 1;
  }

  if (relativeCursor < mentionStart || relativeCursor > mentionEnd) {
    return null;
  }

  return {
    start: start + mentionStart,
    end: start + mentionEnd,
    query: token.slice(mentionStart + 1, mentionEnd),
  };
}

async function getMentionCandidates(query: string, cwd: string): Promise<MentionCandidate[]> {
  const normalizedQuery = query.startsWith("./") ? query.slice(2) : query;
  if (normalizedQuery.startsWith("/")) {
    return [];
  }

  const hasTrailingSlash = normalizedQuery.endsWith("/");
  const lastSlashIndex = hasTrailingSlash
    ? normalizedQuery.length - 1
    : normalizedQuery.lastIndexOf("/");

  const directoryPart = hasTrailingSlash
    ? normalizedQuery.slice(0, -1)
    : lastSlashIndex === -1
      ? ""
      : normalizedQuery.slice(0, lastSlashIndex);

  const namePrefix = hasTrailingSlash
    ? ""
    : lastSlashIndex === -1
      ? normalizedQuery
      : normalizedQuery.slice(lastSlashIndex + 1);

  const absoluteDirectory = resolve(cwd, directoryPart || ".");
  if (!isWithinDirectory(cwd, absoluteDirectory)) {
    return [];
  }

  try {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    const lowercasePrefix = namePrefix.toLowerCase();
    const showHiddenEntries = namePrefix.startsWith(".");

    const directMatches = entries
      .filter((entry) => showHiddenEntries || !entry.name.startsWith("."))
      .filter((entry) => {
        return lowercasePrefix === "" || entry.name.toLowerCase().startsWith(lowercasePrefix);
      })
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      })
      .map((entry) => {
        const path = directoryPart ? `${directoryPart}/${entry.name}` : entry.name;
        const kind: MentionCandidate["kind"] = entry.isDirectory() ? "directory" : "file";
        return {
          path: kind === "directory" ? `${path}/` : path,
          kind,
        };
      });

    if (directMatches.length > 0 || directoryPart !== "" || namePrefix === "") {
      return directMatches;
    }

    const fallbackMatches: MentionCandidate[] = [];
    const visit = async (
      absoluteDirectory: string, 
      directoryPart: string
    ): Promise<void> => {
      const entries = await readdir(absoluteDirectory, { withFileTypes: true });

      for (const entry of entries) {
        if (!showHiddenEntries && entry.name.startsWith(".")) {
          continue;
        }

        if (
          entry.isDirectory() 
          && RECURSIVE_MENTION_IGNORED_DIRECTORIES.has(entry.name)
        ) {
          continue;
        }

        const path = directoryPart ? `${directoryPart}/${entry.name}` : entry.name;
        const kind: MentionCandidate["kind"] = 
          entry.isDirectory() ? "directory" : "file";

        if (entry.name.toLowerCase().startsWith(lowercasePrefix)) {
          fallbackMatches.push({
            path: kind === "directory" ? `${path}/` : path,
            kind,
          });
          if (fallbackMatches.length >= MAX_FALLBACK_MENTION_CANDIDATES) {
            return;
          }
        }

        if (entry.isDirectory()) {
          await visit(resolve(absoluteDirectory, entry.name), path);
          if (fallbackMatches.length >= MAX_FALLBACK_MENTION_CANDIDATES) {
            return;
          }
        }
      }
    };

    await visit(cwd, "");
    return fallbackMatches.sort((left, right) => left.path.localeCompare(right.path));
  } catch {
    return [];
  }
}

type FileMentionMenuProps = {
  candidates: MentionCandidate[];
  selectedIndex: number;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  onSelect: (index: number) => void;
  onExecute: (index: number) => void;
};

function FileMentionMenu({
  candidates,
  selectedIndex,
  scrollRef,
  onSelect,
  onExecute,
}: FileMentionMenuProps) {
  const { colors } = useTheme();
  const visibleHeight = Math.min(candidates.length, MAX_VISIBLE_MENTIONS);

  if (candidates.length === 0) {
    return (
      <box paddingX={1}>
        <text attributes={TextAttributes.DIM}>No matching files or folders</text>
      </box>
    );
  }

  return (
    <scrollbox ref={scrollRef} height={visibleHeight}>
      {candidates.map((candidate, index) => {
        const isSelected = index === selectedIndex;

        return (
          <box
            key={candidate.path}
            flexDirection="row"
            paddingX={1}
            height={1}
            overflow="hidden"
            backgroundColor={isSelected ? colors.selection : undefined}
            onMouseMove={() => onSelect(index)}
            onMouseDown={() => onExecute(index)}
          >
            <box flexGrow={1} flexShrink={1} overflow="hidden">
              <text selectable={false} fg={isSelected ? "black" : "white"}>
                {candidate.path}
              </text>
            </box>

            <box width={8} alignItems="flex-end" flexShrink={0}>
              <text selectable={false} fg={isSelected ? "black" : "gray"}>
                {candidate.kind === "directory" ? "Folder" : "File"}
              </text>
            </box>
          </box>
        );
      })}
    </scrollbox>
  );
};

type Props = {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  /** Directory that `@` mentions resolve against. */
  cwd?: string;
  /** The engine the prompt runs on; defaults to the one new sessions start on. */
  engine?: string;
};

/**
 * Typing during a turn. `active` while the running turn takes input (a pi session): Enter then steers it through `steer`,
 * and Alt+Enter queues the text as a follow-up through `queue`. A terminal that cannot send Alt+Enter
 * (macOS Terminal without "Use Option as Meta key") has `/queue <text>` instead. Each returns false when the turn did not
 * take the text (it is over, or was interrupted): the text then stays in the input. `closed` once the turn has settled and
 * is only winding down: the input is off and says so.
 */
export type TurnInput = { active: boolean; closed?: boolean; steer: (text: string) => boolean; queue: (text: string) => boolean };

export const TurnInputContext = createContext<TurnInput>({ active: false, steer: () => false, queue: () => false });

const QUEUE_COMMAND = /^\/queue\s+([\s\S]+)$/;

function turnHint(turnInput: TurnInput, disabled: boolean): string | undefined {
  if (turnInput.active && !disabled) return "enter steers · alt+enter queues";
  if (turnInput.closed) return "turn ending · no more steers";
  return undefined;
}

export const TEXTAREA_KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "enter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "enter", shift: true, action: "newline" },
];

export function InputBar({ onSubmit, disabled = false, cwd = process.cwd(), engine }: Props) {
  const { mode, toggleMode, setMode, setModel, defaultEngine, setDefaultEngine, piModel, setPiModel, refreshPiModel } = usePromptConfig();
  const engineId = engine ?? defaultEngine;
  const textareaRef = useRef<TextareaRenderable>(null);
  const onSubmitRef = useRef<() => void>(() => {});
  const activeMentionRef = useRef<MentionMatch | null>(null);
  const mentionScrollRef = useRef<ScrollBoxRenderable>(null);

  const renderer = useRenderer();
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  const { colors } = useTheme();
  const { isTopLayer, push, pop, setResponder } = useKeyboardLayer();
  const turnInput = useContext(TurnInputContext);

  const [activeMention, setActiveMention] = useState<MentionMatch | null>(null);
  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>([]);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);

  // The `/` menu of a new default engine should not be empty: pi's commands are listed ahead of its first session.
  const switchDefaultEngine = useCallback(
    (next: EngineId) => {
      setDefaultEngine(next);
      if (next === "pi") void warmUpEngineCommands("pi", { cwd });
    },
    [setDefaultEngine, cwd],
  );

  const {
    showCommandMenu,
    commands,
    selectedIndex,
    scrollRef,
    handleContentChange,
    resolveCommand,
    setSelectedIndex,
  } = useCommandMenu(engineId);

  const showMentionMenu = activeMention !== null;

  const closeMentionMenu = useCallback(() => {
    activeMentionRef.current = null;
    setActiveMention(null);
    setMentionCandidates([]);
    pop("mention");
  }, [pop]);

  const syncMentionMenu = useCallback((text: string, cursorOffset: number) => {
    const nextMention = findActiveMention(text, cursorOffset);
    const previousMention = activeMentionRef.current;
    const mentionChanged =
      previousMention?.start !== nextMention?.start ||
      previousMention?.end !== nextMention?.end ||
      previousMention?.query !== nextMention?.query;

    if (!nextMention) {
      if (previousMention) {
        closeMentionMenu();
      }
      return;
    }

    activeMentionRef.current = nextMention;
    setActiveMention(nextMention);
    push("mention", () => {
      closeMentionMenu();
      return true;
    });

    if (mentionChanged) {
      setMentionSelectedIndex(0);
      mentionScrollRef.current?.scrollTo(0);
    }
  }, [closeMentionMenu, push]);

  const handleTextareaContentChange = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const text = textarea.plainText;

    setDraft(renderer, text.length > 0);
    handleContentChange(textarea.plainText);
    syncMentionMenu(text, textarea.cursorOffset);
  }, [handleContentChange, syncMentionMenu, renderer]);

  // A prompt that opens while the user is composing here opens locked (see prompt-lock); a new bar starts with nothing typed.
  useEffect(() => {
    setDraft(renderer, false);
    clearKeyActivity(renderer);
    return () => {
      setDraft(renderer, false);
      clearKeyActivity(renderer);
    };
  }, [renderer]);

  // A disabled bar must not leave a menu layer on top of the base layer (it would swallow approval keys).
  useEffect(() => {
    if (!disabled) return;

    if (activeMentionRef.current) closeMentionMenu();
    if (showCommandMenu) textareaRef.current?.setText("");
  }, [disabled, showCommandMenu, closeMentionMenu]);

  const handleMentionExecute = useCallback((index: number) => {
    const textarea = textareaRef.current;
    const mention = activeMentionRef.current;
    const candidate = mentionCandidates[index];

    if (!textarea || !mention || !candidate) return;

    const insertion = candidate.kind === "directory" 
      ? candidate.path 
      : `${candidate.path} `;

    const nextText = `${textarea.plainText.slice(0, mention.start)}@${insertion}${textarea.plainText.slice(mention.end)}`;

    textarea.replaceText(nextText);
    textarea.cursorOffset = mention.start + insertion.length + 1;
    syncMentionMenu(nextText, textarea.cursorOffset);
  }, [mentionCandidates, syncMentionMenu]);

  const handleTextareaCursorChange = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    syncMentionMenu(textarea.plainText, textarea.cursorOffset);
  }, [syncMentionMenu]);

  const handleCommand = useCallback((
    command: Command | undefined
  ) => {
    const textarea = textareaRef.current;
    if (!textarea || !command) return;

    textarea.setText("");

    if (command.action) {
      command.action({
        exit: () => void quitApp(renderer),
        dialog,
        toast,
        engine: engineId,
        cwd,
        defaultEngine,
        setDefaultEngine: switchDefaultEngine,
        piModel,
        setPiModel,
        refreshPiModel,
        navigate,
        mode,
        setMode,
        setModel,
      });
    } else {
      textarea.insertText(command.value + " ");
    }
  }, [renderer, dialog, toast, engineId, cwd, defaultEngine, switchDefaultEngine, piModel, setPiModel, refreshPiModel, navigate, mode, setMode, setModel]);

  const handleCommandExecute = useCallback(
    (index: number) => {
      const command = resolveCommand(index);
      handleCommand(command);
    },
    [resolveCommand, handleCommand],
  );

  const handleSubmit = useCallback((queue = false) => {
    if (disabled) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    const text = textarea.plainText.trim();
    if (text.length === 0) return;

    // While a turn takes input, `/queue <text>` queues like Alt+Enter does.
    const queuedByCommand = turnInput.active ? QUEUE_COMMAND.exec(text) : null;
    if (queuedByCommand) {
      if (turnInput.queue(queuedByCommand[1]!.trim())) {
        clearKeyActivity(renderer);
        textarea.setText("");
      }
      return;
    }

    // marcsh's own commands win; any other /name (with or without arguments) goes to Claude Code verbatim
    const ownNames = COMMANDS.map((command) => command.name);
    if (slashInputKind(text, ownNames) === "marcsh") {
      handleCommand(COMMANDS.find((command) => command.value === text.split(/\s/)[0]));
      return;
    }

    // A turn that is over takes nothing: the text stays in the input, to be sent once the turn ends.
    if (turnInput.active && !(queue ? turnInput.queue(text) : turnInput.steer(text))) return;
    if (!turnInput.active) onSubmit(text);
    clearKeyActivity(renderer);
    textarea.setText("");
  }, [disabled, onSubmit, handleCommand, turnInput, renderer])

  // Keep the file picker in sync with the current @mention token.
  useEffect(() => {
    if (!activeMention) {
      setMentionCandidates([]);
      return;
    }

    let ignore = false;
    const loadCandidates = async () => {
      const nextCandidates = await getMentionCandidates(activeMention.query, cwd);
      if (ignore) return;

      setMentionCandidates(nextCandidates);
      setMentionSelectedIndex((currentIndex) => {
        if (nextCandidates.length === 0) {
          return 0;
        }
        return Math.min(currentIndex, nextCandidates.length - 1);
      });
    };

    void loadCandidates();

    return () => {
      ignore = true;
    };
  }, [activeMention, cwd]);

  // Wire up textarea submit handler once so it always reads the latest state.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.onSubmit = () => {
      onSubmitRef.current();
    };
  }, []);

  onSubmitRef.current = () => {
    if (disabled) return;

    if (showCommandMenu) {
      const command = resolveCommand(selectedIndex);
      if (command) {
        handleCommand(command);
        return;
      }
      // No command matches (e.g. `/probe:hello` not in the list): submit the text as typed
    } else if (showMentionMenu) {
      const candidate = mentionCandidates[mentionSelectedIndex];
      if (candidate) {
        handleMentionExecute(mentionSelectedIndex);
        return;
      }
    }

    handleSubmit();
  };

  useKeyboard((key) => {
    if (disabled) return;
    if (!isTopLayer("base")) return;
    // Keys typed here mean the user is composing; Enter sends, and Esc and Tab are not typing.
    const sends = (key.name === "return" || key.name === "enter") && !key.shift;
    if (!sends && key.name !== "escape" && key.name !== "tab") noteKeyActivity(renderer);
    if (key.name === "tab") {
      key.preventDefault();
      toggleMode();
    } else if (turnInput.active && (key.name === "return" || key.name === "enter") && (key.meta || key.option) && !key.shift) {
      key.preventDefault();
      handleSubmit(true);
    }
  });

  // Register the base layer responder for ctrl+c dismissal
  useEffect(() => {
    setResponder("base", () => {
      if (disabled) return false;

      const textarea = textareaRef.current;
      if (textarea && textarea.plainText.length > 0) {
        textarea.setText("");
        return true;
      }
      return false;
    });

    return () => setResponder("base", null);
  }, [disabled, setResponder]);

  useKeyboard((key) => {
    if (disabled) return;
    if (!showMentionMenu || !isTopLayer("mention")) return;

    if (key.name === "escape") {
      key.preventDefault();
      closeMentionMenu();
    } else if (key.name === "up") {
      key.preventDefault();
      setMentionSelectedIndex((currentIndex) => {
        const nextIndex = Math.max(0, currentIndex - 1);
        const scrollbox = mentionScrollRef.current;
        if (scrollbox && nextIndex < scrollbox.scrollTop) {
          scrollbox.scrollTo(nextIndex);
        }
        return nextIndex;
      });
    } else if (key.name === "down") {
      key.preventDefault();
      setMentionSelectedIndex((currentIndex) => {
        if (mentionCandidates.length === 0) {
          return 0;
        }

        const nextIndex = Math.min(mentionCandidates.length - 1, currentIndex + 1);
        const scrollbox = mentionScrollRef.current;

        if (scrollbox) {
          const viewportHeight = scrollbox.viewport.height;
          const visibleEnd = scrollbox.scrollTop + viewportHeight - 1;
          if (nextIndex > visibleEnd) {
            scrollbox.scrollTo(nextIndex - viewportHeight + 1);
          }
        }

        return nextIndex;
      });
    }
  });

  return (
    <box width="100%" alignItems="center">
      <box
        border={["left"]}
        borderColor={mode === Mode.BUILD ? colors.primary : colors.planMode}
        customBorderChars={{
          ...EmptyBorder,
          vertical: "┃",
          bottomLeft: "╹",
        }}
        width="100%"
      >
        <box
          position="relative"
          justifyContent="center"
          paddingX={2}
          paddingY={1}
          backgroundColor={colors.surface}
          width="100%"
          gap={1}
        >
          {showCommandMenu && (
            <box
              position="absolute"
              bottom="100%"
              left={0}
              width="100%"
              backgroundColor={colors.surface}
              zIndex={10}
            >
              <CommandMenu
                commands={commands}
                selectedIndex={selectedIndex}
                scrollRef={scrollRef}
                onSelect={setSelectedIndex}
                onExecute={handleCommandExecute}
              />
            </box>
          )}
          {!showCommandMenu && showMentionMenu && (
            <box
              position="absolute"
              bottom="100%"
              left={0}
              width="100%"
              backgroundColor={colors.surface}
              zIndex={10}
            >
              <FileMentionMenu
                candidates={mentionCandidates}
                selectedIndex={mentionSelectedIndex}
                scrollRef={mentionScrollRef}
                onSelect={setMentionSelectedIndex}
                onExecute={handleMentionExecute}
              />
            </box>
          )}
          <textarea
            ref={textareaRef}
            focused={
              !disabled && 
              (isTopLayer("base") || isTopLayer("command") || isTopLayer("mention"))
            }
            keyBindings={TEXTAREA_KEY_BINDINGS}
            onContentChange={handleTextareaContentChange}
            placeholder={`Ask anything... "Fix a bug in the database"`}
          />
          <StatusBar engine={engineId} hint={turnHint(turnInput, disabled)} />
        </box>
      </box>
    </box>
  );
};