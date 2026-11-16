import { readFileSync } from "node:fs";
import { join } from "node:path";
import { currentBranch, gitSucceeds, originDefaultBranch } from "./git-branch";

// Questions of a command: a command file whose frontmatter has `questions` asks them (one dialog each), shows the request it composed,
// and sends it only on Start. The format and the composing follow brigadev's workflows. Pure, apart from the facts, which read local git
// and package.json (never the network).

export type QuestionKind = "text" | "long" | "choice";

/** Values the session can look up locally; a question default may embed them as `{{name}}`. */
export const FACT_NAMES = ["currentBranch", "defaultBranch", "testScript"] as const;

export type CommandQuestion = {
  id: string;
  label: string;
  kind: QuestionKind;
  required: boolean;
  /** Literal text, optionally with `{{fact}}` placeholders; dropped when a fact is unknown. */
  default?: string;
  /** The choices of a `choice` question. */
  options?: string[];
};

/** What a command needs to be asked and composed: its name (for messages), its prompt with the `{{id}}` placeholders, and its questions. */
export type QuestionForm = { name: string; template: string; questions: CommandQuestion[] };

/** Answers by question id; skipped questions are absent. */
export type Answers = Record<string, string>;

/** What the session can find locally; absent or null when unknown. */
export type QuestionFacts = {
  currentBranch?: string | null;
  defaultBranch?: string | null;
  testScript?: string | null;
};

const QUESTION_KINDS: readonly string[] = ["text", "long", "choice"];
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

const placeholders = (text: string): string[] => [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!.trim());

function parseQuestion(raw: unknown, index: number): CommandQuestion {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`question ${index + 1} is not a map`);
  const { id, label, kind, required, default: fallback, options } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error(`question ${index + 1} needs an id of lowercase letters, digits, and dashes`);
  if (typeof label !== "string" || !label.trim()) throw new Error(`question "${id}" needs a label`);
  if (typeof kind !== "string" || !QUESTION_KINDS.includes(kind)) throw new Error(`question "${id}" has kind ${JSON.stringify(kind)}; use text, long, or choice`);
  if (fallback !== undefined && fallback !== null && typeof fallback !== "string") throw new Error(`question "${id}" default must be text`);
  const preset = typeof fallback === "string" ? fallback : undefined;
  for (const fact of placeholders(preset ?? "")) {
    if (!(FACT_NAMES as readonly string[]).includes(fact)) throw new Error(`question "${id}" default uses unknown fact "${fact}"`);
  }
  const question: CommandQuestion = { id, label: label.trim(), kind: kind as QuestionKind, required: required === true };
  if (kind === "choice") {
    const choices = Array.isArray(options) ? options.filter((option): option is string => typeof option === "string" && option.trim() !== "") : [];
    if (choices.length < 2) throw new Error(`question "${id}" is a choice and needs at least two options`);
    if (preset !== undefined && !choices.includes(preset)) throw new Error(`question "${id}" default must be one of its options`);
    question.options = choices;
  }
  if (preset !== undefined) question.default = preset;
  return question;
}

/**
 * The `questions` block of a file's frontmatter as text (the key line and the lines under it), or null when the file has none. Only this
 * block is read as YAML: the rest of the frontmatter is read by the flat reader (agent-file.ts), which accepts lines YAML would not.
 */
