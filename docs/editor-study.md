# Editor code study — techniques from open video editors

**Date:** 2026-08-21. **Method:** source-level study (shallow clones, code read, not READMEs) of six browser video-editing codebases, distilled here for the S8–S9 edit-spec/timeline/render work. File paths below refer to each upstream repo as of this date.

## Legal ground rules (non-negotiable)

Ideas, algorithms, architectures, and schema shapes are not copyrightable — learning from any of these projects is fine. Literal code is governed by license:

| Project | License | What we may do |
|---|---|---|
| WebAV, WebCut, OpenCut classic, Omniclip, OpenReel | MIT | Copy with attribution (retain license/copyright notice); pattern reuse free |
| MediaBunny | MPL-2.0 | **Depend on it as an npm package** in closed source; **never copy its source files** into our tree (file-level copyleft) |
| Twick (Sustainable Use License), Shotstack Studio (PolyForm Shield) | source-available, non-OSS | **Ideas only. Never copy or port code.** Their schemas/API shapes informed the gap list below; nothing else crosses over |

Rule of thumb: no file in Mitosia ever *starts* as a paste from any studied repo. If we copy an MIT snippet, it gets an attribution comment and the upstream license goes in a NOTICE entry.

## 1. Edit-spec design requirements (S8)

The tech-stack sketch (in/out ranges, layers, caption track ref, template ref, crop keyframes, audio chain) is directionally right — two commercial SDK schemas and three editors' data models converge on the same shape — but the study surfaced concrete gaps, ranked by how much we'd regret omitting them:

