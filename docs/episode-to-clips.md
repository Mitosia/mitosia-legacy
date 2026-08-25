# Episode → Clips: the editorial thought process, and the harness that implements it

**Status:** Design. Written 2026-08-26 from Rajesh's question on the Brett Lee source ("how would you break this video into clips for easy upload, and so viewers aren't forced to watch an hour?") — capturing the *thought process* first and the *system* second, so the system stays an implementation of the editorial method rather than a pile of features. Worked example throughout: the TRS Brett Lee interview (58:19), already fully processed on staging (24 chapters, 39 grounded highlights, 18 moment candidates).
**Priority decision (Rajesh, 2026-08-26):** extraction quality comes FIRST — clip selection and boundaries must feel like the work of a real human editor/director before anything downstream (render polish, format variants, upload) gets attention. §7's platform question is thereby deferred; §8 defines the bar and the loop that gets there.
**Consumes:** everything S2–S6 built. **Feeds:** S8 (edit spec), S9 (render), S10 (reframe), S17 (distribution).

---

## 1. The two products hiding in "break it into clips"

The request contains two different deliverables, and conflating them is the classic mistake:

1. **Segment clips** — the episode decomposed into 8–15 self-contained, titled chapters-as-videos (2–8 min each) that together cover most of the episode. This is what "viewers shouldn't have to watch an hour" means: a viewer picks "The 2009 Ashes Heartbreak" or "Why Fast Bowling Got Slower" from a list and watches just that. Collectively they ARE the episode, minus the dead weight. This is the clips-channel model TRS itself runs.
2. **Highlight moments** — the 10–20 best scroll-stopping spans (20–90s), cherry-picked, ranked by hook. These are discovery bait: shorts, reels, teasers linking back. **This is exactly what S6 moment discovery already produces.**

Same source, same word timeline, opposite selection logic: segments optimize **coverage** ("every good minute belongs to exactly one clip"), moments optimize **peak** ("only the best minutes, overlap with segments is fine and expected"). One pool of material, two selectors. The harness below produces both from one plan, because an editor doing this by hand makes one pass through the episode and tags as they go — they don't read the transcript twice.

## 2. The editorial thought process (what a human clips editor actually does)

Captured as steps because each step becomes a pipeline stage in §4. Running example: Brett Lee.

**Step 1 — Understand the whole before cutting anything.** Read/skim the entire episode; know its arc, its guest, its 3–4 marquee stretches. You cannot judge "is this segment self-contained" without knowing what surrounds it. *(Mitosia: the analysis summary + chapter outline already are this understanding, machine-held.)*

**Step 2 — Inventory the narrative units.** An interview is not a stream; it's a sequence of *arcs*: a topic is raised (usually a question), developed (story/argument), and paid off (punchline, conclusion, emotional beat). Mark every arc with rough bounds. Arcs are the atoms — clips are built from whole arcs, never fractions of one. On Brett Lee: the Preity Zinta song legend, the 2003–05 Australian team, the Ponting/Mohali standoff, the fast-bowling-speed crisis, Vaibhav Suryavanshi, the Sachin beamer, young Kohli's eyes, the 2009 Ashes ending, the sledging/India-Australia close. *(Mitosia: chapters approximate arcs; extraction stories/Q&A mark arc cores; moments mark arc peaks.)*

**Step 3 — Assemble clips from arcs.** Three rules a good editor applies:
- **One arc = one clip** by default. Merge adjacent arcs only when they're one conversation beat split by the chapterer (the Preity Zinta rumor at 00:00 and the Asha Bhosle regret at ~26:00 are the *same story told in two places* — that's a keep-the-better-telling call, not a merge, because they're 26 minutes apart).
- **Start at the setup, end at the payoff.** A clip opens with the question or setup line that provokes the arc (the S6 lead-in rule, now deterministic) and ends on the payoff sentence — before the pivot to the next topic, never after it. Ending a clip on "...anyway, so the next thing—" is the amateur tell.
- **Target 2–8 minutes.** Under ~90s it's a moment, not a segment (route it to the shorts pool). Over ~10 minutes viewers treat it as another long video and the decomposition bought nothing.

