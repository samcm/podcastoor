# Podcastoor

A conservative podcast RSS proxy for Pocket Casts. It processes recent episodes, removes model-detected ad/noise windows, rewrites feed metadata, and serves processed audio, transcripts, and chapters from disk.

The default mode is autonomous: on server startup it fetches the configured feeds, processes the last 7 days, downloads audio, transcribes timestamped chunks with an OpenRouter audio-capable model, classifies segments with OpenRouter/Qwen, renders processed audio, and serves rewritten feeds/assets.

## Current Shape

- RSS proxy endpoint per podcast: `/feeds/:podcastSlug.xml`
- Basic web UI:
  - `/` podcast list
  - `/podcasts/:podcastSlug` metadata and episode deep-dive
- Served artifacts:
  - `/audio/:podcastSlug/:episodeKey/episode.mp3`
  - `/assets/:podcastSlug/:episodeKey/chapters.json`
  - `/assets/:podcastSlug/:episodeKey/transcript.vtt`
- Recent-episode processing with a default 7 day lookback in the sample config and per-podcast overrides.
- Disk-backed manifests under `data/podcasts/:podcastSlug/episodes/:episodeKey/manifest.json`.
- Podlove Simple Chapters parsing and Podcasting 2.0 chapter JSON output.
- Feed transcript acquisition where feeds expose `podcast:transcript`.
- Cost-gated provider hooks for OpenRouter audio transcription, OpenAI transcription, feed transcripts, and OpenRouter text classification.
- Model-only timed ad decisions. There are no keyword-derived cuts or keyword-derived audit signals.
- One-time OpenRouter/Nano Banana stamped podcast artwork generation, preserving the upstream cover and adding an `AD-FREE` stamp.
- ffmpeg render path for cutting removal segments, preserving source MP3 audio with stream-copy where possible, and inserting a short marker tone.
- Web deep-dive shows RSS duration, real source duration, processed duration, source/processed players, an annotated cut timeline, and collapsed timestamped transcript rows.
- Disk-backed processing queue with attempt tracking, retry delay, quarantine after repeated failures, and admin reset controls.
- Admin-protected manual reprocess controls and runtime tuning overrides from the web UI.
- Cost dashboard showing spend by day, podcast, episode, model, and pipeline stage.

## Setup

```bash
npm install
npm run bootstrap
```

`config.example.yaml` is intentionally generic and contains no real podcast feed URLs. Add deployment-specific feeds in your private config file:

```yaml
podcasts:
  example-show:
    name: Example Show
    feedUrl: https://feeds.example.com/example-show.xml
    lookbackDays: 7
    categories:
      preferred:
        - interviews
      muted:
        - listener questions
```

Artwork stamping is generic and optional:

```yaml
artwork:
  enabled: true
  model: google/gemini-3.1-flash-image-preview
  stampText: AD-FREE
  imageSize: 1K
```

## Run

Optional dry-run recent episodes without downloading audio:

```bash
npm run dry-run -- --max-episodes 2
```

Start the local server:

```bash
npm run dev
```

The server processes on startup and every `automation.intervalMinutes`.

Operational controls are configured separately:

```yaml
retry:
  maxAttempts: 3
  retryDelayMinutes: 60
admin:
  token: "" # or set PODCAST_PROXY_ADMIN_TOKEN
```

Pocket Casts subscription URLs use the configured podcast slug:

```text
http://localhost:3729/feeds/example-show.xml
```

For a phone, `localhost` means the phone itself. Use your Mac's LAN IP, Tailscale IP, or a tunnel, then set `server.publicBaseUrl` to the externally reachable base URL before generating the feed.

## Web Operations

The homepage exposes the operational surface:

- **Processing Queue** shows queued, running, completed, failed, skipped, quarantined, and waiting-for-credits episodes.
- **Worker Activity** shows recent processing events.
- **Controls** can enqueue manual reprocess requests and reset failed/quarantined attempts.
- **Cost dashboard** is linked from the homepage at `/costs`.

Mutating requests require an admin token. Configure it in private deployment config or via `PODCAST_PROXY_ADMIN_TOKEN`. The public example intentionally leaves it empty.

Manual controls enqueue work for the autonomous worker instead of blocking HTTP requests. Supported scopes are one episode, one podcast, last N days globally, and failed/quarantined episodes. Options include force, dry-run, skip artwork, reuse transcript, and full reprocess.

Runtime tuning overrides are stored on disk, separate from deployment config:

```text
data/config/runtime-overrides.json
```

They can adjust global or per-podcast confidence threshold, cut padding, minimum/maximum cut duration, and marker tone enablement for future processing and forced reprocesses.

Cut padding is split into before/after controls. The default is conservative around starts: `prePaddingSeconds: 0` and `postPaddingSeconds: 0.4`, so uncertain boundaries leave a small ad remnant instead of chopping editorial audio before the detected ad.

## Real Audio Processing

The server processes automatically on startup and then on the configured interval. The standalone process command is still useful for testing or forcing a single podcast:

```bash
npm run process -- --podcast example-show --max-episodes 1 --no-dry-run --download-audio
```

This downloads the upstream MP3, applies timed removal decisions, inserts the configured marker tone for each removal, writes `episode.mp3`, writes chapters/transcript artifacts when available, and rewrites completed feed items to point at local assets.

Removal requires timed model decisions against timestamped transcript chunks. The app does not use configured ad keywords or phrase matches.

RSS duration is not trusted for rendering. Dynamic ad insertion can make the actual downloaded MP3 longer than the feed's `itunes:duration`, so the renderer probes the source file and maps cuts against the real audio timeline.

