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

// Citation-relevance judge (S6, carried from the S5 exit): the
// deterministic verifier proves a citation's PROVENANCE (it overlaps a
// retrieved chunk) but not its RELEVANCE — the observed failure mode is a
// range-valid citation topically unrelated to the question riding along on
// an otherwise-correct answer (the Massey case, 2026-08-25). One call per
// answered question grades every citation.

const citationJudgeSchema = z.object({
  notes: z.string().max(500),
  // One verdict per citation, in the order given.
  relevant: z.array(z.boolean()),
});
export type CitationJudgeVerdict = z.infer<typeof citationJudgeSchema>;

const CITATION_JUDGE_INSTRUCTIONS = `You grade the citations attached to an
answer about a recording. Given a question, the answer, and the quoted
transcript excerpts cited as evidence, mark each citation true if the
quote is topically relevant evidence for THIS question and answer, false
if it is unrelated padding — even when it is a real quote from the
recording. Return one boolean per citation, in order. Note the single
most important problem, or "relevant" if none.`;

export async function judgeCitationRelevance(
  question: string,
  answer: string,
  quotes: readonly string[]
): Promise<CitationJudgeVerdict> {
  const numbered = quotes
    .map((quote, index) => `${index + 1}. "${quote}"`)
    .join("\n");
  const result = await generateStructured(
    "evals.judge",
    CITATION_JUDGE_INSTRUCTIONS,
    `QUESTION:\n${question}\n\nANSWER:\n${answer}\n\nCITATIONS TO GRADE:\n${numbered}`,
    citationJudgeSchema
  );
  return result.output;
}