**Step 4 — Decide what to drop.** Not everything earns a clip: housekeeping, sponsor reads, warmup chatter, low-energy stretches, the weaker telling of a twice-told story. Dropping is a *first-class decision with a reason*, not a leftover — the plan must show what was dropped and why, or the reviewer can't trust the coverage. An editor typically keeps 70–85% of a strong interview.

**Step 5 — Package each clip.** Title that names the payoff, not the topic ("Why Fast Bowlers Got Slower" beats "Brett Lee on Bowling") and stands alone in search — platform practice is standalone titles over "Part 3/12", with a playlist carrying the order. Description: 1–2 sentences + link to the full episode + timestamp of where this sits in it. Tags/hashtags. A thumbnail frame at the emotional peak. *(Numbering lives in the playlist and the episode's clip index, not the title.)*

**Step 6 — QA the cuts.** Watch the first and last ten seconds of every clip — boundary errors cluster at the edges. Verify audio doesn't clip mid-word, the cold-open makes sense, the out doesn't hang. *(Mitosia: this is the human review stage — and the S6 review panel already is this UI: play-with-context, nudge on the sentence grid, accept/reject with reasons.)*

## 3. What Mitosia already has (build nothing twice)

Every step above lands on a primitive that exists:

| Editorial need | Existing primitive |
|---|---|
| Understand the whole | `source_analysis` summary + `source_chapter` outline |
| Arc inventory | chapters + extraction stories/Q&A (grounded, stable ids) + `moment_candidate` peaks |
| Word-precise boundaries | word timeline (integer ms) + sentence/pause/turn grids + `snapToSentences` + `captureLeadIn` (lib/intelligence/moments.ts) |
| "Verbatim or it doesn't ship" | grounding aligner (lib/intelligence/grounding.ts) |
| Twice-told-story resolution | two-pass dedupe (IoU + chunk-vector cosine) |
| Human review with audit + metrics | the S6 moments-panel pattern: decisions as columns + audit rows, `moments:metrics`-style readout |
| Durable jobs with claims/reapers/metering | the follow-on-job lifecycle (ingest→…→discover), ledger correlations |
| Cut-accurate media | the **original master** in org storage; ffmpeg workers with duration verification (S2's rule); per-rung I-frame playlists for scrub/preview |
| Cost discipline | one cached transcript prefix per source; task routes with budget math |

The genuinely new pieces are only: the **segment-plan capability**, the **clip lifecycle** (plan → approve → render → package), the **render step** (first ffmpeg output that isn't ingest), and **packaging metadata**. Everything else is reuse.

## 4. The harness, stage by stage (model proposes, code disposes — D3 everywhere)

### Stage A — Segment plan (intelligence layer; the new capability)

One sonnet pass over the SAME cached transcript prefix the other passes share (same cache-key discipline as S5/S6), given: summary, chapters, the moment inventory, and the grounded-extraction inventory. It proposes a **total partition of the episode**:

```
segments: [{ startMs, endMs, kind: "keep" | "drop",
             title, hook, summary, anchorText,   // keep only
             dropReason,                          // drop only: housekeeping | sponsor | low_energy | weaker_telling | other
             seedIds }]                           // chapters/moments/extractions it drew on
```

Deterministic gates after the model (pure, unit-tested, in `lib/intelligence/` beside moments.ts):
- **Boundary snapping**: starts to sentence/turn grid with lead-in capture; ends to sentence ends; pause fallback; the +10s growth cap. Same functions, no new math.
- **Anchor grounding**: each kept segment's `anchorText` must align inside its span (the aligner) or the segment is ungrounded and never surfaces — same provenance bar as everything else.
- **Coverage invariant** (new, cheap): kept+dropped segments must tile [0, duration] with no gaps and no overlaps after snapping — overlaps resolved by cutting at the sentence boundary nearest the midpoint of the overlap; gaps become implicit `drop/other` segments so nothing silently disappears. The plan the reviewer sees accounts for **every second of the episode**.
- **Duration policing**: kept segments under 90s are demoted to the moments pool (they're peaks, not chapters); over ~10 min are flagged for the reviewer (never auto-split — splitting an arc is editorial judgment).
- **Dedupe**: the twice-told-story check (chunk-vector cosine between kept segments) marks the weaker telling `weaker_telling` rather than deleting it — the reviewer sees the call and can flip it.

Moments are NOT regenerated here — the existing `moment_candidate` pool rides along as the shorts side of the same plan.

### Stage B — Review (the gate that spends nothing until a human says so)

The M1 pattern verbatim, one level up: a Clip Plan panel showing kept segments in order with the drops interleaved (collapsed, with reasons), total kept/dropped time, per-segment play-with-context, boundary nudges on the sentence grid, accept / reject / edit-title, and reorder only within reason (chronological is the default and almost always right). Decisions are columns + audit entries; acceptance rate and boundary-delta magnitude are the same two north-star metrics, now for segments. **Nothing renders until the plan (or an individual clip) is approved** — rendering costs compute and produces outward-bound files, so it sits behind the same kind of human gate as re-running discovery.

### Stage C — Render (the first non-ingest ffmpeg output; S9 muscle)

Per approved clip, a Trigger task (claim/reaper/idempotent, the standard clone) that:
- Cuts **from the original master in org storage** — never from the HLS ladder (that's a re-compressed derivative; cutting it is generation loss, the exact thing upload-first exists to avoid).
- Frame-accurate seek with re-encode (x264 High + AAC), because arbitrary sentence boundaries are never keyframe-aligned — stream-copy would shift every cut by up to a GOP (2s). Smart-cut (copy the middle, re-encode the edges) is a v2 optimization once golden tests exist; correctness first.
- **Audio handles**: pad ~200ms of source audio before the first word and after the last, with a ~50ms fade in/out — cuts exactly at word boundaries sound clipped; this is the difference between "obviously machine-cut" and fine. Loudness normalization (EBU R128 one-pass) is a v2 flag.
- **Duration-verified** like every transcode since S2: output duration must match (endMs − startMs + handles) within tolerance or the render fails loudly. The S2 lesson (ffmpeg exits 0 on truncated output) applies to a 4-minute clip exactly as it did to a 2-hour ladder.
- Artifacts under `…/source/{sourceId}/clips/{clipId}/clip.mp4` + a poster frame at the hook timestamp, with `size_bytes` on the row and a `storage_bytes` ledger entry; compute metered as `render:{clipId}:{attempt}` processing_minutes.

### Stage D — Package (cheap model pass + deterministic assembly)

Per rendered clip, a haiku pass generates platform metadata from the segment's title/summary/transcript span: YouTube title (≤100 chars), description (hook + "From: {episode} — full video: {link} — this segment starts at {mm:ss}"), tags. Deterministically assembled, never model-invented: the episode **clip index** (a description block for the full episode listing every clip with timestamps — chapters markup YouTube parses), and the export bundle: the MP4s plus a `manifest.json`/CSV of metadata for upload. **v1 "easy upload" = download the bundle / per-clip download; platform APIs (YouTube upload, scheduling) are connectors that belong with S17 distribution — don't couple rendering to OAuth.**

### Stage E — Instrumentation and the flywheel

Same D5 discipline: segment acceptance rate, boundary-delta per side, drop-reason distribution, and title-edit rate (how often the reviewer rewrites titles measures packaging quality). Later (S17), platform performance per clip backfeeds into scoring — but that's the flywheel's second turn, not v1.

### Lifecycle shape (the boring, load-bearing part)

`clip_plan_run` (one per source, statuses pending|processing|ready|failed, the standard clone) + `clip` rows (segment spans, status proposed|approved|rejected|rendering|rendered|failed, adjusted bounds, decidedBy/At, reject/drop reasons, artifact refs, revision pinned to the transcript revision). Plan generation chains off nothing automatically in v1 — it's a **button** ("Plan clips"), because unlike discovery it leads to spend-gated rendering and the strategist should choose when. Re-planning refuses while approved/rendered clips exist (the M1 rerun-refusal contract; rendered clips are deliverables). Renders are per-clip tasks so one failed render never blocks nine siblings. Every model call and every render minute is on the ledger in the sprint it ships.

## 5. What the harness would propose for the Brett Lee episode

Illustrative plan (built from the real chapters/moments; exact bounds come from the grids at runtime). Roughly 12 keeps, ~48 of 58 minutes kept:

| # | Segment (title names the payoff) | From the episode | ~Len |
|---|---|---|---|
| 1 | The Preity Zinta Song Legend — What Actually Happened | 00:00 block | ~4m |
| 2 | 156 km/h on Debut: Inside Brett Lee's Prime | 04:00–08:00 | ~4m |
| 3 | Inside the Unbeatable 2000s Australian Dressing Room | 06:00–10:00 | ~4m |
| 4 | When Ponting Shouted at Me in Mohali | 10:00–13:00 | ~3m |
| 5 | "Everything Did Go Wrong": Injuries, the 2011 World Cup Eye | 13:00–16:00 | ~3m |
| 6 | From a Rickshaw in '94 to Packed Stadiums: 30 Years of India | 15:56–18:00 | ~2.5m |
| 7 | Brett Lee's Verdict on 15-Year-Old Vaibhav Suryavanshi | 16:56–20:30 | ~3.5m |
| 8 | Why Fast Bowlers Got Slower (and Glutes Beat Biceps) | 22:00–26:00 | ~4m |
| 9 | The Asha Bhosle Duet That Never Happened | 26:00–28:00 | ~2m |
| 10 | Bowling to Sachin: the Beamer, the Fear, the Respect | 28:00–32:00 + 36:44 arc | ~4m |
| 11 | "You Could See It in His Eyes": Spotting Young Kohli | 38:00–40:00 | ~2m |
| 12 | The 2009 Ashes Heartbreak — and Retiring on His Own Terms | 34:00–37:00 + 41:44–45:00 | ~5m |
| 13 | Sledging, Spiders, and Why Australia Loves India | 38:00 + 46:00–close | ~6m |

Drops the model should propose: the viral-clip-watching stretch around 22:00 (screen-dependent, weak as audio-forward video), transition chatter. The twice-told Preity Zinta material (segments 1 and 9 overlap thematically) is exactly the dedupe-flag case — reviewer keeps both here because the tellings differ (legend vs. regret), which is why it's a flag and never an auto-delete. Segments 10 and 12 are the flagged-for-review merge candidates (arcs split across the episode) — v1 keeps clips contiguous and lets the reviewer choose one arc; multi-span clips are an S8 edit-spec feature, not a planning feature.

The 18 existing moment candidates ride along unchanged as the shorts pool — e.g. moment #2 ("Beach Bodies vs. Bowling Fast", 72s) is the short that trails segment 8.

One observed input-quality issue this design must not inherit: the current chapter starts on this source are suspiciously uniform (00:00, 01:30, 04:00, 06:00 … every ~2:00) — the chapters pass estimates rather than locates boundaries. Segment planning must therefore treat chapters as *hints* and trust only the snapped grids for bounds; a chapters-pass improvement (snap chapter starts to the same grids) is a cheap follow-up that helps both features.

## 6. Where this lands in the sprint plan

- **Stage A + B (plan + review)** are pure intelligence-layer + registry-UI work on existing primitives — a compact sprint on its own, and the right *next* candidate after M1 passes, because it converts M1's validated curation into the thing customers upload. It is also the forcing function for the S8 edit-spec: an approved clip IS a minimal edit spec (source, in/out, handles).
- **Stage C (render)** is the first slice of **S9** pulled forward in its simplest form (single-range cut from master, no templates/captions/branding). Remotion templates, caption burn-in, watermark tiers stay S9 proper.
- **9:16 verticals are explicitly NOT v1** — the moments pool becomes shorts only after **S10** reframing (face-aware crop); rendering 16:9 shorts nobody posts is waste.
- **Upload connectors are S17**; v1 ships the bundle.
- The sprint plan's S8 exit ("cut a clip entirely from the transcript") is unchanged — this document just fixes what the first cuts are *of*: the approved segment plan, not ad-hoc ranges.

## 7. Open questions for Rajesh

1. **Primary platform for segment clips** — ~~confirm 16:9 clips-channel style~~ **Deferred (2026-08-26): extraction quality first; format decisions after §8's bar is met.**
2. **Is a download bundle acceptable "easy upload" for v1**, with platform APIs later? (Design assumes yes.)
3. **Handles and normalization defaults** — 200ms audio handles, no loudness normalization in v1: fine, or is R128 normalization table-stakes for your uploads?

## 8. The bar, and the loop that reaches it

"Feels like a real editor did it" decomposes into five testable properties, each with an owner in the harness:

1. **In-points open on the setup.** The clip's first seconds make a cold viewer oriented — the question, the setup line, the topic turn. Owner: `captureLeadIn` + the prompt's start-at-the-setup instruction (landed 2026-08-26 after the first M1 finding). Measured by: in-point boundary deltas + `wrong_boundaries` rejects.
2. **Out-points land on the payoff.** The clip ends when the thought resolves — never mid-sentence, never after the pivot into the next topic has begun. The predicted symmetric artifact of finding #1 is *overrun*: a span that swallows the first seconds of the NEXT question. The designed twin fix — lead-out trim: when a span ends inside a new other-speaker turn that continues past it, pull the out-point back to the end of the moment speaker's last turn — is deliberately NOT built yet: it ships when a review round shows the artifact, keeping every gauntlet rule evidence-backed.
3. **Selection has no misses and no filler.** Every marquee arc of the episode is present; nothing weak padded in. Misses are currently invisible to the metrics (a reviewer can only reject what was proposed) — the review UI needs a cheap "what's missing?" affordance: the chapter list with un-covered stretches marked, so a miss becomes a recordable finding rather than a vague feeling.
4. **Self-containment.** A stranger understands each clip with zero outside context. Measured today by acceptance + `out_of_context` rejects; the citation-relevance-judge pattern extends to a boundary-naturalness judge in the eval once real fixtures accumulate.
5. **The packaging tells the truth.** Title/hook name the payoff and match what plays. Measured by title-edit rate once segment clips exist.

**The loop** is the M1 mechanism, run as many rounds as it takes: Rajesh reviews on a real source → each concrete finding becomes a deterministic rule (preferred) or a prompt change, locked in by unit tests + the golden eval so it can never regress silently → discovery re-runs → next round. Round 1 produced lead-in capture. The lever list, in the order evidence is likely to demand them: lead-out trim (§8.2), the uniform-chapter-starts fix (§5 — chapters feed both surfaces), a **discovery-on-opus experiment** (the model-tiering table has always said editorial judgment rides Opus; run it as an A/B on the same source once the deterministic gauntlet stops being the binding constraint — model quality is the last lever, not the first), and per-dimension score recalibration from accumulated accept/reject data. The metrics readout (`pnpm moments:metrics`) is the gate for each round; the bar is met when a fresh source's top ten needs no boundary work and survives review at the M1 threshold without coaching.
