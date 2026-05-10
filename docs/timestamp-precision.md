# Timestamp Precision Plan

Checked on 2026-05-10.

## Current Problem

The current pipeline can identify ad windows, but destructive cuts depend on timestamp precision. OpenRouter audio-chat transcription returns prompt-shaped segment timestamps, not provider-guaranteed word timestamps. A 2-10 second utterance segment can therefore put the model's ad boundary a few seconds away from the real audio boundary.

That is why a symmetric cut pad is risky: padding before the model's ad start can remove real content when the start timestamp is already early. The V1.5 default now uses asymmetric padding:

- `prePaddingSeconds: 0`
- `postPaddingSeconds: 0.4`
- `paddingSeconds: 0.6` remains only as a fallback for older runtime overrides

This intentionally accepts that a little ad tail may remain if the model is late, because clipping the next sentence of content is worse than leaving a short ad remnant.

## What Smaller Chunks Fix

Smaller transcription chunks can reduce drift inside each chunk and can make model prompts easier to reason over. They do not solve exact boundaries by themselves unless the STT provider returns word-level timing or the audio is forced-aligned afterwards.

Recommended practical tuning:

1. Keep transcription chunks in the 90-180 second range with overlap, not 10 seconds. Very short chunks lose conversational context and produce noisy duplicated fragments.
2. Keep text-classifier windows larger, around 3-5 minutes with overlap, so ads that cross a window boundary still have surrounding context.
3. Do a cheap edge-refinement pass only around candidate cuts. This pass should see about 20-40 seconds before and after each candidate boundary and decide whether to snap inward or outward.
4. Prefer under-cutting by default: snap to the first ad word for starts and the last ad word for ends, then apply zero or minimal padding.

## Better Alignment Options

The real upgrade is a separate alignment provider after transcription:

1. Generate the best transcript text available.
2. Align transcript words back to the waveform with a provider that returns word timestamps or with a forced aligner.
3. Let the ad model classify over aligned words/utterances.
4. Snap cuts to word boundaries and nearby silence boundaries.
5. Render from the snapped cut windows.

Good candidates:

- WhisperX: uses voice activity detection plus forced phoneme alignment for long-form transcription with word-level timestamps. Source: https://arxiv.org/abs/2303.00747
- ElevenLabs Forced Alignment: accepts audio plus transcript text and returns character and word timing. Source: https://elevenlabs.io/docs/api-reference/forced-alignment/create
- AssemblyAI word-level timestamps: pre-recorded STT responses include per-word start/end/confidence data. Source: https://www.assemblyai.com/docs/pre-recorded-audio/export-transcripts-as-srt-vtt-or-text#word-level-timestamps
- Deepgram or similar hosted STT providers: useful when the provider exposes word timestamps, confidence, utterances, and silence/endpointing metadata.

Whole-episode audio models are still useful as an audit signal, but current tested audio models produce model-estimated timestamps. They are not accurate enough by themselves for final destructive edit boundaries.

## UI/Operations Impact

The UI exposes before/after cut padding separately so each podcast can be tuned without editing deployment config. Runtime overrides are persisted in:

```text
data/config/runtime-overrides.json
```

Forced reprocesses will pick up the new cut policy and write a new processing signature, so older manifests can be distinguished from re-rendered episodes.

## Next Implementation Step

Add a dedicated `edge-refinement` stage before render:

1. For each model-confirmed ad window, extract transcript rows near the start and end.
2. Ask the text model to choose exact boundary segment IDs or word IDs, with a strict preference to avoid cutting editorial content.
3. If word-level alignment is available, snap to word timestamps.
4. If only segment timestamps exist, snap to segment boundaries and keep `prePaddingSeconds` at zero.
5. Store the raw model window, refined window, final rendered window, and reason in the manifest.

This limits extra LLM cost because it only runs on candidate ad boundaries, not the full episode.
