import { z } from "zod";
import { routeForTask } from "@/lib/ai/config";
import { getModelCandidates } from "@/lib/ai/provider";

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
  const route = routeForTask("evals.judge");
  const [candidate] = await getModelCandidates("evals.judge");
  if (!candidate) {
    throw new Error("No AI provider configured for the judge");
  }
  const { Agent } = await import("@mastra/core/agent");
  const agent = new Agent({
    id: "evals.judge",
    instructions: JUDGE_INSTRUCTIONS,
    model: candidate.model,
    name: "evals.judge",
  });
  const result = await agent.generate(
    `TRANSCRIPT:\n${transcriptText}\n\nSUMMARY TO GRADE:\n${summary}`,
    {
      modelSettings: { maxOutputTokens: route.maxOutputTokens },
      structuredOutput: { schema: judgeSchema },
    }
  );
  return judgeSchema.parse(result.object);
}
