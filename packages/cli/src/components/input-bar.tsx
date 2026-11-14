import { readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { createContext, useContext, useMemo, useRef, useState, useCallback, useEffect, useLayoutEffect, type RefObject } from "react";

import { decodePasteBytes, stripAnsiSequences, TextAttributes } from "@opentui/core";

import type { TextareaRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { KeyBinding } from "@opentui/core";
import { useNavigate } from "react-router";
import { EmptyBorder } from "./border";
import { StatusBar } from "./status-bar";
import { CommandMenu } from "./command-menu";
import type { Command } from "./command-menu/types";
import { COMMANDS, COMMAND_NAMES } from "./command-menu/commands";
import { loadMenuCommands, useCommandMenu } from "./command-menu/use-command-menu";
import { CommandPalette } from "./command-palette";
import { SessionCommandsContext } from "./command-menu/session-commands";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { useDialog } from "../providers/dialog";
import { useToast } from "../providers/toast";
import { useTheme } from "../providers/theme";
import { usePromptConfig } from "../providers/prompt-config";
import { Mode } from "../lib/modes";
import { agentWarnings, type Agent } from "../lib/agents";
import type { EngineId } from "../lib/engine";
import type { ChatMessage, MessageAttachment } from "../lib/chat-types";
import { attachmentLabel, mentionFor, parsePastedPaths, resolvePastedAttachments } from "../lib/attachments";
import { slashInputKind } from "../lib/claude-commands";
import { warmUpEngineCommands } from "../lib/engine";
import { quitApp } from "../lib/quit";
import { formatBinding, isLeaderKey, leaderHint, loadKeybinds, resolveKey, takeKeybindWarnings, type KeyAction } from "../lib/keybinds";
import { appendHistory, keepDraft, readHistory, recallDraft } from "../lib/prompt-history";
import { attachInput, clearKeyActivity, handOffDraft, mergeGivenBack, noteKeyActivity, onGivenBack, setDraft, setInputTakesKeys, takeHandOffDraft } from "../lib/prompt-lock";

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
  /** `attachments`: the images and PDFs pasted since the last send (only on a screen that can send them, see `canAttach`). */
  onSubmit: (text: string, attachments?: MessageAttachment[]) => void;
  disabled?: boolean;
  /** Directory that `@` mentions resolve against. */
  cwd?: string;
  /** The engine the prompt runs on; defaults to the one new sessions start on. */
  engine?: string;
  /** Takes keys but never sends: Enter and the `/` commands do nothing, the text stays (the new-session screen, where there is no prompt yet). */
  typeOnly?: boolean;
  /** Keeps the unsent text under this key (a session's ID) when the input unmounts and restores it when an input with the same key mounts. */
  draftKey?: string;
  /** The session's messages: the status line shows the usage their replies reported. */
  messages?: ChatMessage[];
};

/**
 * Typing during a turn. `active` while the running turn takes input (a pi session): Enter then steers it through `steer`,
 * and Alt+Enter queues the text as a follow-up through `queue`. A terminal that cannot send Alt+Enter
 * (macOS Terminal without "Use Option as Meta key") has `/queue <text>` instead. Each returns false when the turn did not
 * take the text (it is over, or was interrupted): the text then stays in the input. `closed` once the turn has settled and
 * is only winding down: the input still takes keys, refuses to send, and says so. `starting` while a pi session is
 * starting (the model check, before the turn can take steers): the input takes keys, Enter, Alt+Enter and `/queue` keep the
 * text and do nothing yet, and the hint says so.
 */
export type TurnInput = { active: boolean; closed?: boolean; starting?: boolean; steer: (text: string) => boolean; queue: (text: string) => boolean };

export const TurnInputContext = createContext<TurnInput>({ active: false, steer: () => false, queue: () => false });

const QUEUE_COMMAND = /^\/queue\s+([\s\S]+)$/;

/** How long the leader key waits for the key that follows it. */
const LEADER_TIMEOUT_MS = 2000;

// Wordings of the hint, longest first: the status line shows the first that fits its width.
function turnHint(turnInput: TurnInput, disabled: boolean): string[] | undefined {
  if (turnInput.closed) return ["turn ending · no more steers", "turn ending"];
  if (turnInput.starting && !disabled) return ["turn starting · enter steers once it runs", "turn starting"];
  if (turnInput.active && !disabled) return ["enter steers · alt+enter queues", "enter steer · alt+enter queue", "↵ steer · alt+↵ queue", "enter steers"];
  return undefined;
}

export const TEXTAREA_KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "enter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "enter", shift: true, action: "newline" },
];

