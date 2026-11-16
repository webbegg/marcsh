import { Fragment, useEffect, useRef, useState } from "react";
import { TextAttributes, type InputRenderable, type KeyBinding, type TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useDialog, type DialogContextValue } from "../../providers/dialog";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { useTheme } from "../../providers/theme";
import { useToast } from "../../providers/toast";
import { askQuestions, composeRequest, prefillFromArguments, readFacts, type Answers, type QuestionForm, type QuestionUi } from "../../lib/command-questions";
import { stripControlChars } from "../ui-prompts";

// The questions of a command (frontmatter `questions`): one dialog per question (a list to pick from, a line, or a multi-line editor), then
// a review of the composed request with Start, Edit answers and Cancel. Only Start sends. Esc anywhere closes the flow and sends nothing.
// The loop is `askQuestions` (lib/command-questions.ts); this file is its screen.

const START = "Start";
const EDIT = "Edit answers";
const CANCEL = "Cancel";
/** The review shows this many lines of the request; the rest is sent all the same. */
const REVIEW_LINES = 10;

/** What the flow asks next. */
type Prompt =
  | { kind: "select"; title: string; options: string[] }
  | { kind: "input"; title: string; placeholder: string }
  | { kind: "editor"; title: string; prefill: string }
  | { kind: "review"; request: string };

/** What the flow is waiting on right now. `answer` resolves the pending ask; `undefined` is Esc. */
type Step = Prompt & { key: number; answer: (value: string | undefined) => void };

const shown = (text: string) => stripControlChars(text);

function Heading({ text }: { text: string }) {
  return (
    <text wrapMode="word" width="100%" attributes={TextAttributes.BOLD}>
      {shown(text)}
    </text>
  );
}

/** A list of rows to pick one from: ↑↓ move, Enter picks, 1-9 pick by number. */
function Rows({ options, onPick, hint }: { options: string[]; onPick: (value: string) => void; hint: string }) {
  const { isTopLayer } = useKeyboardLayer();
  const { colors } = useTheme();
  const [selected, setSelected] = useState(0);

  useKeyboard((key) => {
    if (!isTopLayer("dialog")) return;
    if (key.name === "up") setSelected((index) => Math.max(0, index - 1));
    else if (key.name === "down") setSelected((index) => Math.min(options.length - 1, index + 1));
    else if (key.name === "return" || key.name === "enter") onPick(options[selected]!);
    else if (/^[1-9]$/.test(key.name) && !key.ctrl && !key.meta && Number(key.name) <= options.length) onPick(options[Number(key.name) - 1]!);
  });

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="column">
        {options.map((option, index) => (
          <box
            key={`${index}-${option}`}
            flexDirection="row"
            minHeight={1}
            backgroundColor={index === selected ? colors.selection : undefined}
            onMouseMove={() => setSelected(index)}
            onMouseDown={() => onPick(option)}
          >
            <text selectable={false} fg={index === selected ? "black" : "white"} wrapMode="word">
              {`${index < 9 ? `${index + 1} ` : "  "}${shown(option)}`}
            </text>
          </box>
        ))}
      </box>
      <text attributes={TextAttributes.DIM}>{hint}</text>
    </box>
  );
}

function InputStep({ title, placeholder, onAnswer }: { title: string; placeholder: string; onAnswer: (value: string) => void }) {
  const inputRef = useRef<InputRenderable>(null);
  const { isTopLayer } = useKeyboardLayer();

  useKeyboard((key) => {
    if (!isTopLayer("dialog") || (key.name !== "return" && key.name !== "enter")) return;
    onAnswer(inputRef.current?.value ?? "");
  });

  return (
    <box flexDirection="column" gap={1}>
      <Heading text={title} />
      <input ref={inputRef} focused placeholder={shown(placeholder)} />
      <text attributes={TextAttributes.DIM}>{placeholder ? "enter submits (empty keeps the text shown) · esc cancels" : "enter submits · esc cancels"}</text>
    </box>
  );
}

// Enter submits and Shift+Enter adds a line, as in the main input.
const EDITOR_KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "enter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "enter", shift: true, action: "newline" },
];

function EditorStep({ title, prefill, onAnswer }: { title: string; prefill: string; onAnswer: (value: string) => void }) {
  const editorRef = useRef<TextareaRenderable>(null);
  const { isTopLayer } = useKeyboardLayer();
  const text = shown(prefill);

  // Typing continues after the prefill.
  useEffect(() => {
    if (editorRef.current) editorRef.current.cursorOffset = text.length;
  }, [text]);

  useKeyboard((key) => {
    if (!isTopLayer("dialog") || key.ctrl || key.meta || key.shift) return;
    if (key.name === "return" || key.name === "enter") onAnswer(editorRef.current?.plainText ?? text);
  });

  return (
    <box flexDirection="column" gap={1}>
      <Heading text={title} />
      <textarea ref={editorRef} initialValue={text} keyBindings={EDITOR_KEY_BINDINGS} focused minHeight={3} />
      <text attributes={TextAttributes.DIM}>enter submits · shift+enter adds a line · esc cancels</text>
    </box>
  );
}

