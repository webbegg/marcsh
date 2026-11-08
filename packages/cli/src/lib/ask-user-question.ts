import { z } from "zod";

const askUserQuestionSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        header: z.string(),
        // Options are picked with the keys 1-9.
        options: z.array(z.object({ label: z.string(), description: z.string() })).min(2).max(9),
        multiSelect: z.boolean(),
      }),
    )
    .min(1)
    .max(4)
    // Answers are keyed by question text, so two identical questions could not be told apart.
    .refine((questions) => new Set(questions.map((q) => q.question)).size === questions.length),
});

export type AskQuestion = z.infer<typeof askUserQuestionSchema>["questions"][number];
export type AskUserQuestionInput = z.infer<typeof askUserQuestionSchema>;

/** The questions of an `AskUserQuestion` call, or null when the input is not shaped as the SDK documents. */
export function parseAskUserQuestion(input: Record<string, unknown>): AskUserQuestionInput | null {
  const parsed = askUserQuestionSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** The answer string for one question: chosen labels in option order, then the typed "Other" text, joined with ", ". */
export function buildAnswer(question: AskQuestion, { picked, other }: { picked: number[]; other?: string }): string {
  const labels = question.options.filter((_, index) => picked.includes(index)).map((option) => option.label);
  const typed = other?.trim();
  return (typed ? [...labels, typed] : labels).join(", ");
}
