# Timestamp Precision Plan

Checked on 2026-05-14. Updated after a bounded production-episode boundary benchmark.

## Current Problem

The current pipeline can identify ad windows, but destructive cuts depend on timestamp precision. OpenRouter audio-chat transcription returns prompt-shaped segment timestamps, not provider-guaranteed word timestamps. A 2-10 second utterance segment can therefore put the model's ad boundary a few seconds away from the real audio boundary.

That is why a symmetric cut pad is risky: padding before the model's ad start can remove real content when the start timestamp is already early. The V1.5 default now uses asymmetric padding:

- `prePaddingSeconds: 0`
- `postPaddingSeconds: 0`
- `paddingSeconds: 0.6` remains only as a fallback for older runtime overrides

This intentionally accepts that a little ad tail may remain if the model is late, because clipping the next sentence of content is worse than leaving a short ad remnant.

## What Smaller Chunks Fix

Smaller transcription chunks can reduce drift inside each chunk and can make model prompts easier to reason over. They do not solve exact boundaries by themselves unless the STT provider returns word-level timing or the audio is forced-aligned afterwards.

Recommended practical tuning:

1. Keep transcription chunks in the 90-180 second range with overlap, not 10 seconds. Very short chunks lose conversational context and produce noisy duplicated fragments.
2. Keep text-classifier windows larger, around 3-5 minutes with overlap, so ads that cross a window boundary still have surrounding context.
3. Do a cheap edge-refinement pass only around candidate cuts. This pass should see about 20-40 seconds before and after each candidate boundary and decide whether to snap inward or outward.
4. Prefer under-cutting by default: snap to the first ad word for starts and the last ad word for ends, then apply zero padding unless a podcast has been manually tuned.

## Implemented Alignment Path

The pipeline now has a local forced-alignment path:

1. Generate the best transcript text available.
2. Send downloaded source audio plus transcript segments to local WhisperX.
3. Let the ad model classify over aligned words/utterances.
4. Snap cuts to provider word boundaries when available.
5. Render from the snapped cut windows.

Default config uses:

```yaml
alignment:
  enabled: true
  provider: auto
  model: whisperx
  estimatedCostPerMinuteUsd: 0
  requireProvider: true
  targetContextSeconds: 30
  targetMaxWindows: 12
  targetMaxClipSeconds: 360
```

`auto` means: use local WhisperX and fail the episode if forced alignment is unavailable. There is no segment-boundary fallback in normal processing, because segment-only boundaries are not precise enough for destructive cuts.

WhisperX uses phoneme-level forced alignment to produce word-level timestamps. Source: https://arxiv.org/abs/2303.00747

WhisperX runs locally and records no hosted API cost. It does consume CPU/GPU time and model cache storage. ElevenLabs forced alignment remains available only when explicitly configured with `provider: elevenlabs-forced`; it accepts audio plus transcript text and returns word/character timings. `provider: elevenlabs-targeted` uses the same hosted alignment endpoint only after ad detection, extracting candidate windows plus context and aligning those clips instead of the full episode. Source: https://elevenlabs.io/docs/api-reference/forced-alignment/create

ElevenLabs API pricing lists Scribe speech-to-text at `$0.22/hour`, which is `$0.003667/min`; forced alignment is documented at the same rate. If a hosted alignment path is configured, set `alignment.estimatedCostPerMinuteUsd` so the app records an estimated alignment cost. With targeted alignment, a one-hour episode with 10 minutes of suspicious windows costs roughly `$0.037` for the alignment stage rather than `$0.22` for full-episode alignment. Source: https://elevenlabs.io/pricing/api?price.section=speech_to_text

Other candidates remain useful future options:

- AssemblyAI word-level timestamps: pre-recorded STT responses include per-word start/end/confidence data. Source: https://www.assemblyai.com/docs/pre-recorded-audio/export-transcripts-as-srt-vtt-or-text#word-level-timestamps
- Deepgram or similar hosted STT providers: useful when the provider exposes word timestamps, confidence, utterances, and silence/endpointing metadata.

Whole-episode audio models are still useful as an audit signal, but current tested audio models produce model-estimated timestamps. They are not accurate enough by themselves for final destructive edit boundaries.

## UI/Operations Impact

The UI exposes before/after cut padding separately so each podcast can be tuned without editing deployment config. Runtime overrides are persisted in:

```text
data/config/runtime-overrides.json
```

Forced reprocesses will pick up the new cut policy and alignment config, write a new processing signature, and store alignment metadata in each manifest: provider, model, confidence, word count, estimated cost, adjusted segments, and max adjustment.

## Boundary Precision Update

The bounded production benchmark showed the real precision failure:

1. Segment-level STT left 2-8 second utterance chunks.
2. The ad model could find the right ad block but sometimes put the boundary at the whole mixed segment.
3. Audio-only OpenRouter models were cheap, but not accurate enough to trust for destructive cuts by themselves.
4. The reliable path is semantic detection plus word-level alignment and anchored boundary repair.

The pipeline now asks the classifier for mandatory `startAnchorText` and `endAnchorText` whenever a cut starts or ends inside a mixed transcript segment. After WhisperX or another word-level aligner runs, those anchor phrases are matched back to aligned words and the final decision is snapped to the first/last ad word rather than the coarse segment edge.

Before rendering, a content-loss guard checks every removal window. If a boundary is inside a transcript segment and the requested anchor does not match forced-aligned words at that boundary, the guard moves the boundary inward to the nearest transcript edge. If that would leave no safe cut, the decision becomes mark-only. This may leave ad audio behind, but it prevents deleting editorial speech.

The renderer also expands cuts over adjacent non-speech transition segments such as `[Music]`, `[Jingle]`, or `[Silence]`. That fixes dynamically inserted ad breaks where the model correctly finds the spoken ad copy but leaves a 5 second music bed before or after it.

The target production shape is now:

1. Detect broad ad candidates from transcript windows.
2. Include phrase anchors for mixed boundary segments.
3. Force-align transcript words to the actual downloaded audio.
4. Snap ad cuts to anchor word timestamps when available.
5. Expand only across adjacent structural non-speech transition audio.
6. Render with zero pre-padding and zero default post-padding.

If forced alignment is unavailable, the episode fails and stays out of RSS until the runtime is fixed and the job is retried.
