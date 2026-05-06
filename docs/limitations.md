# V1 Limitations and Next Steps

## What Is Working

- The project starts as a local server and exposes podcast RSS endpoints.
- It fetches the three configured real feeds.
- It decides recent eligibility from feed dates and lookback config.
- It writes disk manifests per episode.
- It records ad-like metadata signals even without transcripts.
- It parses Podlove Simple Chapters and writes Podcasting 2.0 chapter JSON.
- It can rewrite completed feed items to local audio, chapter, and transcript asset URLs.
- It has a real ffmpeg render path with optional marker tone insertion.
- It has a transcript benchmark path for comparing reference and candidate transcripts.

## Intentional Boundaries

The service does not cut audio from untimed metadata signals. Sponsor links in descriptions are strong clues, but they do not identify the exact audio window. Cutting from those alone would risk deleting content.

The default config calls OpenRouter for STT and text-only segment classification, but does not use a secondary model if those calls fail.

Pocket Casts generated transcripts are not used by default. There is no public Pocket Casts API, so any discovered endpoint should be treated as experimental and replaceable.

## Gaps

- Dynamic ad removal depends on ASR/model detection after the inserted audio appears in the downloaded file. There is not yet an audio-fingerprint diff across multiple regional downloads.
- No diarization-aware classification yet.
- Web UI is read-only: it shows source/processed audio, clickable cut annotations, and removed transcript rows, but does not yet save manual edits.
- No purge/retention policy, by design for this spike.
- No queue persistence beyond manifests.
- No multi-worker processing.
- No authentication on served feeds/assets.
- RSS rewrite is conservative and only changes completed processed episodes.

## Next Steps

1. Add a review workflow:
   - show manifest decisions,
   - allow manual segment edits,
   - re-render one episode.

2. Add a transcript pipeline:
   - OpenAI transcription provider option,
   - optional forced-alignment provider,
   - transcript cache keyed by audio fingerprint,
   - WER comparison against feed or Pocket Casts reference transcripts when available.

3. Add dynamic ad detection:
   - download the same enclosure from two network regions,
   - compare audio fingerprints and durations,
   - detect insertion windows,
   - classify discontinuities with transcript snippets.

4. Add model-assisted chapters:
   - enable OpenRouter only after budget checks,
   - use `deepseek/deepseek-v4-pro` for long transcripts that need coherence,
   - benchmark cheaper text models only if they preserve cut quality.

5. Improve Pocket Casts compatibility:
   - test a public tunnel URL on a phone,
   - verify transcript and chapter display in the app,
   - watch server logs for Pocket Casts feed parser requests.

6. Add observability:
   - per-run JSON summary,
   - Prometheus-style metrics,
   - cost ledger by provider/model,
   - detection precision notes by podcast.
