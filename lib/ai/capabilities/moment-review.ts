import { z } from "zod";
import type { MomentReviewFix } from "@/lib/db/schema/intelligence";
import { generateStructured, type StructuredUsage } from "../generate";

// The Reviewer agent (S6 §9, docs/episode-to-clips.md): one small call per
// candidate clip, COLD — the reviewer is shown ONLY what a viewer will see
// (the clip's own transcript span and its title/hook), never the episode
// around it. Self-containment stops being the proposer grading its own
// work and becomes a measurement by a judge that structurally cannot be
// biased by context it never saw. Three precedents and the rubric method
// are in docs/clipping-landscape.md: 0-1-2 scales (finer scales judge
// inconsistently), per-level definitions, a CONSTRAINED fix vocabulary
// (an unconstrained critic suggests operations the editor can't perform),
// and an explicit keep-context guardrail (judges over-punish long hooks).
//
// The reviewer informs the human review — it never moves boundaries
// itself, and a reviewer outage never fails discovery.

// The Reviewer runs BY DEFAULT across both clip lanes (decision
// 2026-08-28: the cutting room ships whole — no switches to remember).
// MOMENT_REVIEWER=off is the escape hatch; mock analysis mode always
// reviews so the CI chain proves the path.
export function reviewerEnabled(): boolean {
  return (
    process.env.MOMENT_REVIEWER !== "off" ||
    process.env.ANALYSIS_PROVIDER === "mock"
  );
}

// 0 = fails the rubric, 1 = partial, 2 = clean pass.
const rubric = z.number().int().min(0).max(2);

// Property order is generation order: judge the experience in viewing
// order (opening → resolution → whole → title), then pick the one fix,
// then explain.
const verdictSchema = z
  .object({ opensCold: rubric })
  .extend({ resolves: rubric })
  .extend({ standsAlone: rubric })
  .extend({ titleTruthful: rubric })
  .extend({
    suggestedFix: z.enum([
      "none",
      "extend_start",
      "trim_start",
      "trim_end",
      "extend_end",
      "retitle",
      "drop",
    ]),
  })
  .extend({ notes: z.string().min(1).max(300) });

export type MomentReviewVerdict = z.infer<typeof verdictSchema>;

export interface ReviewableMoment {
  hook: string;
  id: string;
  // Lane-specific rubric emphasis: a moment is judged as a short (hook
  // velocity, one beat); a chapter as a topic (setup, development,
  // resolution of ONE subject — a chapter that feels like a short scores
  // badly on its own lane's axis).
  lane: "chapter" | "moment";
  // Display-form transcript text of exactly [startMs, endMs] — the whole
  // context the reviewer gets.
  spanText: string;
  title: string;
}

export interface MomentReviewResult {
  usage: StructuredUsage[];
  verdicts: Map<string, MomentReviewVerdict>;
}

const SYSTEM = `You are a cold viewer reviewing ONE candidate clip cut from a longer recording. You are shown only the clip's transcript and its packaging — deliberately nothing else. Judge only what is in front of you.

Score each rubric 0, 1, or 2:
- opensCold: 2 = the first lines orient a stranger (a question, setup, or
  self-explanatory statement); 1 = slightly abrupt but recoverable;
  0 = starts mid-thought, referring to things never shown.
- resolves: 2 = the clip ends on a completed thought or payoff; 1 = ends
  acceptably but weakly; 0 = cuts off mid-thought or after the next topic
  has already begun.
- standsAlone: 2 = fully comprehensible and satisfying with zero outside
  context; 1 = mostly, with minor gaps; 0 = depends on unseen context.
- titleTruthful: 2 = title/hook name what actually plays; 1 = loosely
  related; 0 = misleading.

suggestedFix — exactly one of: none | extend_start (opening lacks its
setup) | trim_start (opens on leftover tail of a previous topic) |
trim_end (runs past the payoff) | extend_end (cuts before the payoff
lands) | retitle (content fine, packaging wrong) | drop (no fix would
make this stand alone).

The clip's first and last lines are quoted as OPENS ON / CLOSES ON —
judge those cut points explicitly: does the opening orient, does the
close land.

LANE tells you what this clip is meant to be. A "moment" is a short: one
beat, hook in the first seconds, payoff at the close. A "chapter" is a
topic a viewer picks from an episode's chapter list: judge whether ONE
subject gets its setup, development, and resolution — a chapter that
feels like a quick short (a lone beat with no development) fails
standsAlone for its lane, and extra runway is normal, not a flaw.

Guardrails:
- Do NOT penalize a clip for including its setup question or a slightly
  long lead-in — missing setup is far worse than extra setup.
- Transcripts are verbatim speech: disfluencies, fillers, and informal
  grammar are normal — never penalize them.
- notes: one or two sentences naming the single most important issue, or
  what works if none.`;

