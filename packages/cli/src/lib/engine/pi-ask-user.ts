import type { InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { parseAskUserQuestion } from "../ask-user-question";
import type { ToolSource } from "./pi-permissions";
import type { TurnHost } from "./types";

export const ASK_USER_TOOL = "AskUserQuestion";
const ASK_USER_EXTENSION = "marcsh-ask-user";
/** Where pi says a tool comes from when an inline extension named `marcsh-ask-user` registered it. */
const ASK_USER_SOURCE = `<inline:${ASK_USER_EXTENSION}>`;

export const ASK_USER_DECLINED = "The user declined to answer.";
const INVALID_INPUT =
  "Invalid AskUserQuestion input. Pass `questions`: 1-4 questions, each with `question` (its text, different from the others), " +
  "`header` (a short label), `options` (2-9 choices, each with `label` and `description`) and `multiSelect` (true or false).";

/**
 * Whether pi's tool is marcsh's own `AskUserQuestion`. The name alone proves nothing: an extension can
 * register a tool with it, and pi keeps the first registration (user extensions load before marcsh's).
 * The tool must come from marcsh's own extension.
 */
export function isMarcshAskUser(tool: ToolSource): boolean {
  return tool.name === ASK_USER_TOOL && tool.sourceInfo.path === ASK_USER_SOURCE;
}

// The same shape as Claude's input (`parseAskUserQuestion` is the strict check), as plain JSON Schema: pi
// validates tool arguments against any JSON Schema, and marcsh does not depend on TypeBox.
const parameters = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      description: "The questions to ask, 1 to 4.",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "The complete question, ending with a question mark. Each question's text must be different." },
          header: { type: "string", description: "A very short label for the question (a few words)." },
          options: {
            type: "array",
            description: "The choices, 2 to 9. The user can always type their own answer too.",
            minItems: 2,
            maxItems: 9,
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "The choice, in a few words." },
                description: { type: "string", description: "What the choice means or what happens if it is chosen." },
              },
              required: ["label", "description"],
            },
          },
          multiSelect: { type: "boolean", description: "true when the user may pick more than one option." },
        },
        required: ["question", "header", "options", "multiSelect"],
      },
    },
  },
  required: ["questions"],
} as unknown as ToolDefinition["parameters"];

export type AskUserOptions = {
  host: Pick<TurnHost, "askQuestions">;
  /** Aborts when the turn ends; a pending question is then declined. */
  signal: AbortSignal;
};

/** The tool result text: each question with its answer. */
function describeAnswers(questions: { question: string }[], answers: Record<string, string>): string {
  const lines = questions.map(({ question }) => `"${question}"="${answers[question] ?? ""}"`);
  return `User has answered your questions: ${lines.join(", ")}. You can now continue with the user's answers in mind.`;
}

export function createAskUserTool({ host, signal: turnEnded }: AskUserOptions): ToolDefinition {
  return {
    name: ASK_USER_TOOL,
    label: "Ask the user",
    description:
      "Ask the user multiple choice questions to gather information, clarify what they want, choose between approaches, or " +
      "decide how to proceed. Use it when you need the user's decision before going on, not for things you can find out " +
      "yourself. Users can always type their own answer instead of picking an option. Set multiSelect to true to let them " +
      "pick several options for a question. Put the option you recommend first.",
    promptSnippet: "Ask the user multiple choice questions when you need their decision",
    parameters,
    async execute(_toolCallId, params, signal) {
      const asked = parseAskUserQuestion(params as Record<string, unknown>);
      if (!asked) throw new Error(INVALID_INPUT);

      let answers: Record<string, string> | null;
      try {
        answers = await host.askQuestions(asked.questions, signal ? AbortSignal.any([signal, turnEnded]) : turnEnded);
      } catch {
        answers = null;
      }
      if (!answers) throw new Error(ASK_USER_DECLINED);

      return { content: [{ type: "text", text: describeAnswers(asked.questions, answers) }], details: { answers } };
    },
  };
}

/** The named inline extension that offers the tool, so pi's tool list says it is marcsh's. */
export function createAskUserExtension(options: AskUserOptions): InlineExtension {
  return {
    name: ASK_USER_EXTENSION,
    hidden: true,
    factory: (pi) => {
      pi.registerTool(createAskUserTool(options));
    },
  };
}
