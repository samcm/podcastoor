# Methodology Evaluation

Checked and exercised on 2026-05-06.

## Methods Considered

| Method | API Cost | Timestamp Quality | Result |
| --- | ---: | --- | --- |
| Metadata/description keywords | $0 | None | Rejected. The app no longer emits keyword-derived signals or cuts. |
| Existing feed chapters | $0 | Good for topics, not ads | Preserve/remap when present; not enough for ad removal. |
| OpenRouter `openai/whisper-large-v3-turbo` STT | `$0.000667/min` published | Chunk-level timestamps from pre-splitting | Current default because only OpenRouter key is available. |
| Groq `whisper-large-v3-turbo` direct | `$0.000667/min` published | Segment/word timestamps | Best cheap alignment upgrade once `GROQ_API_KEY` exists. |
| Mistral Voxtral Mini Transcribe V2 | `$0.003/min` published | Word timestamps + diarization | Better claimed WER, higher cost, needs `MISTRAL_API_KEY`. |
| Qwen3-ASR-Flash | About `$0.0021/min` international | Word timestamps | Modern contender, needs Alibaba/DashScope integration. |
| OpenAI transcription | Paid per minute | Good transcript endpoint option | Kept as provider option, disabled while OpenRouter STT is preferred. |
| OpenRouter audio LMMs | Paid/varies | No stable forced-alignment contract | Useful for experiments, not default. |
| DeepSeek V4 Pro text classifier | Stronger long-context reasoning with still modest cost | Uses ASR segment IDs | Chosen classifier/chapter model. |

## Current Pipeline

DeepSeek V4 Pro is text-only on OpenRouter. The service therefore does not send podcast audio directly to DeepSeek.

The running pipeline is:

1. Fetch RSS.
2. Download the real audio enclosure.
3. Probe the actual MP3 duration with ffprobe.
4. Split audio into short chunks and transcribe each chunk through OpenRouter STT.
5. Send numbered timestamped chunks, episode description, and publisher chapters to `deepseek/deepseek-v4-pro`.
6. Ask the model to return segment index ranges plus optional start/end offsets inside boundary chunks.
7. Convert segment index ranges and offsets back to source-audio windows.
8. Merge/pad removal windows.
9. Render with ffmpeg, stream-copying source MP3 audio where possible, and insert the marker tone.
10. Rewrite RSS to local audio, chapter, and transcript URLs.

## Deployment Evaluation

Real feed names, private subscription URLs, and per-episode run results belong in deployment notes or private observability data. The public project keeps methodology and tooling only.

Completed OpenRouter text calls record the exact `usage.cost` returned in the response when available. Published token prices are used only for preflight budgeting. A UI row can therefore show nonzero STT cost and zero text LLM calls when transcription succeeded but the text classifier failed or timed out before a billable generation was recorded.

## Alignment Finding

The bad cut precision is structural, not a keyword problem. OpenRouter's tested STT wrapper returns one transcript text result per audio chunk, so the current renderer only has chunk windows plus model-estimated offsets inside those windows. That can work for coarse removal, but it is not a real forced-alignment layer.

The better pipeline is:

1. Transcribe with a provider that returns word-level timestamps.
2. Let the text model classify candidate ad spans using transcript text, episode description, and publisher chapters.
3. Snap the model's start/end decision to the nearest word boundary or silence boundary.
4. Render cuts from those snapped boundaries, with minimal or zero padding.

Groq direct is the first practical upgrade because its speech-to-text docs expose `verbose_json` with `timestamp_granularities` including `word` and `segment`, and its pricing page lists Whisper Large v3 Turbo at `$0.04/hour`. OpenAI's audio transcription API also supports `timestamp_granularities[]=word` with `verbose_json`, but `gpt-4o-mini-transcribe` is listed around `$0.003/min`, several times the Groq/Whisper Turbo price. Mistral Voxtral Mini Transcribe V2 and Qwen3-ASR are credible modern options with word timestamps, but they require new provider keys and integrations. Deepgram Nova-3 is a stronger hosted speech API with utterance/word objects and confidence, but materially more expensive.

## Dynamic Ad Duration Finding

Feed duration cannot be trusted as the render timeline. Dynamic ad insertion can make the downloaded MP3 materially longer or shorter than the RSS `itunes:duration`, depending on location and inventory. The renderer therefore probes source audio duration with ffprobe and maps removal windows against the real downloaded file.

## Conclusion

For this project, the current price/performance tradeoff with only `OPENROUTER_API_KEY` available is OpenRouter `openai/whisper-large-v3-turbo` STT over short chunks plus DeepSeek V4 Pro for text classification. OpenRouter STT does not currently provide native word timestamps through the tested endpoint, so chunking plus model-estimated boundary offsets is only an interim alignment layer. If exact cut placement is the priority, Groq direct STT is the cleaner cheap provider because its OpenAI-compatible endpoint documents `verbose_json` plus segment/word timestamp granularities at the same `$0.04/hour` turbo price. If accuracy matters more than cost, Mistral Voxtral Mini Transcribe V2 is the strongest researched candidate.
