# Podcastoor

A conservative podcast RSS proxy for Pocket Casts. It processes recent episodes, removes model-detected ad/noise windows, rewrites feed metadata, and serves processed audio, transcripts, and chapters from disk.

The default mode is autonomous: on server startup it fetches the configured feeds, processes the last 7 days, downloads audio, transcribes timestamped chunks with an OpenRouter audio-capable model, classifies segments with an OpenAI-compatible text endpoint, renders processed audio, and serves rewritten feeds/assets.

## Current Shape

- RSS proxy endpoint per podcast: `/feeds/:podcastSlug.xml`
- Operator console web UI (React SPA, served from `/`):
  - `/` dashboard — KPIs, podcast grid, live activity, cost, quick actions
  - `/podcasts/:slug` — podcast detail with episode table, effective config, manual actions
  - `/podcasts/:slug/episodes/:key` — episode deep dive (source/processed timelines, decisions, transcript, chapters)
  - `/queue` — queue & runs, `/costs` — cost dashboard, `/tuning` — runtime tuning
  - backed by JSON view-model endpoints (`/api/dashboard`, `/api/queue-view`, `/api/cost-view`, `/api/tuning`, `/api/podcasts/:slug/episodes/:key`)
- Served artifacts:
  - `/audio/:podcastSlug/:episodeKey/episode.mp3`
  - `/assets/:podcastSlug/:episodeKey/chapters.json`
  - `/assets/:podcastSlug/:episodeKey/transcript.vtt`
- Recent-episode processing with a default 7 day lookback in the sample config and per-podcast overrides.
- Disk-backed manifests under `data/podcasts/:podcastSlug/episodes/:episodeKey/manifest.json`.
- Podlove Simple Chapters parsing and Podcasting 2.0 chapter JSON output.
- Feed transcript acquisition where feeds expose `podcast:transcript`.
- Cost-gated provider hooks for OpenRouter audio transcription, OpenAI transcription, feed transcripts, and OpenAI-compatible text classification.
- Model-only timed ad decisions. There are no keyword-derived cuts or keyword-derived audit signals.
- One-time OpenRouter/Nano Banana stamped podcast artwork generation, preserving the upstream cover and adding an `AD-FREE` stamp.
- ffmpeg render path for cutting removal segments, preserving source MP3 audio with stream-copy where possible, and inserting a short marker tone.
- Web deep-dive shows RSS duration, real source duration, processed duration, source/processed players, an annotated cut timeline, and collapsed timestamped transcript rows.
- Disk-backed processing queue with attempt tracking, retry delay, quarantine after repeated failures, and admin reset controls.
- Admin-protected manual reprocess controls and runtime tuning overrides from the web UI.
- Cost dashboard showing spend by day, podcast, episode, model, and pipeline stage.

## Setup

```bash
npm install            # backend deps
npm install --prefix web  # frontend deps
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

The server processes on startup and every `automation.intervalMinutes`. In production the API server also serves the built web UI from `web/dist`, so build it first with `npm run build` (compiles the server and bundles the frontend).

## Web UI development

The frontend is a Vite + React + TypeScript SPA under `web/`. For live development run the API server and the Vite dev server (which proxies `/api`, `/audio`, `/assets`, `/feeds` to the backend) side by side:

```bash
npm run dev        # API server on :3729
npm run web:dev    # Vite dev server on :5173 (open this)
```

To explore the UI with realistic data without configuring real feeds, seed a demo dataset:

```bash
npm run seed                       # writes config.seed.yaml + ./data-seed
npm run dev -- --config config.seed.yaml
npm run web:dev                    # then open http://localhost:5173
```

The seed writes eight plausible-but-fictional shows, episode manifests, a queue, a cost ledger, and activity. Mutating actions in the UI (reprocess, reset, save tuning) require the admin token — the seeded config uses `demo-admin-token`.

For a production-style run (no Vite), `npm run build` then `npm run server` serves the SPA and API together on one port.

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

Cut padding is split into before/after controls. The default is destructive-edit conservative on both sides: `prePaddingSeconds: 0` and `postPaddingSeconds: 0`. Uncertain boundaries leave a short ad remnant instead of chopping editorial audio.

## Real Audio Processing

The server processes automatically on startup and then on the configured interval. The standalone process command is still useful for testing or forcing a single podcast:

```bash
npm run process -- --podcast example-show --max-episodes 1 --no-dry-run --download-audio
```

This downloads the upstream MP3, applies timed removal decisions, inserts the configured marker tone for each removal, writes `episode.mp3`, writes chapters/transcript artifacts when available, and rewrites completed feed items to point at local assets.

Removal requires timed model decisions against timestamped transcript chunks. The app does not use configured ad keywords or phrase matches.

RSS duration is not trusted for rendering. Dynamic ad insertion can make the actual downloaded MP3 longer than the feed's `itunes:duration`, so the renderer probes the source file and maps cuts against the real audio timeline.

The configured text LLM classifies timestamped transcript windows before audio is removed. Episode descriptions and publisher chapters are supplied as context, but the cut decision is model-only.

Chapters are normalized before serving: at most 10 items, topic-only labels, normally 1-4 words, and generated prefixes like `Discussion:` are stripped.

## Model Providers

OpenRouter is used by default for timestamped audio transcription and artwork stamping. Text classification/chaptering uses an OpenAI-compatible chat completions endpoint so deployment can point it at OpenCode Go, OpenRouter, or another compatible gateway:

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
  provider: openai-compatible
  enabled: true
  model: deepseek-v4-pro
```

