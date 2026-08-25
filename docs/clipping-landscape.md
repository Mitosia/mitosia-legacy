# AI clipping landscape — research dossier (2026-08)

**Status:** Research synthesis, 2026-08-26. Three parallel sweeps (commercial products; open-source + building blocks; literature + production engineering write-ups), commissioned to pressure-test the episode-to-clips design (docs/episode-to-clips.md) against everything public. Companion to docs/editor-study.md the way that dossier serves S8/S9 — this one serves the clip-extraction quality program (§8/§9 of the design doc).
**Bottom line up front:** our architecture (LLM proposes over the word timeline → deterministic grids fix boundaries → cold reviewer → human gate) is the pattern the field independently converged on, our grounding is stricter than any public implementation found, and the category's #1 unsolved user complaint is exactly the §8 quality bar. The strategic gaps in the market are the two things we're building: coverage-style segment clips and agency multi-client workflow.

---

## 1. Commercial landscape

### The category's four recurring failures (every one is a §8 property)

1. **Contextually incomplete boundaries — the universal #1 complaint.** Clips start mid-thought, end before the punchline, capture the reaction instead of the statement that caused it, or merge two topics. Quantified everywhere: Opus Clip reviewers discard 20–40% of output; Vizard has a documented ~30–40% miss rate with the clearest failure taxonomy ("starting mid-thought, ending before the punchline"); Klap tests yielded 8 usable clips of 15; Riverside's clips "start too early, end too late"; Munch's coherence score — the only vendor even *scoring* the problem — is right ~70% of the time. Hardest reported case: conversational transitions where speakers build toward ideas gradually. **No shipped product snaps to thought boundaries.**
2. **Selection ≠ performance.** Clean cuts with generic hooks die in-feed; the clipping economy's answer is humans re-hooking AI output ("AI for the first pass, human judgment for the final cut" is the operator consensus; one network reported only 38% of raw clip views clearing quality gates).
3. **Under-tooled human review.** Everyone admits a review pass is mandatory; nobody tools it well: endpoint trimming at best, no frame-level cuts (Opus), a documented inability to assemble non-contiguous transcript spans (Descript Underlord), silence/filler left inside clips (Riverside). Descript is the best of the lot (fix the cut in the transcript in place).
4. **Billing hostility** as a churn driver: credits burned per source-minute regardless of output quality, charge-on-upload (Klap), projects locked after lapse (Opus). Design lesson for us: re-runs and quality failures must never feel like paying twice.

### Who's who (condensed)

| Product | Mode | Notable |
|---|---|---|
| **Opus Clip** (~$215M val., 10M users) | shorts cherry-picking | Category leader; only shipped **multimodal** engine (visual scenes + audio + sentiment); virality score 0–99; prompt-steered selection (ClipAnything); XML export to NLEs; still 20–40% discard in independent tests |
| **Vizard** | shorts | Best agency story in-category (Business tier: approval chains, per-brand client access, API); clearest boundary-failure taxonomy in reviews |
| **Descript (Underlord)** | editor-first | Best human-in-the-loop (transcript-native fixes); structural limit: clip finder extracts only contiguous transcript blocks |
| **Riverside Magic Clips** | shorts from own recordings | Cuts from local 4K source (quality edge); "starting point, not finished product" reputation |
| **Klap / Munch / Quso / Submagic / Spikes** | shorts | Klap weakest boundaries; Munch has the coherence score + agency pricing; Quso = agency bundle (brand kit, bulk scheduling); Submagic captions-first |
| **Eddie AI** | **coverage rough cuts** | The only editor-grade coverage player: story-framework rough cuts, multicam, timeline export to Premiere/Resolve/FCP. Complaints: black-box selection, too-short soundbites, weak project management. **Mitosia's nearest neighbor in spirit** |
| **Gling / AutoPod / FireCut / Premiere Assistant** | in-NLE cleanup | The editors' lane: silence/filler/multicam automation, not selection intelligence |
| **YouTube (platform)** | free baseline | Killed viewer Clips (Apr 2026); Studio now suggests key moments + titles for podcasts; platform absorbing baseline clipping — differentiation must live above "finds some moments" |
| **Reap / Choppity / Butter** | new entrants | Reap: MCP server + API at $9.99 (agent-access positioning); Choppity: transcript-native podcast specialist; Butter: per-client distribution workspaces, no clipping ($299) |

### The open flank

Nobody owns **multi-client agency + editor-quality coverage clips + transparent/steerable selection + real boundary tooling in review**. Vizard has agency workflow without selection quality; Eddie has coverage quality without agency workflow or transparency; Butter has client workspaces without clipping. That intersection is Mitosia's declared shape.

