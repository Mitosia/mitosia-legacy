import { z } from "zod";
import { generateStructured } from "@/lib/ai/generate";

// LLM-as-judge for summary faithfulness — the model evaluator that runs
// AFTER the deterministic scorers pass, only when a provider is
// configured. Sonnet-tier per the routing table.

const judgeSchema = z.object({
  faithfulness: z.number().min(0).max(1),
  notes: z.string().max(500),
});
export type JudgeVerdict = z.infer<typeof judgeSchema>;

const JUDGE_INSTRUCTIONS = `You grade executive summaries of transcripts.
Given a transcript and a summary, score faithfulness 0-1: 1.0 = every
claim in the summary is supported by the transcript; deduct for invented
facts, wrong attributions, or missing the recording's main thrust. Note
the single most important problem, or "faithful" if none.`;

export async function judgeSummary(
  transcriptText: string,
  summary: string
): Promise<JudgeVerdict> {
  const result = await generateStructured(
    "evals.judge",
    JUDGE_INSTRUCTIONS,
    `TRANSCRIPT:\n${transcriptText}\n\nSUMMARY TO GRADE:\n${summary}`,
    judgeSchema
  );
  return result.output;
}