function ReviewStep({ request, onAnswer }: { request: string; onAnswer: (value: string) => void }) {
  const lines = request.split("\n");
  const more = lines.length - REVIEW_LINES;
  return (
    <box flexDirection="column" gap={1}>
      <Heading text="Send this request?" />
      <box flexDirection="column">
        {lines.slice(0, REVIEW_LINES).map((line, index) => (
          <text key={index} wrapMode="word" width="100%" attributes={TextAttributes.DIM}>
            {shown(line) || " "}
          </text>
        ))}
        {more > 0 ? <text attributes={TextAttributes.DIM}>{`… ${more} more line${more === 1 ? "" : "s"}, all sent`}</text> : null}
      </box>
      <Rows options={[START, EDIT, CANCEL]} onPick={onAnswer} hint="↑↓ choose · enter confirm · esc cancel" />
    </box>
  );
}

let stepKey = 0;

function Flow({ form, cwd, onStart }: { form: QuestionForm & { args: string }; cwd: string; onStart: (text: string) => void }) {
  const dialog = useDialog();
  const toast = useToast();
  const [step, setStep] = useState<Step | null>(null);
  // The flow lives in the callbacks below; the latest of them is read, so a re-render never restarts it.
  const latest = useRef({ dialog, toast, onStart });
  latest.current = { dialog, toast, onStart };

  useEffect(() => {
    let live = true;
    let cancelPending: (() => void) | undefined;
    const ask = (prompt: Prompt) =>
      new Promise<string | undefined>((resolve) => {
        if (!live) return resolve(undefined);
        cancelPending = () => resolve(undefined);
        setStep({ ...prompt, answer: resolve, key: ++stepKey });
      });
    const ui: QuestionUi = {
      select: (title, options) => ask({ kind: "select", title, options }),
      input: (title, placeholder) => ask({ kind: "input", title, placeholder: placeholder ?? "" }),
      editor: (title, prefill) => ask({ kind: "editor", title, prefill: prefill ?? "" }),
    };

    void (async () => {
      const facts = readFacts(cwd);
      let answers: Answers | undefined = await askQuestions(form, facts, ui, { presets: prefillFromArguments(form.questions, form.args) });
      while (live && answers) {
        let request: string;
        try {
          request = composeRequest(form, answers, facts, form.args);
        } catch (error) {
          latest.current.toast.show({ variant: "error", message: `/${form.name}: ${error instanceof Error ? error.message : String(error)}; nothing was sent.` });
          break;
        }
        const choice = await ask({ kind: "review", request });
        if (!live) return;
        if (choice === START) {
          latest.current.dialog.close();
          latest.current.onStart(request);
          return;
        }
        if (choice !== EDIT) break;
        answers = await askQuestions(form, facts, ui, { current: answers });
      }
      // Cancelled (Esc closed the dialog already, so only a flow that is still showing closes it).
      if (live) latest.current.dialog.close();
    })();

    return () => {
      live = false;
      cancelPending?.();
    };
    // One run per flow: it is opened with its own form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!step) return null;
  const answer = step.answer;
  return (
    <Fragment key={step.key}>
      {step.kind === "select" && (
        <box flexDirection="column" gap={1}>
          <Heading text={step.title} />
          <Rows options={step.options} onPick={answer} hint="↑↓ choose · enter pick · 1-9 quick pick · esc cancels" />
        </box>
      )}
      {step.kind === "input" && <InputStep title={step.title} placeholder={step.placeholder} onAnswer={answer} />}
      {step.kind === "editor" && <EditorStep title={step.title} prefill={step.prefill} onAnswer={answer} />}
      {step.kind === "review" && <ReviewStep request={step.request} onAnswer={answer} />}
    </Fragment>
  );
}

let flowKey = 0;

/**
 * Opens the questions of `form` as a dialog. `onStart` gets the composed request when the user chooses Start; it is never called when the
 * flow is cancelled (Esc, Cancel, a required answer left empty twice). `cwd` is where the facts (branches, test script) are read.
 */
export function openCommandQuestions(dialog: DialogContextValue, { form, cwd, onStart }: { form: QuestionForm & { args: string }; cwd: string; onStart: (text: string) => void }) {
  // A key of its own: a flow opened over another flow's dialog is a new one, not an update of it.
  dialog.open({ title: shown(`/${form.name}`), children: <Flow key={++flowKey} form={form} cwd={cwd} onStart={onStart} /> });
}