1. **Stable ids on every clip/layer/track**, persisted in the spec. Needed for undo, selection restore, player reconciliation, collaboration, and alias references. (Shotstack retrofits ids at load; persist them instead.)
2. **`schemaVersion` + a linear migration ladder inside the spec**, kept strictly separate from a `revision` mutation counter used for player sync. Twick conflates the two in one `version` field — a wart to avoid. OpenReel shipped a migration *stub* at "1.0.0" and now can't retrofit — design the ladder first.
3. **Source-offset vs timeline-placement as distinct first-class fields**: where the clip sits on the output timeline (`start`/`duration`) vs where it reads from the source (`sourceIn`), plus `playbackRate`. WebCut's left-trim bug (dragging the left edge *slides* media instead of cutting it, because the in-point wasn't a first-class field its trim path updated) is the canonical failure of merging these.
4. **Time as integer ticks (or rational frame index + timescale), never float seconds.** OpenCut classic uses branded integer ticks (`MediaTime`) with all rounding centralized; OpenReel's float-seconds model makes its "frame-accurate" claim marketing. A ~30-line TS module with a branded tick type gives the guarantee — µs/ticks in the spec, frames in the view-model, px only at the DOM edge.
5. **Timing intents, not only numbers**: `start: auto` (append), `length: auto|end`, and alias-to-another-clip timing (Shotstack's model). "This lower-third spans the whole output" and "captions follow this clip" must survive re-cutting; store intent, resolve at preview/render time.
6. **A general keyframe/tween substrate** (`property → scalar | tween[]` with interpolation/easing, normalized bezier handles serialized on the keyframe), with crop keyframes as one instance of it and animation *presets* compiled down into the same substrate so preset + manual animation compose instead of conflicting. Encode edge-anchoring ("sticks to clip end") as a keyframe field — OpenReel encodes it in id prefixes (`kf-exit-*`) and pays for it everywhere.
7. **Transitions** as explicit edges (outgoing clip → `toElementId`, duration, kind) — reserve the slot even if S8 ships without them.
8. **Ripple as a first-class multi-track operation in the model.** OpenCut computes ripple as a post-command diff (commands stay ripple-ignorant — good trick); OpenReel does single-track ripple and patches caption desync app-side (anti-example). For transcript-based cutting, ripple-delete of a range must shift caption/overlay layers in the spec, not in UI glue.
9. **Output block inside the spec** (fps, size, aspect preset, format): preview and render must read the same output params for parity.
10. **Caption model: transcript reference + segmentation params, cues derived.** Store word-level timings with confidence (from S3), reference the transcript artifact from the spec, keep segmentation knobs (`maxChars`, `maxDuration`, `maxSilence`) and a style-preset id + token overrides in the spec, and derive cues/SRT/VTT. Omniclip's dev branch does exactly this and it's the right substrate for transcript-based cutting; materializing cue clips (OpenCut) is the inferior shape. Twick's word-timing synthesis (proportional to character length) is the cheap fallback to avoid — we'll have real word timestamps.
11. **Placeholder media as a spec-level state** (Twick's placeholder element + `replaceElementsBySource`): a spec must be able to reference a source that isn't `ready` yet, with expected duration for layout — matches our async ingest lifecycle.
12. **Asset references by id, resolved per environment** — maps onto our `org/{orgId}/…` keys behind `/api/media/…` today and R2+CDN signed URLs at S18; referencing by id makes that a resolver change, not a spec migration. Include attribution fields the day stock assets appear.
13. **Layout semantics for cross-aspect outputs**: anchor position + normalized offsets + fit (Shotstack's model) resizes across 9:16/1:1/16:9 far better than absolute pixels against one declared resolution (Twick's model). Matters at S10.
14. **Audio chain minimum**: per-clip gain envelope (volume as keyframeable property), mute, and a global music-bed slot.
15. Smaller reserved slots: mattes/masks with an explicit mask↔content link; chapters/markers in project metadata (nearly free, directly useful for YouTube outputs); watermark as a first-class track-independent concept (how plan-based watermarking resists deletion).
16. **Spec schema is Zod `.strict()` from day one** with path-addressed validation errors — non-strict schemas silently strip typo'd fields (Shotstack's own TODO warns of this).

Validation of the overall bet: WebCut independently converged on "versioned declarative JSON describing how to reconstitute runtime objects" as its persistence layer, and WebAV's `split()` is an edit-spec in disguise (ranges over an immutable source). The canonical-spec architecture is the industry shape, not a Mitosia eccentricity.

## 2. Parity architecture (S8–S9): one interpreter for the spec

Twick's strongest idea: **one renderer definition consumed by the browser player, the browser exporter, and the render server** — preview and final render cannot drift because only one interpretation of the JSON exists. Shotstack's browser exporter is a *re-implementation* of their API renderer and can drift (they compensate with a shared layout engine for captions). For Mitosia: **the Remotion composition is the single edit-spec interpreter**, used by the Player in the browser and by server-side Remotion render; FFmpeg handles the non-interpreting steps (cut/loudness/mezzanine) and its output is verified against the same spec (the S2 duration-verification lesson generalizes).

Sync contract between editor and player: **revision-stamped one-way data push with explicit ready acknowledgment** (editor emits spec + revision; player host rebuilds only on revision mismatch and signals ready), never two-way binding into the player. Pin caption typography (font family, line-height) explicitly or browser preview and server render drift.

Preview vs export quality: one effect/render library parameterized by a quality flag (OpenReel's `realtime: true` option on the same `renderFrame`) — never two implementations.

## 3. Timeline view architecture (S8)

**The scale decision: canvas track area, DOM chrome.** OpenCut classic and OpenReel both render clips as absolutely-positioned DOM nodes with no virtualization; at 2 hours × max zoom that's a 36M-pixel-wide scroller — past browser layout caps — and thousands of live nodes at transcript-cut granularity. Omniclip's rewrite (dev branch, active) draws clips/ruler/playhead/snap-lines/ghosts into **one viewport-sized canvas** (DPR-scaled, `ctx.translate(-scrollLeft, 0)`), with a thin invisible spacer div carrying scroll width, rAF-coalesced dirty-flag redraws, reverse-scan hit-testing, and pointer capture dispatching to an active-tool object. Cost is O(visible boxes) at any zoom. The hybrid is: canvas for the track area (clips, waveforms, filmstrips, indicators), shadcn/DOM for toolbar, track headers, context menus. One polish detail worth keeping: scrollable extent only shrinks on zoom change, otherwise monotonic (no scroll-range jitter while editing near the end).

**Time↔pixel and zoom** (OpenCut classic, pure functions, copy-worthy): one formula `px = ticks/TPS × base × zoom`; device-pixel snapping for crisp 1-px lines; exponential zoom slider (`min × (max/min)^t`); duration-aware min zoom ("project fits in ~25% of viewport" — a 2-hour source can always be seen whole); ctrl/meta-wheel zoom with deltaMode normalization and `factor = exp(−delta/300)`; cursor-anchored zoom (keep the time under the cursor fixed by rewriting scrollLeft — Omniclip's `setZoomAt` is the simple version), anchored to playhead-if-visible-else-center for keyboard zoom.

**Ruler**: windowed tick generation (render only `[scrollLeft − buffer, +width + buffer]`) with a zoom-adaptive interval ladder (frames → seconds → minutes; tick interval forced to divide label interval; frame labels at deep zoom). Both OpenCut and OpenReel implement this correctly — and OpenReel proves the point by windowing *only* the ruler and choking on the clips.

**Gesture engineering** (the "feel" inventory — OpenCut classic controllers + OpenReel's drag pipeline, mutually confirming):
- Gestures are **framework-free state-machine classes** (`idle | pending | dragging`) reading DOM/config through a committed ref the React layer refreshes each render; listeners attach to `document` on mousedown, detach on finish. React-19/StrictMode-safe, testable.
- **5 px drag threshold** before mousedown becomes drag; return-to-origin on mouseup = cancel, not a 0-px move; a `lastGestureWasDrag` flag outlives the gesture because React's click fires after mouseup; marquee sets a suppress-next-click ref so it doesn't clear its own selection.
- **During drag: visual `transform` now, rAF-coalesced store commit once per frame, forced flush on release** (OpenReel's comment documents the memory-exhaustion failure of committing per mousemove). Drags anchor to the grab point inside the clip.
- **History grouping wraps the whole gesture** (begin on start, end on mouseup *and* in effect cleanup, guarded) so undo is one step per drag.
- **Seek is click-gated** (≤5 px, ≤500 ms) so drags never cause accidental seeks; ruler scrub disables element-edge snapping for the initial click (no jarring jump), enables it on move; Shift suppresses snap; frame snap always applies.
- **Edge auto-scroll**: rAF loop, ~100 px zones, speed proportional to edge proximity (max ~15 px/frame), ruler + tracks in lockstep.
- **Escape cancels any gesture**, restoring pre-drag state. Multi-clip drag = snapshot companions at start, apply primary delta; hit-test against a **frozen snapshot** of layout, never mid-mutation state.
- **Shortcut vocabulary**: space/K play-pause, J/L shuttle (1×/2×/4× ladder), ←/→ frame step, shift+←/→ 5 s, S split, Q/W trim-start/end-to-playhead, up/down previous/next clip edge, N snap toggle, ctrl+D duplicate. Hold-a-tool-key for temporary tool switch (Omniclip) is premium polish if a blade tool ships.

**Snapping** (OpenCut `timeline/snapping/*`, ~90 dependency-free lines — copy nearly verbatim): pluggable `SnapPoint` sources (clip edges, playhead, bookmarks, keyframes — add **transcript word/segment boundaries**, a 10-line source), threshold defined in pixels and converted to ticks so feel is zoom-invariant (10 px), both edges of the dragged clip tested, ties resolved by priority class, one indicator line rendered at timeline level. For multi-clip drags, Omniclip's trick: pre-offset targets by each moving clip's edge offsets so one scalar snap test covers every edge of every dragged clip.

**Playhead discipline** (OpenCut): playback time flows on a **non-React channel**; the playhead node's `style.left` is written imperatively (viewport-relative: `centerPixel − scrollLeft` inside a non-scrolling overlay); React re-renders only on discrete events. Follow-scroll only during playback (recenter on exit — or OpenReel's nicer variant: keep the playhead in the left 12% so most of the viewport is lookahead), never while scrubbing. Playhead is `role="slider"` with arrow-key stepping.

**Filmstrips and waveforms — demand-driven tiles** (Omniclip's contract, our data): per visible clip, the draw loop reports `{visible source-time range, required frequency}`; a tile provider returns 100-px tiles, remapping *existing* tiles to nearest new timestamps as instant placeholders on zoom change (no white flash), LRU-evicting offscreen clips. Back this with **server-side artifacts** — thumbnail sprite tiles from ingest and peaks JSON — fetched through the media proxy; never in-browser full-file decode (OpenCut's `decodeAudioData`-the-whole-file waveform is ~2.6 GB of PCM at 2 h — the canonical anti-pattern). OpenCut's bucket-resampling (map buckets through trim/retime so strips stay correct mid-gesture) and preallocated fixed-length progressive waveform arrays (full-length render instantly, fill in) transfer directly to rendering our peaks JSON.

## 4. Preview, scrubbing, playback (S8)

- **Pull-based time**: a clip/composition renders for an arbitrary `t`; the caller owns the clock (WebAV `tick(time)` = the Remotion model). Validates edit-spec preview as a pure function of time. Dual policy: realtime preview is *non-blocking* (draw last frame, update async — may lag a frame, never stalls); export is *awaited* (frame-exact). Don't chase frame-perfect preview; make export frame-perfect.
- **Store-mediated scrub, settle on release** (OpenReel): pointer moves only update the store; a debounced observer drives the player; audio/clock are touched **once** at scrub end with the final position.
- **Stale-seek cancellation** (WebAV): mark in-flight seek work stale when a new target arrives, last-request-wins, without tearing down the pipeline. Same pattern for transcript-click seek storms.
- **Render gate for multi-layer seeks** (WebAV `previewFrame`): hold the last composite until *every* layer has produced its frame for the new time — never paint layer N's new frame over layer M's old one.
- **Lookahead warm-up**: when the playhead approaches an edit-spec cut boundary, pre-seek the engine toward the next segment's in-point (WebAV warms clips starting within 1 s).
- **Ghost playhead hover-preview** (Omniclip): while paused, hovering the timeline (or a transcript segment) silently seeks the preview to hover time, reverting on leave. Zero-click review; pairs beautifully with transcript-first UX.
- **Caption layer memoization** (WebAV's subtitles clip): a caption frame carries `duration = cue end − now`, so re-render happens on cue change, not per frame.
- If we ever hold ImageBitmaps/VideoFrames: close every non-emitted frame, and when a scrub render is abandoned by timeout, attach a disposal callback to the still-in-flight render — dropped scrub frames otherwise leak GPU memory (OpenReel fixed this after shipping it).

## 5. Media access layer: MediaBunny (adopt as dependency)

The one library worth taking as a dependency rather than a pattern (MPL-safe as a package; very active, corporate-sponsored — including by Remotion). What it gives us over our existing HLS proxies, verified in its source:

- **`UrlSource` → HLS demuxer → packet-accurate access over the whole proxy.** Full VOD playlist support (master playlists, fMP4 and TS segments, byte-ranges, init-segment sharing, LRU of 4 open segment inputs), with a subtle playlist-vs-media clock reconciliation that keeps cross-segment timestamps frame-accurate. Seek cost: binary search + one ranged segment-header read.
- **`EncodedPacketSink.getPacket(t, {metadataOnly: true})`** — the exact sample timestamp/duration grid around a transcript cut point *without decoding*: frame-accurate trim math for the edit-spec, resolved client-side against the proxy.
- **`CanvasSink.canvasesAtTimestamps(sorted)` with a canvas pool** — GOP-batched sparse decode (each packet decoded at most once per strip), constant VRAM while scrubbing; manual mipmapping for quality thumbnails. This is the on-demand fallback/complement to ingest-time sprite tiles.
- Engineering patterns to mirror in our own code: exponential network readahead on detected sequential access; 40-encoded/8-decoded queue backpressure; probe-don't-trust codec feature detection (encode a real test frame; `isConfigSupported` lies on Firefox); precise-trim semantics (trim start forces decode-from-exact-t + re-encode; audio trimmed at PCM frame index) — the math our server-side edit-spec executor should mirror so preview and final agree.

**Prerequisites/wins on our side:**
- The media proxy (`/api/media/[...path]`) must honor `Range` and return **206** — MediaBunny silently degrades to sequential-only mode on a 200. Worth an e2e assertion.
- **Emit an I-frame-only playlist (`#EXT-X-I-FRAME-STREAM-INF`) from the HLS ladder** (`lib/media/hls.ts`): makes keyframe-only filmstrip decode dramatically cheaper for any client, and MediaBunny already models it (`hasOnlyKeyPackets`). Cheap flag on the existing ffmpeg run.

Final render stays server-side FFmpeg/Remotion: MediaBunny's conversion path is single-trim, full re-encode — right for future browser *draft* clips, wrong for multi-cut edit-spec renders.

## 6. History, undo, persistence (S8)

- **Proposal/overlay editing** (Omniclip's `Proposal`; OpenCut's `previewOverlay` is the same idea): uncommitted gesture edits live in an overlay map over the committed spec; every read path (canvas layout, player feed) transparently reads overlay-else-committed; commit = **one spec revision**, cancel = free, history never sees per-mousemove states. This is the cleanest mapping onto our versioned edit-spec and the mechanism that keeps Remotion preview from re-rendering per mousemove.
- **History mechanism**: with one canonical JSON spec, snapshot/patch history (inverse JSON patches per revision) beats 30 command classes — but steal three command-system refinements: auto-grouping rapid same-type/same-target actions within ~100 ms; **selection snapshots restored only when the command declared a selection override** (undo doesn't stomp your clicks); post-command "reactor" invariants (e.g. prune empty tracks) instead of duplicating cleanup in every operation. OpenReel's three parallel undo stacks reconciled by timestamp — the price of state living outside the canonical document — is the strongest argument for *everything editable lives in the spec*.
- **Reconciling restore** (WebCut): applying a historical/remote spec version diffs against live state and mutates only changed layers (never re-decode video for a rect change) — the same discipline as spec-revision-driven player updates.
- **Autosave** (OpenReel): separate store, 30 s interval + 2 s debounce, **3 rotating slots**, dirty-hash to skip no-op saves, recovery dialog on boot. Our spec is server-owned, but browser-side crash recovery of uncommitted edits wants exactly this shape.

## 7. Anti-patterns catalogue (observed failures, not hypotheticals)

- Float seconds as the time substrate; frame stepping hardcoded to 1/30 (OpenReel).
- No clip/track virtualization + full-duration-width DOM scroller (OpenCut, OpenReel) — breaks at 2 h.
- Media in-point not first-class in trim paths → left-trim slides media (WebCut).
- Whole-file `decodeAudioData` for waveforms / whole-file in-memory media models (OpenCut, OpenReel, Omniclip's transcriber) — our server-artifact architecture is the fix; never reintroduce client full-file decode.
- Deep-clone-the-project per action for inverse generation, per mousemove (OpenReel pre-fix).
- Keyframe semantics encoded in id string prefixes (OpenReel).
- Schema version as migration stub / conflated with revision counter (OpenReel, Twick).
- Two parallel playback architectures, one used; a complete export worker never wired up (OpenReel) — delete the unused path or don't build it.
- Seek-jiggle cache invalidation (`previewFrame(t+1); (t−1); (t)`) instead of an explicit invalidation path (WebCut).
- Caption desync patched in UI glue because ripple isn't multi-track in the model (OpenReel).

## 8. Sprint hooks

- **Now / S3**: transcript viewer click-to-seek uses stale-seek cancellation (§4); caption/word data model per §1.10 lands with the S3 transcript schema so S8 derives cues instead of re-modeling. Ingest: I-frame playlist + proxy 206 assertion (§5).
- **S8**: edit-spec schema per §1 gap list; parity architecture per §2; timeline per §3 (canvas track area, OpenCut math/snapping/gestures, tile contract); proposal-overlay history per §6; MediaBunny dependency for trim-grid + on-demand filmstrip (§5).
- **S9**: server executor mirrors MediaBunny's precise-trim semantics (§5); one spec interpreter, quality-parameterized (§2).
- **S10**: normalized layout semantics for aspect variants (§1.13).
- **S18**: asset-id resolver swap to signed CDN URLs (§1.12); fastStart/moov-placement taxonomy for delivery encodes (MediaBunny's four-mode model).

*Clones from the study live in the session scratchpad (ephemeral). The five full agent reports with exhaustive per-file citations are in the session transcript of 2026-08-21; this document is the durable distillation.*
