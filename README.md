# Podcastoor

A conservative podcast RSS proxy for Pocket Casts. It processes recent episodes, removes model-detected ad/noise windows, rewrites feed metadata, and serves processed audio, transcripts, and chapters from disk.

The default mode is autonomous: on server startup it fetches the configured feeds, processes the last 7 days, downloads audio, transcribes timestamped chunks with OpenRouter STT, classifies segments with OpenRouter/DeepSeek, renders processed audio, and serves rewritten feeds/assets.

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
- Cost-gated provider hooks for OpenRouter STT, OpenAI transcription, feed transcripts, and OpenRouter/DeepSeek text classification.
- Model-only timed ad decisions. There are no keyword-derived cuts or keyword-derived audit signals.
- ffmpeg render path for cutting removal segments, preserving source MP3 audio with stream-copy where possible, and inserting a short marker tone.
- Web deep-dive shows RSS duration, real source duration, processed duration, source/processed players, an annotated cut timeline, and collapsed timestamped transcript rows.

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

Pocket Casts subscription URLs use the configured podcast slug:

```text
http://localhost:3729/feeds/example-show.xml
```

For a phone, `localhost` means the phone itself. Use your Mac's LAN IP, Tailscale IP, or a tunnel, then set `server.publicBaseUrl` to the externally reachable base URL before generating the feed.

## Real Audio Processing

The server processes automatically on startup and then on the configured interval. The standalone process command is still useful for testing or forcing a single podcast:

```bash
npm run process -- --podcast example-show --max-episodes 1 --no-dry-run --download-audio
```

This downloads the upstream MP3, applies timed removal decisions, inserts the configured marker tone for each removal, writes `episode.mp3`, writes chapters/transcript artifacts when available, and rewrites completed feed items to point at local assets.

Removal requires timed model decisions against timestamped transcript chunks. The app does not use configured ad keywords or phrase matches.

RSS duration is not trusted for rendering. Dynamic ad insertion can make the actual downloaded MP3 longer than the feed's `itunes:duration`, so the renderer probes the source file and maps cuts against the real audio timeline.

DeepSeek classifies timestamped transcript windows before audio is removed. Episode descriptions and publisher chapters are supplied as context, but the cut decision is model-only.

Chapters are normalized before serving: at most 10 items, topic-only labels, normally 1-4 words, and generated prefixes like `Discussion:` are stripped.

## OpenRouter

`OPENROUTER_API_KEY` is detected in the environment. OpenRouter is used by default for both transcription and text classification/chaptering:

```yaml
transcripts:
  preferred: openRouter
  providers:
    openRouter:
      enabled: true
      model: openai/gpt-4o-mini-transcribe
      chunkSeconds: 20

llm:
  provider: openrouter
  enabled: true
  model: deepseek/deepseek-v4-pro
```

There is no fallback model configured. If the model call fails, the service records the failure and does not silently swap to another model.

DeepSeek V4 Pro is text-only, so the pipeline is:

1. Audio download.
2. OpenRouter STT transcription into fixed timestamped chunks.
3. DeepSeek text classification over numbered transcript chunks.
4. Segment index alignment back to chunk timestamps.
5. ffmpeg cuts and marker-tone insertion.

## Transcription Providers

The provider order is:

1. Configured preferred provider, currently OpenRouter STT
2. Feed-provided `podcast:transcript`
3. Experimental Pocket Casts endpoint template, disabled because there is no public Pocket Casts API
4. OpenAI transcription, disabled by default

OpenRouter and OpenAI providers need a downloaded source file, so they only run outside dry-run mode.

## Methodology Choice

The current best path with the available key is:

- OpenRouter `openai/gpt-4o-mini-transcribe`: best transcript accuracy in the current bounded bake-off against Australian podcast clips, with observed OpenRouter cost around `$0.002/min`.
- DeepSeek V4 Pro on OpenRouter: text-only classifier over segment IDs, with exact request cost recorded from OpenRouter usage when available.
- ffmpeg: cuts timestamped chunk windows, stream-copies source MP3 audio where possible, and inserts the marker tone.

OpenRouter's STT endpoint currently returns text plus usage rather than native word timestamps, so this app chunks the source audio before transcription. The default is `openai/gpt-4o-mini-transcribe` with 20-second chunks; the text model can return estimated offsets inside the first and last chunk so cuts do not have to snap to whole chunks. OpenRouter chat responses include `usage.cost`; the app records that exact model-call cost when present and only falls back to token-price estimates for preflight budgeting.

## Data Layout

```text
data/
  assets/
    removed-ad-tone.mp3
  podcasts/
    example-show/
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

The tests cover config merging, feed parsing and rewriting, chapter timestamp remapping, model-only detector behavior, manifest storage, transcript benchmark math, and a bounded ffmpeg audio render fixture.

## Operating Notes

- Use `--dry-run` while tuning detection.
- Raise `processing.maxEpisodesPerRun` slowly.
- Keep `costs.perRunBudgetUsd` low until transcript/model behavior is measured.
- The homepage shows the latest worker activity from `data/activity/events.json`.
- Dynamic ads are currently handled when they appear in the downloaded audio/transcript and the model classifies the window. Multi-region audio diffing is a future improvement.