function questionsBlock(text: string): string | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return null;
  const start = lines.findIndex((line, index) => index > 0 && index < end && /^questions[ \t]*:/.test(line));
  if (start < 0) return null;
  const block = [lines[start]!];
  // The block ends at the next top-level key: a line that starts with a name. List items, indented lines, comments and blanks belong to it.
  for (let index = start + 1; index < end && !/^[^\s#-]/.test(lines[index]!); index++) block.push(lines[index]!);
  return block.join("\n");
}

/**
 * The questions of a command file (its whole text) whose prompt is `template`: `{ questions }` (none for an empty `questions:`), `{ error }`
 * saying what is wrong (a command with that is never run), or null when the frontmatter has no `questions` key.
 */
export function readQuestions(fileText: string, template: string): { questions: CommandQuestion[] } | { error: string } | null {
  const block = questionsBlock(fileText);
  if (block === null) return null;
  let raw: unknown;
  try {
    raw = (Bun.YAML.parse(block) as { questions?: unknown } | null)?.questions;
  } catch {
    return { error: "questions is not valid YAML" };
  }
  try {
    if (raw === undefined || raw === null) raw = [];
    if (!Array.isArray(raw)) throw new Error("questions must be a list");
    const questions = raw.map(parseQuestion);
    const ids = new Set<string>();
    for (const { id } of questions) {
      if (ids.has(id)) throw new Error(`duplicate question id "${id}"`);
      ids.add(id);
    }
    for (const used of placeholders(template)) {
      if (!ids.has(used)) throw new Error(`the prompt uses {{${used}}}, which names no question`);
    }
    return { questions };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// ---- facts ----

/** `package.json` `scripts.test` of the folder, as a one-line description; undefined when absent. */
export function readTestScript(cwd: string): string | undefined {
  try {
    const script = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"))?.scripts?.test;
    return typeof script === "string" && script.trim() ? `package.json test script: ${script.trim()}` : undefined;
  } catch {
    return undefined;
  }
}

/** The default branch by the guard's rule: what `origin/HEAD` points at, else the one of `main` and `master` that exists (both or neither: unknown). */
function defaultBranch(cwd: string): string | null {
  const origin = originDefaultBranch(cwd);
  if (origin) return origin;
  const hasMain = gitSucceeds(cwd, "rev-parse", "--verify", "--quiet", "refs/heads/main");
  const hasMaster = gitSucceeds(cwd, "rev-parse", "--verify", "--quiet", "refs/heads/master");
  return hasMain && !hasMaster ? "main" : hasMaster && !hasMain ? "master" : null;
}

/** Local, read-only lookups: current and default branch (git) and the folder's test script. No network. */
export function readFacts(cwd: string): QuestionFacts {
  return { currentBranch: currentBranch(cwd), defaultBranch: defaultBranch(cwd), testScript: readTestScript(cwd) };
}

// ---- composing ----

/** The question's default with `{{fact}}` placeholders filled; undefined when it has none or a fact is unknown. */
export function questionDefault(question: CommandQuestion, facts: QuestionFacts): string | undefined {
  if (question.default === undefined) return undefined;
  let known = true;
  const text = question.default.replace(PLACEHOLDER, (_match, name: string) => {
    const value = facts[name.trim() as keyof QuestionFacts];
    if (!value) known = false;
    return value ?? "";
  });
  return known ? text : undefined;
}

/** The answer a question ends up with: what was given, else its default. */
function effectiveAnswer(question: CommandQuestion, answers: Answers, facts: QuestionFacts): string | undefined {
  return answers[question.id]?.trim() || questionDefault(question, facts)?.trim() || undefined;
}

/** Required questions that have neither an answer nor a default. */
export function missingRequired(questions: readonly CommandQuestion[], answers: Answers, facts: QuestionFacts): CommandQuestion[] {
  return questions.filter((question) => question.required && effectiveAnswer(question, answers, facts) === undefined);
}

// One pass over each line: an answer or an argument that looks like a placeholder is not expanded again. The blanks before a token go with it.
const TOKEN = /([ \t]*)(?:\{\{([^{}]*)\}\}|\$ARGUMENTS|\$([1-9]))/g;

/**
 * One body line with its answers and the typed arguments filled in; undefined when it has answers and every one was skipped. A skipped
 * answer renders as empty. A multi-line answer becomes a block quote on its own lines, indented like the line, with the text before it
 * kept above and the text after it on the line below.
 */
function composeLine(line: string, values: Map<string, string | undefined>, args: string, words: string[]): string[] | undefined {
  const matches = [...line.matchAll(TOKEN)];
  const answered = matches.filter((match) => match[2] !== undefined);
  if (answered.length > 0 && answered.every((match) => values.get(match[2]!.trim()) === undefined)) return undefined;
  const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
  const out: string[] = [];
  let current = "";
  let afterQuote = false;
  // Text right after a quote starts a fresh line, so its leading space goes.
  const append = (text: string) => {
    current += afterQuote && current === indent ? text.trimStart() : text;
  };
  let last = 0;
  for (const match of matches) {
    append(line.slice(last, match.index));
    last = (match.index ?? 0) + match[0].length;
    if (match[2] === undefined) {
      // `$ARGUMENTS` is all of the typed text, `$1`..`$9` its words (empty when missing).
      append(`${match[1]}${match[3] ? (words[Number(match[3]) - 1] ?? "") : args}`);
      continue;
    }
    const answer = values.get(match[2].trim());
    if (answer === undefined) continue;
    if (!answer.includes("\n")) {
      append(`${match[1]}${answer}`);
      continue;
    }
    if (current.trim()) out.push(current.trimEnd());
    out.push(...answer.split("\n").map((part) => `${indent}> ${part}`));
    current = indent;
    afterQuote = true;
  }
  append(line.slice(last));
  if (current.trim() || !afterQuote) out.push(current);
  return out;
}

/**
 * The request: the command's prompt with each `{{id}}` replaced by the answer, verbatim (a multi-line answer becomes a block quote), and
 * `$ARGUMENTS` and `$1`..`$9` by what was typed after the command, all in the same pass. A prompt line is left out only when all of its
 * answers were skipped. Throws when a required answer is missing.
 */
export function composeRequest(form: QuestionForm, answers: Answers, facts: QuestionFacts, args = ""): string {
  const missing = missingRequired(form.questions, answers, facts);
  if (missing.length > 0) throw new Error(`required answers missing: ${missing.map((question) => question.id).join(", ")}`);
  const values = new Map(form.questions.map((question) => [question.id, effectiveAnswer(question, answers, facts)]));
  const typed = args.trim();
  const words = typed.split(/\s+/).filter((word) => word !== "");
  const lines: string[] = [];
  for (const line of form.template.split("\n")) lines.push(...(composeLine(line, values, typed, words) ?? []));
  return lines.join("\n").trim();
}

/**
 * What the typed arguments offer as answers: the first text or long question gets the text, and the first choice the text matches (any
 * case) gets that option. They are offered, never taken: the user still sees them in the question.
 */
export function prefillFromArguments(questions: readonly CommandQuestion[], args: string): Answers {
  const text = args.trim();
  const presets: Answers = {};
  if (text === "") return presets;
  const free = questions.find((question) => question.kind !== "choice");
  if (free) presets[free.id] = free.kind === "text" ? text.replace(/\s*\n\s*/g, " ") : text;
  const wanted = text.toLowerCase();
  for (const question of questions) {
    const option = question.kind === "choice" ? question.options?.find((candidate) => candidate.toLowerCase() === wanted) : undefined;
    if (option !== undefined) {
      presets[question.id] = option;
      break;
    }
  }
  return presets;
}

// ---- asking ----

/** The dialogs the question loop needs; each resolves to undefined when the user presses Esc. */
export type QuestionUi = {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
};

export const REQUIRED_HINT = "required, this answer cannot be empty";
export const NO_ANSWER = "(no answer)";
const CLEAR = "-";

/** Choices with the preferred one first, since the select has no preselection. */
const defaultFirst = (options: string[], preferred: string | undefined): string[] => (preferred && options.includes(preferred) ? [preferred, ...options.filter((option) => option !== preferred)] : options);

/**
 * Asks every question in order. `current` holds earlier answers (when the user edits them) and takes the place of the question's default;
 * an optional answer that was given can then be cleared (`-` for text, `(no answer)` for a choice). `presets` (the typed arguments) are
 * offered like a default, but are no earlier answer: nothing offers to clear them. Returns undefined when the user escapes any question or
 * leaves a required one empty twice.
 */
export async function askQuestions(
  form: QuestionForm,
  facts: QuestionFacts,
  ui: QuestionUi,
  { current = {}, presets = {} }: { current?: Answers; presets?: Answers } = {},
): Promise<Answers | undefined> {
  const answers: Answers = {};
  for (const question of form.questions) {
    const previous = current[question.id];
    const clearable = !question.required && previous !== undefined;
    const optional = question.required ? "" : clearable && question.kind === "text" ? ` (optional, "${CLEAR}" clears)` : " (optional)";
    const title = `${question.label}${optional}`;
    const preset = previous ?? presets[question.id] ?? questionDefault(question, facts);

    if (question.kind === "choice") {
      const options = defaultFirst(question.options ?? [], preset);
      const choice = await ui.select(title, clearable ? [...options, NO_ANSWER] : options);
      if (choice === undefined) return undefined;
      if (choice !== NO_ANSWER) answers[question.id] = choice;
      continue;
    }

    let reply: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const heading = attempt === 0 ? title : `${title} — ${REQUIRED_HINT}`;
      reply = question.kind === "long" ? await ui.editor(heading, preset ?? "") : await ui.input(heading, preset);
      if (reply === undefined) return undefined;
      if (clearable && question.kind === "text" && reply.trim() === CLEAR) {
        reply = "";
        break;
      }
      // A text answer left empty accepts the default shown as the placeholder; an emptied editor means no answer.
      if (question.kind === "text" && !reply.trim()) reply = preset ?? "";
      if (reply.trim() || !question.required) break;
    }
    if (!reply?.trim()) {
      if (question.required) return undefined;
      continue;
    }
    answers[question.id] = reply.trim();
  }
  return answers;
}
