# V1 Limitations and Next Steps

## What Is Working

- The project starts as a local server and exposes podcast RSS endpoints.
- It fetches configured real feeds.
- It decides recent eligibility from feed dates and lookback config.
- It writes disk manifests per episode.
- It parses Podlove Simple Chapters and external Podcasting 2.0 chapter JSON, then writes remapped Podcasting 2.0 chapter JSON.
- It can rewrite completed feed items to local audio, chapter, and transcript asset URLs.
- It has a real ffmpeg render path with optional marker tone insertion.
- It has a transcript benchmark path for comparing reference and candidate transcripts.
- It has persisted queue state, retry/quarantine policy, admin reset controls, runtime tuning overrides, and a cost dashboard.

## Intentional Boundaries

The service does not use keyword-derived cuts or keyword-derived metadata signals. Episode descriptions and publisher chapters are context for the model, not independent decision rules.

The default config calls OpenRouter for audio-chat transcription and text-only segment classification, but does not use a secondary model if those calls fail.

Pocket Casts generated transcripts are not used by default. There is no public Pocket Casts API, so any discovered endpoint should be treated as experimental and replaceable.

## Gaps

- Dynamic ad removal depends on ASR/model detection after the inserted audio appears in the downloaded file. There is not yet an audio-fingerprint diff across multiple regional downloads.
- No diarization-aware classification yet.
- Local WhisperX forced alignment is implemented as the default `alignment.provider: auto` path. If the local runtime is unavailable, processing fails instead of falling back to coarse segment-boundary cuts. Hosted targeted ElevenLabs alignment is available with `alignment.provider: elevenlabs-targeted`, but it requires `ELEVENLABS_API_KEY` and only runs on model-proposed ad windows.
- Web UI can enqueue reprocess/reset/tuning actions, but does not yet save manual segment edits.
- No purge/retention policy, by design for this spike.
- Queue state is persisted, but there is still no multi-worker locking beyond the single intended worker deployment.
- No multi-worker processing.
- No authentication on served feeds/assets.
- RSS rewrite is conservative and only changes completed processed episodes.

## Next Steps

1. Add a review workflow:
   - show manifest decisions,
   - allow manual segment edits,
   - re-render one episode.

2. Add a transcript pipeline:
   - Qwen3-ASR/Qwen3-ForcedAligner or another word-timestamp provider as an alternative or complement to WhisperX/targeted ElevenLabs,
   - boundary snapping to word/silence timestamps,
   - transcript cache keyed by audio fingerprint,
   - WER comparison against feed or Pocket Casts reference transcripts when available.

3. Add dynamic ad detection:
   - download the same enclosure from two network regions,
   - compare audio fingerprints and durations,
   - detect insertion windows,
   - classify discontinuities with transcript snippets.

4. Add model-assisted chapters:
   - enable text LLM calls only after budget checks,
   - use the configured OpenAI-compatible text endpoint for ad classification,
   - benchmark cheaper text models only if they preserve cut quality.

5. Improve Pocket Casts compatibility:
   - test a public tunnel URL on a phone,
   - verify transcript and chapter display in the app,
   - watch server logs for Pocket Casts feed parser requests.

6. Add observability:
   - richer per-run JSON summary,
   - Prometheus-style metrics,
   - cost ledger by provider/model,
   - detection precision notes by podcast.