Qwen classifies timestamped transcript windows before audio is removed. Episode descriptions and publisher chapters are supplied as context, but the cut decision is model-only.

Chapters are normalized before serving: at most 10 items, topic-only labels, normally 1-4 words, and generated prefixes like `Discussion:` are stripped.

## OpenRouter

`OPENROUTER_API_KEY` is detected in the environment. OpenRouter is used by default for both transcription and text classification/chaptering:

```yaml
transcripts:
  preferred: openRouter
  providers:
    openRouter:
      enabled: true
      mode: audioChat
      model: xiaomi/mimo-v2-omni
      chunkSeconds: 180
llm:
  provider: openrouter
  enabled: true
  model: qwen/qwen3.6-flash
```

OpenRouter is also used for podcast artwork stamping when enabled. The current image model is `google/gemini-3.1-flash-image-preview`, OpenRouter's Nano Banana 2 listing. It edits the upstream cover once, stores the result under the podcast data directory, then rewrites RSS `image`, `itunes:image`, and episode image metadata to the local stamped asset.

There is no fallback model configured. If the model call fails, the service records the failure and does not silently swap to another model.

The text classifier is separate from transcription, so the pipeline is:

1. Audio download.
2. OpenRouter audio-chat transcription into timestamped utterance segments.
3. Forced-alignment pass when `ELEVENLABS_API_KEY` is available, returning provider word timestamps and remapping transcript segment boundaries.
4. Qwen text classification over timestamped transcript windows.
5. Model-returned absolute source timestamps mapped back to transcript segments.
6. Cut windows snapped to forced-aligned word timestamps when available.
7. ffmpeg cuts and marker-tone insertion.

The default alignment mode is `auto`. With `ELEVENLABS_API_KEY` set, it calls ElevenLabs `/v1/forced-alignment`; without that key, it falls back to `segment-boundary-v1` so processing does not hard-fail. Set `alignment.requireProvider: true` if missing forced alignment should fail the episode instead of falling back.

ElevenLabs forced alignment is extra hosted work. The app accounts for it with `alignment.estimatedCostPerMinuteUsd`, defaulting to `$0.003667/min`, equivalent to `$0.22/hour`, the published ElevenLabs Scribe STT API price at the time this was added. The forced-alignment API response does not include exact per-request spend, so this is recorded as an estimate.

## Transcription Providers

The provider order is:

1. Configured preferred provider, currently OpenRouter audio transcription
2. Feed-provided `podcast:transcript`
3. Experimental Pocket Casts endpoint template, disabled because there is no public Pocket Casts API
4. OpenAI transcription, disabled by default

OpenRouter and OpenAI providers need a downloaded source file, so they only run outside dry-run mode.

## Methodology Choice

The current best path with the available key is:

- OpenRouter `xiaomi/mimo-v2-omni` audio chat: best current OpenRouter-only default in the bounded bake-off, tying the best phrase accuracy at lower observed cost while returning usable timestamped JSON segments.
- Qwen 3.6 Flash on OpenRouter: text-only classifier over timestamped transcript windows, with exact request cost recorded from OpenRouter usage when available.
- Nano Banana 2 on OpenRouter: one-off cover-art editing only, not transcription or classification.
- ffmpeg: cuts timestamped windows with an accurate one-pass filter render, then encodes once at at least the configured/source bitrate and inserts the marker tone.

OpenRouter's dedicated STT endpoint currently returns text plus usage rather than native word timestamps, so the app uses OpenRouter audio-chat transcription by default and asks the audio model for strict timestamped JSON segments. Those timestamps are still model-generated, not forced-alignment timestamps. OpenRouter chat responses include `usage.cost`; the app records that exact model-call cost when present and only falls back to token-price estimates for preflight budgeting.

Timestamp precision notes and the forced-alignment path are tracked in [`docs/timestamp-precision.md`](docs/timestamp-precision.md).

## Data Layout

```text
data/
  assets/
    removed-ad-tone.mp3
  podcasts/
    example-show/
      assets/
        artwork-ad-free.png
        artwork-ad-free.json
      episodes/
        <episode-key>/
          manifest.json
          source.mp3
          episode.mp3
          chapters.json
          transcript.vtt
          transcript.json
  activity/
    events.json
  config/
    runtime-overrides.json
  queue/
    state.json
  usage/
    costs.json
```

## Verification

```bash
npm test
npm run typecheck
npm run build
npm run benchmark
```

The tests cover config merging, runtime override merging, feed parsing and rewriting, chapter preservation/remapping, model-only detector behavior, queue retry/quarantine state, cost aggregation, alignment timestamp usage, manifest storage, transcript benchmark math, and a bounded ffmpeg audio render fixture.

## Operating Notes

- Use `--dry-run` while tuning detection.
- Raise `processing.maxEpisodesPerRun` slowly.
- Keep `costs.perRunBudgetUsd` low until transcript/model behavior is measured.
- The homepage shows the latest worker activity from `data/activity/events.json`.
- The queue state is persisted in `data/queue/state.json`; failed episodes retry until `retry.maxAttempts`, then move to quarantine.
- Use the UI reset control to reset one episode, one podcast, or all failed/quarantined attempts so they retry on the next worker loop.
- Credit/auth failures mark the active episode as waiting-for-credits and stop additional provider calls for the rest of that processing run.
- Dynamic ads are currently handled when they appear in the downloaded audio/transcript and the model classifies the window. Multi-region audio diffing is a future improvement.