type HistoryWalk = {
  /** The prompts sent before, oldest first, read when the walk starts. */
  entries: string[];
  /** The entry on show; -1 when not walking. */
  index: number;
  /** What was typed before the walk started: Down past the newest entry brings it back. */
  draft: string;
  /** The text the walk put in the textarea: it is the walk's own, not typing. */
  shown: string | null;
};

const idleWalk = (): HistoryWalk => ({ entries: [], index: -1, draft: "", shown: null });

export function InputBar({ onSubmit, disabled = false, cwd = process.cwd(), engine, typeOnly = false, draftKey, messages }: Props) {
  const { agent, mode, cycleAgent, selectAgent, reloadAgents, setModel, defaultEngine, setDefaultEngine, piModel, setPiModel, refreshPiModel } = usePromptConfig();
  const engineId = engine ?? defaultEngine;
  const textareaRef = useRef<TextareaRenderable>(null);
  const onSubmitRef = useRef<() => void>(() => {});
  const activeMentionRef = useRef<MentionMatch | null>(null);
  const mentionScrollRef = useRef<ScrollBoxRenderable>(null);
  // What text the engine did not take put at the front of the input (see `mergeGivenBack`); forgotten once the input is empty.
  const givenBackRef = useRef("");
  const historyWalkRef = useRef<HistoryWalk>(idleWalk());
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;

  const renderer = useRenderer();
  const navigate = useNavigate();
  const dialog = useDialog();
  const toast = useToast();
  // What the commands on the open session act on; none on the home screen.
  const session = useContext(SessionCommandsContext);
  // The warnings take a moment to work out: one that arrives after the user moved to another agent is about an agent no longer in use.
  const agentIdRef = useRef(agent.id);
  agentIdRef.current = agent.id;
  // An agent the engine cannot fully apply still works: what it ignores is said once, when it is selected.
  const warnAboutAgent = useCallback(async (selected: Agent) => {
    const warnings = await agentWarnings(selected, engineId);
    if (warnings.length > 0 && agentIdRef.current === selected.id) toast.show({ variant: "info", message: `Warning: ${warnings.join("; ")}` });
  }, [engineId, toast]);
  const { colors } = useTheme();
  const { isTopLayer, push, pop, setResponder } = useKeyboardLayer();
  const turnInput = useContext(TurnInputContext);
  // Read once, when the first bar mounts; what was wrong in the file is said once, here, in a single toast.
  const keybinds = useMemo(() => loadKeybinds(COMMAND_NAMES), []);
  const runPaletteCommandRef = useRef<(command: Command) => void>(() => {});
  const leaderRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [leaderPending, setLeaderPending] = useState(false);

  useEffect(() => {
    const warnings = takeKeybindWarnings();
    if (warnings.length > 0) toast.show({ variant: "info", message: `Warning: ${warnings.join(" ")}`, duration: 8000 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the bar mounts
  }, []);

  const endLeader = useCallback(() => {
    if (leaderRef.current) clearTimeout(leaderRef.current);
    leaderRef.current = null;
    setLeaderPending(false);
  }, []);
  useEffect(() => endLeader, [endLeader]);

  // Images and PDFs whose paths were pasted: shown as chips above the text, sent with the next message. Other files become `@path` text.
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  // Only where a message can carry them (an open session); elsewhere a pasted path is just text.
  const canAttach = session !== null && !typeOnly;
  const pasteStateRef = useRef({ canAttach, disabled, isTopLayer, cwd });
  pasteStateRef.current = { canAttach, disabled, isTopLayer, cwd };

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
  } = useCommandMenu(engineId, cwd, session !== null);

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
    if (text.length === 0) givenBackRef.current = "";
    // The text of a history walk is not typing: the menus stay closed, so Up and Down keep walking. Any other change ends the walk.
    const walk = historyWalkRef.current;
    if (walk.shown !== null && text === walk.shown) return;
    historyWalkRef.current = idleWalk();
    handleContentChange(textarea.plainText);
    syncMentionMenu(text, textarea.cursorOffset);
  }, [handleContentChange, syncMentionMenu, renderer]);

  // A screen stays mounted a few ms after it navigates (the home screen after Enter, the new-session screen), and keys typed in that
  // gap land in its bar. Every bar hands the text it still holds over when it unmounts (a layout cleanup, while the textarea is still
  // there), and the next bar takes it on mount. A bar empties its textarea when it sends, so a sent message is never handed over.
  // A bar with a draft key keeps its text under that key instead (it belongs to that session, not to the next screen).
  useLayoutEffect(() => {
    return () => {
      if (draftKeyRef.current !== undefined) return;
      try {
        handOffDraft(renderer, textareaRef.current?.plainText ?? "");
      } catch {
        // The whole screen is going away (the renderer destroyed the textarea first): there is no next bar.
      }
    };
  }, [renderer]);

  // Takes the hand-off once, ahead of what the textarea already holds (keys that reached it first stay after the hand-off), and
  // leaves the cursor at the end.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const held = textarea.plainText;
    const text = (draftKey === undefined ? "" : recallDraft(draftKey)) + takeHandOffDraft(renderer) + held;
    if (text === held) return;
    textarea.setText(text);
    textarea.cursorOffset = text.length;
    setDraft(renderer, text.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the bar mounts
  }, []);

  // The unsent text of a keyed bar is kept when the bar unmounts, or when its key changes (the same bar moving to another session).
  useLayoutEffect(() => {
    if (draftKey === undefined) return;
    return () => {
      try {
        keepDraft(draftKey, textareaRef.current?.plainText ?? "");
      } catch {
        // The whole screen is going away (the renderer destroyed the textarea first): the text is lost with it.
      }
    };
  }, [draftKey]);

  // A bar that moves to another key shows that key's draft (the first run is the mount, which took it above).
  const shownDraftKeyRef = useRef(draftKey);
  useLayoutEffect(() => {
    if (shownDraftKeyRef.current === draftKey) return;
    shownDraftKeyRef.current = draftKey;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const text = draftKey === undefined ? "" : recallDraft(draftKey);
    historyWalkRef.current = idleWalk();
    textarea.setText(text);
    textarea.cursorOffset = text.length;
    setDraft(renderer, text.length > 0);
  }, [draftKey, renderer]);

  // A prompt that opens while the user is composing here opens locked (see prompt-lock). Keys can reach a new bar before this runs
  // (the hand-off from the home screen), so it takes the draft from the textarea and keeps the recent keys.
  useEffect(() => {
    return attachInput(renderer, (textareaRef.current?.plainText.length ?? 0) > 0);
  }, [renderer]);

  // A Claude session's input is off for the whole turn, so a draft it still holds (one carried over) is not the user composing and
  // must not lock the prompts that open then. A pi session's input takes keys whenever no prompt is open: its draft always counts.
  useEffect(() => {
    setInputTakesKeys(renderer, !disabled || engineId === "pi");
  }, [renderer, disabled, engineId]);

  // Text the engine did not take (a refused steer, a turn that ended before it was sent) comes back here, ahead of what is typed now.
  useEffect(() => {
    return onGivenBack(renderer, (returned) => {
      const textarea = textareaRef.current;
      if (!textarea) return false;
      const { text, block } = mergeGivenBack(returned, textarea.plainText, givenBackRef.current);
      textarea.setText(text);
      textarea.cursorOffset = text.length;
      givenBackRef.current = block;
      setDraft(renderer, true);
      return true;
    });
  }, [renderer]);

  // Terminals paste a dropped file as its path. A paste that is made of existing paths attaches them; the check is asynchronous, so the
  // paste is held back only when it looks like paths, and goes in as text if it turns out not to be (the same text the textarea would have taken).
  useEffect(() => {
    const onPaste = (event: { bytes: Uint8Array; preventDefault(): void }) => {
      const state = pasteStateRef.current;
      const textarea = textareaRef.current;
      if (!textarea || !state.canAttach || state.disabled || !state.isTopLayer("base")) return;
      const text = stripAnsiSequences(decodePasteBytes(event.bytes));
      if (!parsePastedPaths(text)) return;
      event.preventDefault();
      void resolvePastedAttachments(text, state.cwd)
        .catch(() => null)
        .then((found) => {
          if (!found) return void textarea.insertText(text);
          for (const problem of found.problems) toast.show({ variant: "error", message: problem });
          const chips = found.attachments.filter((attachment) => attachment.kind !== "file");
          const mentions = found.attachments.filter((attachment) => attachment.kind === "file").map((attachment) => `${mentionFor(attachment.path, state.cwd)} `);
          if (chips.length > 0) setAttachments((current) => [...current, ...chips]);
          if (mentions.length > 0) textarea.insertText(mentions.join(""));
        });
    };
    renderer.keyInput.on("paste", onPaste);
    return () => {
      renderer.keyInput.off("paste", onPaste);
    };
  }, [renderer, toast]);

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
    if (historyWalkRef.current.shown === textarea.plainText) return;

    syncMentionMenu(textarea.plainText, textarea.cursorOffset);
  }, [syncMentionMenu]);

  // `keepText`: the command was not typed (the palette, the leader), so the prompt holds the user's own text and is left alone.
  const handleCommand = useCallback((
    command: Command | undefined,
    args = "",
    keepText = false,
  ) => {
    const textarea = textareaRef.current;
    if (!textarea || !command) return;

    if (!keepText) textarea.setText("");

    if (command.action) {
      command.action({
        args,
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
        agentId: agent.id,
        reloadAgents,
        selectAgent: (id) => void warnAboutAgent(selectAgent(id)),
        setModel,
        session,
      });
    } else {
      textarea.insertText(command.value + " ");
    }
  }, [renderer, dialog, toast, engineId, cwd, defaultEngine, switchDefaultEngine, piModel, setPiModel, refreshPiModel, navigate, agent.id, reloadAgents, selectAgent, warnAboutAgent, setModel, session]);

  // The palette and the leader run a command the way a typed `/command` does. One that needs text after its name (`/rename`, a
  // custom or engine command) puts `/name ` in the prompt for the user to finish, which needs the prompt to be empty.
  const runPaletteCommand = useCallback((command: Command) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (command.action && !command.argumentHint) {
      handleCommand(command, "", true);
    } else if (textarea.plainText.length > 0) {
      toast.show({ variant: "info", message: `Clear the prompt, then pick /${command.name} again: it needs text after its name.` });
    } else {
      textarea.insertText(`${command.value} `);
    }
  }, [handleCommand, toast]);
  runPaletteCommandRef.current = runPaletteCommand;

  const openPalette = useCallback(() => {
    const keys: Record<string, string> = {};
    for (const [name, bindings] of Object.entries(keybinds.commands)) {
      if (bindings[0]) keys[name] = formatBinding(bindings[0], keybinds.leader);
    }
    dialog.open({
      title: "Command Palette",
      children: (
        <CommandPalette
          commands={loadMenuCommands(engineId, cwd, session !== null)}
          keys={keys}
          onSelect={(command) => {
            dialog.close();
            runPaletteCommandRef.current(command);
          }}
        />
      ),
    });
  }, [dialog, keybinds, engineId, cwd, session]);

  const runKeyAction = (action: KeyAction) => {
    if (action.action === "palette") openPalette();
    else runPaletteCommand(COMMANDS.find((command) => command.name === action.name)!);
  };

  const handleCommandExecute = useCallback(
    (index: number) => {
      if (typeOnly) return;
      const command = resolveCommand(index);
      handleCommand(command);
    },
    [resolveCommand, handleCommand, typeOnly],
  );

  // Up on the first line goes to an older prompt, Down on the last line to a newer one (the typed text is the newest). Returns
  // whether the key was used: elsewhere in the text the arrows move the cursor as usual.
  const walkHistory = useCallback((direction: "up" | "down"): boolean => {
    const textarea = textareaRef.current;
    if (!textarea) return false;
    const walk = historyWalkRef.current;

    const show = (text: string, cursor: "start" | "end") => {
      walk.shown = text;
      textarea.setText(text);
      textarea.cursorOffset = cursor === "start" ? 0 : text.length;
    };

    if (direction === "up") {
      if (textarea.visualCursor.visualRow > 0) return false;
      if (walk.index < 0) {
        const entries = readHistory().map((entry) => entry.text);
        if (entries.length === 0) return false;
        walk.entries = entries;
        walk.draft = textarea.plainText;
        walk.index = entries.length;
      }
      if (walk.index > 0) {
        walk.index -= 1;
        show(walk.entries[walk.index]!, "start");
      }
      return true;
    }

    if (walk.index < 0 || textarea.visualCursor.visualRow < textarea.virtualLineCount - 1) return false;
    walk.index += 1;
    if (walk.index < walk.entries.length) {
      show(walk.entries[walk.index]!, "end");
    } else {
      const draft = walk.draft;
      historyWalkRef.current = idleWalk();
      textarea.setText(draft);
      textarea.cursorOffset = draft.length;
    }
    return true;
  }, []);

  // A prompt the engine or a command took goes into the history, and ends any walk.
  const rememberPrompt = useCallback((text: string) => {
    historyWalkRef.current = idleWalk();
    appendHistory({ text, cwd });
  }, [cwd]);

  const handleSubmit = useCallback((queue = false) => {
    if (disabled || typeOnly) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    const text = textarea.plainText.trim();
    // Attachments alone make a message, but only one that starts a turn: a steer or a follow-up carries text only.
    if (text.length === 0 && (attachmentsRef.current.length === 0 || turnInput.active || turnInput.starting)) return;

    // While a turn takes input, `/queue <text>` queues like Alt+Enter does; before it can, the text stays where it is.
    const queuedByCommand = turnInput.active || turnInput.starting ? QUEUE_COMMAND.exec(text) : null;
    if (queuedByCommand) {
      if (!turnInput.starting && turnInput.queue(queuedByCommand[1]!.trim())) {
        rememberPrompt(text);
        clearKeyActivity(renderer);
        textarea.setText("");
      }
      return;
    }

    // marcsh's own commands win; any other /name (with or without arguments) goes to Claude Code verbatim
    const ownNames = COMMANDS.map((command) => command.name);
    if (slashInputKind(text, ownNames) === "marcsh") {
      const name = text.split(/\s/)[0]!;
      rememberPrompt(text);
      handleCommand(COMMANDS.find((command) => command.value === name), text.slice(name.length).trim());
      return;
    }

    // A session that is starting, or a turn that is over, takes nothing: the text stays in the input, to be sent once the turn ends.
    if (turnInput.starting) return;
    if (turnInput.active) {
      if (!(queue ? turnInput.queue(text) : turnInput.steer(text))) return;
      rememberPrompt(text);
      clearKeyActivity(renderer);
      textarea.setText("");
      return;
    }
    // The text is gone from the input before anything can navigate away: what the bar hands over on unmount is only what is typed after.
    const attached = attachmentsRef.current;
    if (text.length > 0) rememberPrompt(text);
    clearKeyActivity(renderer);
    textarea.setText("");
    if (attached.length === 0) return onSubmit(text);
    setAttachments([]);
    onSubmit(text, attached);
  }, [disabled, typeOnly, onSubmit, handleCommand, turnInput, renderer, rememberPrompt])

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
    if (disabled || typeOnly) return;

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
    // Backspace on an empty input takes the last attachment back.
    if (key.name === "backspace" && !key.ctrl && !key.meta && attachmentsRef.current.length > 0 && textareaRef.current?.plainText.length === 0) {
      key.preventDefault();
      setAttachments((current) => current.slice(0, -1));
      return;
    }
    // The palette and the leader work where a command can run: not on a screen that only takes keys. A key bound here is not typing.
    if (!typeOnly) {
      if (leaderRef.current) {
        // The key after the leader runs its command; any other key (Esc included) only ends the wait, and none is typed.
        endLeader();
        key.preventDefault();
        const hit = key.name === "escape" ? undefined : resolveKey(keybinds, key, true);
        if (hit) runKeyAction(hit);
        return;
      }
      if (isLeaderKey(keybinds, key)) {
        key.preventDefault();
        leaderRef.current = setTimeout(endLeader, LEADER_TIMEOUT_MS);
        setLeaderPending(true);
        return;
      }
      const hit = resolveKey(keybinds, key, false);
      if (hit) {
        key.preventDefault();
        runKeyAction(hit);
        return;
      }
    }
    // Keys typed here mean the user is composing; Enter sends, and Esc and Tab are not typing.
    const sends = (key.name === "return" || key.name === "enter") && !key.shift;
    if (!sends && key.name !== "escape" && key.name !== "tab") noteKeyActivity(renderer);
    if (key.name === "tab") {
      key.preventDefault();
      if (!typeOnly) void warnAboutAgent(cycleAgent());
    } else if (!typeOnly && (key.name === "up" || key.name === "down") && !key.shift && !key.ctrl && !key.meta && !key.option && !key.super && !key.hyper) {
      // Only here, on the base layer: while a menu is open, Up and Down belong to the menu.
      if (walkHistory(key.name)) key.preventDefault();
    } else if ((turnInput.active || turnInput.starting) && (key.name === "return" || key.name === "enter") && (key.meta || key.option) && !key.shift) {
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
      if (attachmentsRef.current.length > 0) {
        setAttachments([]);
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
          {attachments.length > 0 && <text attributes={TextAttributes.DIM}>{attachments.map(attachmentLabel).join(" ")}</text>}
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
          <StatusBar engine={engineId} messages={messages} cwd={cwd} hint={leaderPending ? leaderHint(keybinds) : turnHint(turnInput, disabled)} />
        </box>
      </box>
    </box>
  );
};