// The first/last ~15 words set off explicitly — M1 measured the cut
// points as the failure surface, so the cold read is pointed at them.
const EDGE_WORDS = 15;
const WHITESPACE = /\s+/;

function reviewPrompt(moment: ReviewableMoment): string {
  const words = moment.spanText.split(WHITESPACE).filter(Boolean);
  const opens = words.slice(0, EDGE_WORDS).join(" ");
  const closes = words.slice(Math.max(0, words.length - EDGE_WORDS)).join(" ");
  return `LANE: ${moment.lane}\nTITLE: ${moment.title}\nHOOK: ${moment.hook}\nOPENS ON: ${opens}\nCLOSES ON: ${closes}\n\nCLIP TRANSCRIPT:\n${moment.spanText}`;
}

export async function reviewMoments(
  moments: readonly ReviewableMoment[]
): Promise<MomentReviewResult> {
  if (process.env.ANALYSIS_PROVIDER === "mock") {
    return mockReview(moments);
  }

  const settled = await Promise.allSettled(
    moments.map((moment) =>
      generateStructured(
        "moment-review.verdict",
        SYSTEM,
        reviewPrompt(moment),
        verdictSchema
      )
    )
  );

  const verdicts = new Map<string, MomentReviewVerdict>();
  const usage: StructuredUsage[] = [];
  for (const [index, outcome] of settled.entries()) {
    const moment = moments[index];
    if (!moment) {
      continue;
    }
    // A failed verdict leaves that candidate unreviewed (columns stay
    // null) — the reviewer is a quality layer, never a gate that can
    // fail discovery or hide a candidate.
    if (outcome.status === "fulfilled") {
      verdicts.set(moment.id, outcome.value.output);
      usage.push(outcome.value.usage);
    } else {
      console.error(
        `[review] verdict failed for candidate ${moment.id}:`,
        outcome.reason
      );
    }
  }
  return { usage, verdicts };
}

// Deterministic mock: every candidate passes clean except the LAST one,
// which is flagged trim_end — so the CI chain proves both the happy path
// and the flagged path (badge + columns) end to end.
function mockReview(moments: readonly ReviewableMoment[]): MomentReviewResult {
  const verdicts = new Map<string, MomentReviewVerdict>();
  for (const [index, moment] of moments.entries()) {
    const flagged = index === moments.length - 1 && moments.length > 1;
    verdicts.set(moment.id, {
      notes: flagged
        ? "Mock review: runs past the payoff."
        : "Mock review: stands alone.",
      opensCold: 2,
      resolves: flagged ? 1 : 2,
      standsAlone: 2,
      suggestedFix: flagged ? "trim_end" : "none",
      titleTruthful: 2,
    });
  }
  return { usage: [], verdicts };
}

export function isFlaggedVerdict(verdict: {
  opensCold: number;
  resolves: number;
  standsAlone: number;
  suggestedFix: MomentReviewFix | string;
  titleTruthful: number;
}): boolean {
  return (
    verdict.suggestedFix !== "none" ||
    Math.min(
      verdict.opensCold,
      verdict.resolves,
      verdict.standsAlone,
      verdict.titleTruthful
    ) === 0
  );
}