Set `TEXT_LLM_BASE_URL` to an OpenAI-compatible base URL such as `https://opencode.ai/zen/go/v1`, and set `TEXT_LLM_API_KEY` from private deployment secrets. The app appends `/chat/completions` unless the env var already includes it. Set `TEXT_LLM_PROVIDER_LABEL` if you want cost/manifest notes to show a friendly provider name. For legacy OpenRouter text calls, `llm.provider: openrouter` still works and can use `OPENROUTER_API_KEY`.

OpenRouter is also used for podcast artwork stamping when enabled. The current image model is `google/gemini-3.1-flash-image-preview`, OpenRouter's Nano Banana 2 listing. It edits the upstream cover once, stores the result under the podcast data directory, then rewrites RSS `image`, `itunes:image`, and episode image metadata to the local stamped asset.

There is no fallback model configured. If the model call fails, the service records the failure and does not silently swap to another model.

The text classifier is separate from transcription, so the pipeline is:

1. Audio download.
2. OpenRouter audio-chat transcription into timestamped utterance segments.
3. Alignment, either full-episode local WhisperX or targeted ElevenLabs windows depending on `alignment.provider`.
4. OpenAI-compatible text classification over timestamped transcript windows.
5. Model-returned absolute source timestamps mapped back to transcript segments.
6. Cut windows snapped to forced-aligned word timestamps when available.
7. ffmpeg cuts and marker-tone insertion.

The default alignment mode is `auto`, which requires local WhisperX alignment to succeed. There is no silent downgrade to segment-boundary cuts, because those cuts are too coarse for destructive ad removal. If WhisperX is missing, source audio is unavailable, or alignment fails, the episode fails and stays out of RSS until the runtime is fixed and the job is retried.

Before rendering, Podcastoor runs a content-loss guard over every removal window. If a model boundary lands inside a transcript segment without an exact anchor phrase that can be matched to forced-aligned words, the cut is moved inward to the nearest transcript boundary or downgraded to mark-only. The bias is deliberate: keep questionable audio instead of deleting real show content.

WhisperX alignment runs locally and records no hosted API cost. It does use local CPU/GPU time and model cache storage. ElevenLabs is available only when explicitly configured. Use `alignment.provider: elevenlabs-forced` for full-episode hosted alignment, or `alignment.provider: elevenlabs-targeted` for the hybrid path: Mimo transcribes the whole episode, the text model finds candidate ad windows, then ElevenLabs aligns only those candidate clips plus context. For hosted paths, set `alignment.estimatedCostPerMinuteUsd` so the ledger can estimate provider spend.

Targeted ElevenLabs alignment requires `ELEVENLABS_API_KEY` and supports these knobs:

```yaml
alignment:
  provider: elevenlabs-targeted
  model: elevenlabs-forced-alignment
  estimatedCostPerMinuteUsd: 0.003667
  targetContextSeconds: 30
  targetMaxWindows: 12
  targetMaxClipSeconds: 360
```

## Transcription Providers

The provider order is:

1. Configured preferred provider, currently OpenRouter audio transcription
2. Feed-provided `podcast:transcript`
3. Experimental Pocket Casts endpoint template, disabled because there is no public Pocket Casts API
4. OpenAI transcription, disabled by default

OpenRouter and OpenAI providers need a downloaded source file, so they only run outside dry-run mode. ElevenLabs is deliberately not a transcript provider; it can only run as a targeted alignment stage after the normal transcript/model pipeline has produced candidate ad windows.

## Methodology Choice

The current best path with the available key is:

- OpenRouter `xiaomi/mimo-v2-omni` audio chat: best current OpenRouter-only default in the bounded bake-off, tying the best phrase accuracy at lower observed cost while returning usable timestamped JSON segments.
- WhisperX local forced alignment: refines the transcript against the waveform and produces word-level timestamps used for final cut boundaries without adding API cost.
- ElevenLabs targeted alignment: optional hosted precision layer that aligns only candidate ad windows after model detection, keeping hosted cost proportional to suspected ad audio rather than episode length.
- OpenAI-compatible text endpoint: text-only classifier over timestamped transcript windows. The deployment can point this at OpenCode Go for subscription-backed calls or OpenRouter for usage-billed calls.
- Nano Banana 2 on OpenRouter: one-off cover-art editing only, not transcription or classification.
- ffmpeg: cuts timestamped windows with an accurate one-pass filter render, then encodes once at at least the configured/source bitrate and inserts the marker tone.

OpenRouter's dedicated STT endpoint currently returns text plus usage rather than native word timestamps, so the app uses OpenRouter audio-chat transcription by default and asks the audio model for strict timestamped JSON segments. Those timestamps are still model-generated, not forced-alignment timestamps. OpenRouter chat responses include `usage.cost`; the app records that exact model-call cost when present and only falls back to token-price estimates for preflight budgeting.

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