## 2. Open-source and building blocks

### The consensus stack (every live project)

Ingest → Whisper-family word-level transcript + diarization → **LLM proposes candidate spans over the transcript** (chunked ~20-min windows, rubric in prompt, JSON/SRT-echo output) → **deterministic timestamp binding** (the LLM never invents times: FunClip makes it echo SRT timestamps; AssemblyAI's pattern clamps to sentence objects; our aligner fuzzy-matches to the word timeline — the strictest variant found anywhere) → boundary polish (sentence/punctuation snap, pause gaps, pre/post-roll margins, ~30ms audio fades) → face/active-speaker reframing (only for vertical) → burned captions → human review. The one pure-algorithmic segmenter (ClipsAI, embedding TextTiling) is dead since 2024 — LLM-proposes/deterministic-binds won.

### Repos worth knowing

- **video-use** (browser-use, 21k★, MIT, active): "edit videos with coding agents." Two-layer reading — word-level transcript **with audio-event tokens** (`(laughter)`) packed to ~12KB/hour as primary source; on-demand filmstrip+waveform PNG probes only at decision points; 30ms fades at every cut; renders then **self-inspects boundary frames**. The closest public analogue to our harness philosophy.
- **openclip** (551★, MIT, active): per-segment LLM scoring, then a `--deep-optimize` **second pass judging each candidate's standalone viability and repairing boundaries, then re-judging** — our cold Reviewer + bounded revision round, independently invented.
- **FunClip** (Alibaba, 6.2k★, MIT, active): the LLM-echoes-input-timestamps trick — crude ancestor of our aligner.
- **agentic-video-editor** (476★, MIT, demo-grade): literally Director → Trim Refiner → Editor → Reviewer-with-scored-retry. Pattern validation for §9, code ignorable.
- **FireRed-OpenStoryline** (3.3k★, Apache-2.0): "Style Skills" — a reviewed editing workflow archived as a reusable recipe. Directly stealable idea for per-client/brand editing profiles later.
- **Building blocks**: auto-editor (Unlicense — margins + loudness-gate semantics freely liftable), PySceneDetect (BSD, shot boundaries — for the future don't-cut-mid-shot guard), TalkNet/LoCoNet-class active-speaker detection (the correct 9:16 primitive when S10 comes — not naive face tracking), jrgillick laughter detection (MIT), smartcut (MIT, frozen — last open smart-cut implementation if we ever want cut-without-full-re-encode).
- **License watchlist**: podcli (AGPL) and LosslessCut (GPL) are **ideas only — never read/copy code**; openSMILE commercial-restricted (use librosa/ffmpeg energy features instead); Anil-matcha shorts generator has no license file.

## 3. What production systems and the literature established

- **Spotify's podcast previews** (deployed, A/B-validated, hundreds of thousands of previews): sentence-timestamped transcript → LLM with explicit completeness requirements + few-shot examples → **deterministic trim to the last complete sentence**. Transcript-only replaced their multi-expert audio pipeline and won the A/B (+4.6% engagement). The closest published system to our design, and the industry-validated sequencing: text-first, ship, add modalities later.
- **"LLMs find moments well and delimit them badly"** — stated independently by a former StreamYard AI lead ("every tool seems to have this issue"), by PodReels (creators always adjusted the AI's windows; an out-of-context clip confused 8/10 cold viewers), and structurally by Repurpose-10K (trains boundary-offset regression as its own head against creator-refined timestamps). Our proposer/snapping decomposition is the literature's consensus, not a house quirk. Direction of error: **err toward including setup context** — the dominant documented failure is starting too late (validates lead-in capture); note Opus's judge itself has a named failure class of over-punishing long hooks.
- **Cold-context judging has three precedents.** EditDuet's judge sees only the finished timeline artifact and matched human-majority preference at 80.6% — *above* the 78.7% human-human agreement; Opus Clip's production judge scores the clip artifact on Hook/Content/Visual/Audio (a rubric literally named "Hook Info Standalone") and its scores track real export rate 13%→35% across bands; PodReels evaluated with show-unfamiliar viewers, which is what surfaced the context failure. Caveat from the reference-free-eval literature: a cold judge measures standalone-ness/hook/boundary feel but **cannot judge faithfulness to the source** — that stays with the source-aware deterministic aligner (ours already is).
- **Opus Clip's judge methodology is the calibration template**: 0–1–2 rubric scales (**finer scales made humans AND models inconsistent**), per-level definitions with positive/negative examples, ~250-sample truth sets sized by binomial confidence interval, 3-annotator majority with rationales, judge promoted only on anchor-set rerun stability plus a failure-mode regression catalog (5–10 minimal examples per class), validated against a business metric.
- **~75–80% is the agreement ceiling.** Judge-human and human-human agreement cluster there across studies — clip taste has an irreducible subjectivity floor. Tuning a judge past human-human agreement is chasing noise.
- **Editorial quality and audience engagement are different constructs** (the Rhapsody result): zero-shot frontier LLMs barely beat random at predicting YouTube most-replayed peaks (F1 ~0.06 vs 0.04 random); audio features helped only with fine-tuning on behavioral data. Meaning: virality scores without behavioral ground truth are decoration. M1 optimizes editorial quality — the right construct now; engagement prediction becomes learnable only once S17 distribution generates real outcome data (the Opus export-rate flywheel — for us, accept/ship decisions are that signal from day one).
- **Prosodic boundary detection is mature pre-LLM tech** (silent pauses, pre-boundary lengthening, pitch reset — wav2vec-era detectors work); sentence-snapping alone can cause visual jitter when cuts cross shot changes (AutoCut) — irrelevant for locked-off podcast frames, relevant the day multi-cam/B-roll arrives.
- **Professional editors still beat every published system** in pairwise preference (EditDuet, CineBench). The bar we set — "feels like a human editor" — is the documented frontier, not a solved problem.

## 4. Adopt / adapt / defer — changes to the harness informed by this research

**Adopt into the §9 team now:**
1. **Reviewer rubrics on a 0–1–2 scale** with per-level definitions and examples (replacing pure booleans in the verdict schema) — Opus's finding that finer scales destroy consistency, coarser ones lose the middle.
2. **Reviewer calibration harness modeled on Opus**: an anchor set with rerun-stability gating before any prompt promotion; a failure-mode catalog (5–10 minimal repro cases per class) as regression tests; agreement measured against Rajesh's decisions with the **75–80% ceiling as the target band, not 100%**.
3. **Reviewer instruction guardrails**: err toward keeping setup context (the documented over-punishing-long-hooks judge failure); constrained fix vocabulary (EditDuet's lesson — an unconstrained critic suggests operations the editor can't perform; our `suggestedFix` enum already is the constraint).
4. **Two-construct honesty in scoring**: rename/document `hook` etc. as *editorial judgment*, never performance prediction; no virality-score theater until real distribution data exists.
5. **Transcript-quality dependency made explicit**: segment quality is bounded by punctuation quality (Sieve engineered Whisper prompts for exactly this) — add a transcript-punctuation sanity check before planning, since our sentence grid depends on it.

**Already validated, keep as-is:** grounding aligner (strictest public variant), snapping + lead-in (Spotify does the same trim deterministically; PodReels' sentence-atoms), overlap dedupe keeping the higher score, ~30ms fades + handles in the render design, over-generation + human triage (the whole industry's shape — ours just tools the triage properly).

**Defer, in value order (signals beyond the transcript):** laughter/audio-event tags (cheapest non-transcript highlight signal; note Deepgram doesn't emit them — SenseVoice-class models or a jrgillick-class detector would), prosody/energy features (only with calibration data — zero-shot audio *hurt* in Rhapsody), shot-boundary guards (PySceneDetect) when multi-cam/B-roll arrives, TalkNet-class active-speaker detection at S10, behavioral-outcome calibration at S17.

## 5. Primary sources

Commercial: opus.pro/clipanything · opus.pro engineering blog (LLM-as-judge) · bigvu.tv Opus 2026 test · fluxnote.io Vizard review · autoposting.ai multi-tool test · descript.canny.io Underlord limitations · blitzcutai.com Riverside review · cybernews.com Klap review · nemovideo.com Munch review · heyeddie.ai · reap.video 2026 benchmark (self-published) · ppc.land YouTube Clips shutdown · forkoff.xyz clipping-economy pieces.
Open source: github.com/browser-use/video-use · modelscope/FunClip · linzzzzzz/openclip · ClipsAI/clipsai (dead) · WyattBlue/auto-editor · Breakthrough/PySceneDetect · TaoRuijie/TalkNet-ASD · FireRedTeam/FireRed-OpenStoryline · poseljacob/agentic-video-editor · nmbrthirteen/podcli (AGPL — ideas only).
Literature: arXiv 2505.23908 (Spotify previews) · 2410.16148 (PODTILE) · 2412.08879 (Repurpose-10K) · 2505.19429 (Rhapsody) · 2509.10761 (EditDuet) · 2311.05867 (PodReels) · 2504.00072 (Chapter-Llama) · 2507.02790 (HIVE) · 2603.28366 (AutoCut) · 2604.10456 (CineBench) · prosodic-boundary line (2209.15032; PLOS ONE spontaneous-speech study).
