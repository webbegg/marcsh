import { describe, expect, test } from "bun:test";
import type { AskQuestion } from "../ask-user-question";
import { ASK_USER_TOOL, createAskUserTool, isMarcshAskUser } from "./pi-ask-user";

const COLOR: AskQuestion = {
  question: "Which color do you prefer?",
  header: "Color",
  options: [
    { label: "Red", description: "A warm color" },
    { label: "Green", description: "A natural color" },
  ],
  multiSelect: false,
};
const TOPPINGS: AskQuestion = {
  question: "Which toppings?",
  header: "Toppings",
  options: [
    { label: "Cheese", description: "Melted" },
    { label: "Olives", description: "Salty" },
  ],
  multiSelect: true,
};

type Asked = { questions: AskQuestion[]; signal: AbortSignal };

function setup(answer: Record<string, string> | null | (() => Promise<Record<string, string> | null>) = null) {
  const asked: Asked[] = [];
  const turnEnded = new AbortController();
  const tool = createAskUserTool({
    host: {
      askQuestions: async (questions, signal) => {
        asked.push({ questions, signal });
        return typeof answer === "function" ? answer() : answer;
      },
    },
    signal: turnEnded.signal,
  });
  const run = (params: unknown, signal?: AbortSignal) => tool.execute("call-1", params, signal, undefined, undefined as never);
  return { tool, asked, turnEnded, run };
}

const textOf = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((block) => block.text ?? "").join("");

describe("the AskUserQuestion tool definition", () => {
  test("is named like Claude's tool and tells the model when to ask", () => {
    const { tool } = setup();

    expect(tool.name).toBe("AskUserQuestion");
    expect(ASK_USER_TOOL).toBe("AskUserQuestion");
    expect(tool.description).toContain("multiple choice");
    expect(tool.description.toLowerCase()).toContain("ask the user");
  });

  test("takes 1-4 questions, each with a header, 2-9 options with label and description, and multiSelect", () => {
    const { tool } = setup();
    const schema = tool.parameters as any;
    const question = schema.properties.questions.items;

    expect(schema.required).toEqual(["questions"]);
    expect(schema.properties.questions).toMatchObject({ type: "array", minItems: 1, maxItems: 4 });
    expect(question.required).toEqual(["question", "header", "options", "multiSelect"]);
    expect(question.properties.question.type).toBe("string");
    expect(question.properties.header.type).toBe("string");
    expect(question.properties.multiSelect.type).toBe("boolean");
    expect(question.properties.options).toMatchObject({ type: "array", minItems: 2, maxItems: 9 });
    expect(question.properties.options.items.required).toEqual(["label", "description"]);
  });
});

describe("executing AskUserQuestion", () => {
  test("lists each question with its answer, multi-select answers as the host built them", async () => {
    const { run, asked } = setup({ [COLOR.question]: "Green", [TOPPINGS.question]: "Cheese, Olives" });

    const result = await run({ questions: [COLOR, TOPPINGS] });

    expect(asked).toHaveLength(1);
    expect(asked[0]?.questions).toEqual([COLOR, TOPPINGS]);
    const text = textOf(result);
    expect(text).toContain(`"${COLOR.question}"="Green"`);
    expect(text).toContain(`"${TOPPINGS.question}"="Cheese, Olives"`);
    expect(text.indexOf(COLOR.question)).toBeLessThan(text.indexOf(TOPPINGS.question));
  });

  test("a declined prompt is a tool error: The user declined to answer.", async () => {
    const { run } = setup(null);

    await expect(run({ questions: [COLOR] })).rejects.toThrow("The user declined to answer.");
  });

  test("invalid input is a tool error that explains the schema and never asks", async () => {
    const { run, asked } = setup({});
    const oneOption = { ...COLOR, options: [COLOR.options[0]!] };

    for (const params of [{ questions: [oneOption] }, { questions: [] }, { questions: [COLOR, COLOR] }, {}, { questions: "Which?" }]) {
      await expect(run(params)).rejects.toThrow(/questions.*1-4.*options.*2-9.*multiSelect/s);
    }
    expect(asked).toEqual([]);
  });

  test("the host gets a signal that aborts when the turn ends", async () => {
    const { run, asked, turnEnded } = setup({ [COLOR.question]: "Red" });

    await run({ questions: [COLOR] });
    expect(asked[0]?.signal.aborted).toBe(false);
    turnEnded.abort();

    expect(asked[0]?.signal.aborted).toBe(true);
  });

  test("the host's signal also aborts when pi aborts the tool call", async () => {
    const { run, asked } = setup({ [COLOR.question]: "Red" });
    const toolCall = new AbortController();

    await run({ questions: [COLOR] }, toolCall.signal);
    toolCall.abort();

    expect(asked[0]?.signal.aborted).toBe(true);
  });

  test("a prompt that fails (the host throws) is a tool error, not a crash", async () => {
    const { run } = setup(async () => {
      throw new Error("prompt crashed");
    });

    await expect(run({ questions: [COLOR] })).rejects.toThrow("The user declined to answer.");
  });
});

describe("isMarcshAskUser", () => {
  test("is true only for marcsh's own registration of the tool", () => {
    expect(isMarcshAskUser({ name: "AskUserQuestion", sourceInfo: { path: "<inline:marcsh-ask-user>" } })).toBe(true);
  });

  test("an extension, sdk or built-in tool with the same name is not marcsh's", () => {
    for (const path of ["/agent/extensions/ask.ts", "<inline:1>", "<inline:other>", "<sdk:AskUserQuestion>", "builtin:AskUserQuestion"]) {
      expect(isMarcshAskUser({ name: "AskUserQuestion", sourceInfo: { path } })).toBe(false);
    }
  });

  test("marcsh's extension registering another name is not the ask tool", () => {
    expect(isMarcshAskUser({ name: "other_tool", sourceInfo: { path: "<inline:marcsh-ask-user>" } })).toBe(false);
  });
});
